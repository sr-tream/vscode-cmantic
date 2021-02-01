import * as vscode from 'vscode';
import { getMatchingSourceFile } from './extension';
import * as cfg from './configuration';
import * as util from './utility';
import { SourceDocument } from './SourceDocument';
import { CSymbol } from './CSymbol';
import { formatTextToInsert, ProposedPosition } from './ProposedPosition';


export const title = {
    currentFile: 'Add Definition in this file',
    matchingSourceFile: 'Add Definition in matching source file'
};

export const failure = {
    noActiveTextEditor: 'No active text editor detected.',
    noDocumentSymbol: 'No document symbol detected.',
    notHeaderFile: 'This file is not a header file.',
    notFunctionDeclaration: 'No function declaration detected.',
    noMatchingSourceFile: 'No matching source file was found.',
    isConstexpr: 'Constexpr functions must be defined in the file that they are declared.',
    isInline: 'Inline functions must be defined in the file that they are declared.',
    definitionExists: 'A definition for this function already exists.'
};


export async function addDefinitionInSourceFile(): Promise<void>
{
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage(failure.noActiveTextEditor);
        return;
    }

    const sourceDoc = new SourceDocument(editor.document);
    if (!sourceDoc.isHeader()) {
        vscode.window.showErrorMessage(failure.notHeaderFile);
        return;
    }

    const [matchingUri, symbol] = await Promise.all([
        getMatchingSourceFile(sourceDoc.uri),
        sourceDoc.getSymbol(editor.selection.start)
    ]);
    if (!symbol?.isFunctionDeclaration()) {
        vscode.window.showErrorMessage(failure.notFunctionDeclaration);
        return;
    } else if (!matchingUri) {
        vscode.window.showErrorMessage(failure.noMatchingSourceFile);
        return;
    } else if (symbol.isConstexpr()) {
        vscode.window.showErrorMessage(failure.isConstexpr);
        return;
    } else if (symbol.isInline()) {
        vscode.window.showErrorMessage(failure.isInline);
        return;
    }

    await addDefinition(symbol, sourceDoc, matchingUri);
}

export async function addDefinitionInCurrentFile(): Promise<void>
{
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage(failure.noActiveTextEditor);
        return;
    }

    const sourceDoc = new SourceDocument(editor.document);

    const symbol = await sourceDoc.getSymbol(editor.selection.start);
    if (!symbol?.isFunctionDeclaration()) {
        vscode.window.showErrorMessage(failure.notFunctionDeclaration);
        return;
    }

    await addDefinition(symbol, sourceDoc, sourceDoc.uri);
}

export async function addDefinition(
    functionDeclaration: CSymbol,
    declarationDoc: SourceDocument,
    targetUri: vscode.Uri
): Promise<void> {
    // Check for an existing definition. If one exists, reveal it and return.
    const existingDefinition = await functionDeclaration.findDefinition();
    if (existingDefinition) {
        const editor = await vscode.window.showTextDocument(existingDefinition.uri);
        editor.revealRange(existingDefinition.range, vscode.TextEditorRevealType.InCenter);
        return;
    }

    // Find the position for the new function definition.
    const targetDoc = (targetUri.path === declarationDoc.uri.path) ?
            declarationDoc : await SourceDocument.open(targetUri);
    const targetPosition = await declarationDoc.findPositionForFunctionDefinition(functionDeclaration, targetDoc);

    const functionSkeleton = await constructFunctionSkeleton(functionDeclaration, targetDoc, targetPosition);

    const editor = await vscode.window.showTextDocument(targetDoc.uri);
    const revealRange = new vscode.Range(targetPosition.value, targetPosition.value.translate(util.lineCount(functionSkeleton)));
    editor.revealRange(targetDoc.document.validateRange(revealRange), vscode.TextEditorRevealType.InCenter);

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.insert(targetDoc.uri, targetPosition.value, functionSkeleton);
    await vscode.workspace.applyEdit(workspaceEdit);

    const cursorPosition = targetDoc.document.validatePosition(getPositionForCursor(targetPosition, functionSkeleton));
    editor.selection = new vscode.Selection(cursorPosition, cursorPosition);
}

async function constructFunctionSkeleton(
    functionDeclaration: CSymbol,
    targetDoc: SourceDocument,
    position: ProposedPosition
): Promise<string> {
    const definition = await functionDeclaration.newFunctionDefinition(targetDoc, position.value);
    const curlyBraceFormat = cfg.functionCurlyBraceFormat(targetDoc.languageId);
    const eol = util.endOfLine(targetDoc.document);
    const indentation = util.indentation();

    let functionSkeleton: string;
    if (curlyBraceFormat === cfg.CurlyBraceFormat.NewLine
            || (curlyBraceFormat === cfg.CurlyBraceFormat.NewLineCtorDtor
            && (functionDeclaration.isConstructor() || functionDeclaration.isDestructor()))) {
        // Opening brace on new line.
        functionSkeleton = definition + eol + '{' + eol + indentation + eol + '}';
    } else {
        // Opening brace on same line.
        functionSkeleton = definition + ' {' + eol + indentation + eol + '}';
    }

    if (position.emptyScope && cfg.indentNamespaceBody() && await targetDoc.isNamespaceBodyIndented()) {
        functionSkeleton = functionSkeleton.replace(/^/gm, indentation);
    }

    return formatTextToInsert(functionSkeleton, position, targetDoc.document);
}

function getPositionForCursor(position: ProposedPosition, functionSkeleton: string): vscode.Position
{
    const lines = functionSkeleton.split('\n');
    for (let i = 0; i < lines.length; ++i) {
        if (lines[i].trimEnd().endsWith('{')) {
            return new vscode.Position(i + 1 + position.value.line, lines[i + 1].length);
        }
    }
    return new vscode.Position(0, 0);
}
