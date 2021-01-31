import * as vscode from 'vscode';
import * as cfg from './configuration';
import { formatTextToInsert, ProposedPosition } from "./ProposedPosition";
import { SourceDocument } from "./SourceDocument";
import { Accessor, CSymbol, Getter, Setter } from "./CSymbol";
import { getMatchingSourceFile } from './extension';


export const title = {
    getterSetter: 'Generate \'get\' and \'set\' methods',
    getter: 'Generate \'get\' method',
    setter: 'Generate \'set\' method'
};

export const failure = {
    noActiveTextEditor: 'No active text editor detected.',
    notCpp: 'Detected language is not C++, cannot create a member function.',
    notHeaderFile: 'This file is not a header file.',
    noMemberVariable: 'No member variable detected.',
    positionNotFound: 'Could not find a position for new accessor method.',
    getterOrSetterExists: 'There already exists a \'get\' or \'set\' method.',
    getterAndSetterExists: 'There already exists \'get\' and \'set\' methods.',
    getterExists: 'There already exists a \'get\' method.',
    setterExists: 'There already exists a \'set\' method.',
    isConst: 'Const variables cannot be assigned after initialization.'
};

enum AccessorType {
    Getter,
    Setter,
    Both
}


export async function generateGetterSetter(): Promise<void>
{
    await getCurrentSymbolAndCall(generateGetterSetterFor);
}

export async function generateGetter(): Promise<void>
{
    await getCurrentSymbolAndCall(generateGetterFor);
}

export async function generateSetter(): Promise<void>
{
    await getCurrentSymbolAndCall(generateSetterFor);
}

async function getCurrentSymbolAndCall(
    callback: (symbol: CSymbol, classDoc: SourceDocument) => Promise<void>
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage(failure.noActiveTextEditor);
        return;
    }

    if (editor.document.languageId !== 'cpp') {
        vscode.window.showErrorMessage(failure.notCpp);
        return;
    }

    const sourceDoc = new SourceDocument(editor.document);
    if (!sourceDoc.isHeader()) {
        vscode.window.showErrorMessage(failure.notHeaderFile);
        return;
    }

    const symbol = await sourceDoc.getSymbol(editor.selection.start);
    if (!symbol?.isMemberVariable()) {
        vscode.window.showErrorMessage(failure.noMemberVariable);
        return;
    }

    await callback(symbol, sourceDoc);
}

export async function generateGetterSetterFor(symbol: CSymbol, classDoc: SourceDocument): Promise<void>
{
    const getter = symbol.parent?.findGetterFor(symbol);
    const setter = symbol.parent?.findSetterFor(symbol);

    if (symbol.isConst()) {
        if (getter) {
            vscode.window.showErrorMessage(failure.isConst + ' ' + failure.getterExists);
            return;
        }
        vscode.window.showInformationMessage(failure.isConst + ' Only generating \'get\' method.');
        await generateGetterFor(symbol, classDoc);
        return;
    } else if (getter && !setter) {
        vscode.window.showInformationMessage(failure.getterExists + ' Only generating \'set\' method.');
        await generateSetterFor(symbol, classDoc);
        return;
    } else if (!getter && setter) {
        vscode.window.showInformationMessage(failure.setterExists + ' Only generating \'get\' method.');
        await generateGetterFor(symbol, classDoc);
        return;
    } else if (getter && setter) {
        vscode.window.showErrorMessage(failure.getterAndSetterExists);
        return;
    }

    await findPositionAndCall(symbol, AccessorType.Both, async (position) => {
        const setterPosition: ProposedPosition = {
            value: position.value,
            after: true,
            nextTo: true
        };

        const workspaceEdit = new vscode.WorkspaceEdit();
        await addNewAccessorToWorkspaceEdit(new Getter(symbol), position, classDoc, workspaceEdit);
        await addNewAccessorToWorkspaceEdit(new Setter(symbol), setterPosition, classDoc, workspaceEdit);
        await vscode.workspace.applyEdit(workspaceEdit);
    });
}

export async function generateGetterFor(symbol: CSymbol, classDoc: SourceDocument): Promise<void>
{
    const getter = symbol.parent?.findGetterFor(symbol);
    if (getter) {
        vscode.window.showInformationMessage(failure.getterExists);
        return;
    }

    await findPositionAndCall(symbol, AccessorType.Getter, async (position) => {
        const workspaceEdit = new vscode.WorkspaceEdit();
        await addNewAccessorToWorkspaceEdit(new Getter(symbol), position, classDoc, workspaceEdit);
        await vscode.workspace.applyEdit(workspaceEdit);
    });
}

export async function generateSetterFor(symbol: CSymbol, classDoc: SourceDocument): Promise<void>
{
    if (symbol.isConst()) {
        vscode.window.showErrorMessage(failure.isConst);
        return;
    }

    const setter = symbol.parent?.findSetterFor(symbol);
    if (setter) {
        vscode.window.showInformationMessage(failure.setterExists);
        return;
    }

    await findPositionAndCall(symbol, AccessorType.Setter, async (position) => {
        const workspaceEdit = new vscode.WorkspaceEdit();
        await addNewAccessorToWorkspaceEdit(new Setter(symbol), position, classDoc, workspaceEdit);
        await vscode.workspace.applyEdit(workspaceEdit);
    });
}

async function findPositionAndCall(
    symbol: CSymbol,
    type: AccessorType,
    callback: (position: ProposedPosition) => Promise<void>
): Promise<void> {
    // If the new method is a getter, then we want to place it relative to the setter, and vice-versa.
    let position: ProposedPosition | undefined;
    switch (type) {
    case AccessorType.Getter:
        position = symbol.parent?.findPositionForNewMethod(symbol.setterName(), symbol);
        break;
    case AccessorType.Setter:
        position = symbol.parent?.findPositionForNewMethod(symbol.getterName(), symbol);
        break;
    case AccessorType.Both:
        position = symbol.parent?.findPositionForNewMethod();
        break;
    }

    if (!position) {
        vscode.window.showErrorMessage(failure.positionNotFound);
        return;
    }

    await callback(position);
}

async function addNewAccessorToWorkspaceEdit(
    newAccessor: Accessor,
    methodPosition: ProposedPosition,
    classDoc: SourceDocument,
    workspaceEdit: vscode.WorkspaceEdit
): Promise<void> {
    const target = await getTargetForAccessorDefinition(newAccessor, methodPosition, classDoc);

    if (target.position === methodPosition && target.sourceDoc === classDoc) {
        const inlineDefinition = newAccessor.declaration + ' { ' + newAccessor.body + ' }';
        const formattedInlineDefinition = formatTextToInsert(inlineDefinition, methodPosition, classDoc.document);

        workspaceEdit.insert(classDoc.uri, methodPosition.value, formattedInlineDefinition);
    } else {
        const formattedDeclaration = formatTextToInsert(newAccessor.declaration + ';', methodPosition, classDoc.document);
        const definition = await newAccessor.definition(
                target.sourceDoc,
                target.position.value,
                cfg.functionCurlyBraceFormat(target.sourceDoc.languageId) === cfg.CurlyBraceFormat.NewLine);
        const formattedDefinition = formatTextToInsert(definition, target.position, target.sourceDoc.document);

        workspaceEdit.insert(classDoc.uri, methodPosition.value, formattedDeclaration);
        workspaceEdit.insert(target.sourceDoc.uri, target.position.value, formattedDefinition);
    }
}

async function getTargetForAccessorDefinition(
    accessor: Accessor,
    declarationPosition: ProposedPosition,
    classDoc: SourceDocument
): Promise<{ position: ProposedPosition; sourceDoc: SourceDocument }> {
    const accessorDefinitionLocation = (accessor instanceof Getter) ?
            cfg.getterDefinitionLocation() : cfg.setterDefinitionLocation();

    switch (accessorDefinitionLocation) {
    case cfg.AccessorDefinitionLocation.Inline:
        return { position: declarationPosition, sourceDoc: classDoc };
    case cfg.AccessorDefinitionLocation.BelowClass:
        return {
            position: await classDoc.findPositionForFunctionDefinition(declarationPosition, classDoc),
            sourceDoc: classDoc
        };
    case cfg.AccessorDefinitionLocation.SourceFile:
        const matchingUri = await getMatchingSourceFile(classDoc.uri);
        const targetDoc = matchingUri ? await SourceDocument.open(matchingUri) : classDoc;
        return {
            position: await classDoc.findPositionForFunctionDefinition(declarationPosition, targetDoc),
            sourceDoc: targetDoc
        };
    }
}
