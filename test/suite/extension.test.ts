import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as parse from '../../src/parsing';
import SourceDocument from '../../src/SourceDocument';
import SourceSymbol from '../../src/SourceSymbol';
import CSymbol from '../../src/CSymbol';
import { CodeActionProvider } from '../../src/codeActions';
import { commands, cpptoolsId } from '../../src/extension';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(() => resolve(), ms));

function getClass(symbols: SourceSymbol[]): SourceSymbol {
    for (const documentSymbol of symbols) {
        if (documentSymbol.kind === vscode.SymbolKind.Class) {
            return documentSymbol;
        }
    }
    throw new Error('Class not found.');
}

suite('Extension Test Suite', function () {
    this.timeout(30000);

    const rootPath = path.resolve(__dirname, '..', '..', '..');

    const packageJsonPath = path.join(rootPath, 'package.json');
    const packageJson = fs.readFileSync(packageJsonPath, { encoding: 'utf8', flag: 'r' });

	const testFilePath = path.join(rootPath, 'test', 'workspace', 'include', 'derived.h');
    const testFileUri = vscode.Uri.file(testFilePath);

    const codeActionProvider = new CodeActionProvider();

    suiteSetup(async () => {
        const cpptools = vscode.extensions.getExtension(cpptoolsId);
        assert(cpptools);
        if (!cpptools.isActive) {
            await cpptools.activate();
        }
        await vscode.commands.executeCommand('vscode.open', testFileUri);
    });

    test('Test CodeActionProvider', async () => {
        const editor = vscode.window.activeTextEditor;
        assert(editor);

        const sourceDoc = new SourceDocument(editor.document);

        // Wait until the language server is initialized (the test will timeout after 30s).
        do {
            await wait(1000);
            await sourceDoc.executeSourceSymbolProvider();
        } while (!sourceDoc.symbols);

        const testClass = getClass(sourceDoc.symbols);
        assert(testClass.children.length > 0);

        for (const child of testClass.children) {
            const codeActions = await codeActionProvider.provideCodeActions(
                    sourceDoc, child.selectionRange, { diagnostics: [] });
            assert(codeActions.length > 0);

            const member = new CSymbol(child, sourceDoc);
            if (member.isFunctionDeclaration()) {
                if (member.isConstructor()) {
                    assert.match(codeActions[0].title, /^Generate Constructor/);
                } else {
                    assert.match(codeActions[0].title, /^Add Definition/);
                }
                assert.strictEqual(codeActions.length, 5);
            } else if (member.isFunctionDefinition()) {
                assert.match(codeActions[0].title, /^Add Declaration/);
                assert.match(codeActions[1].title, /^Move Definition/);
                assert.strictEqual(codeActions.length, 6);
            } else if (member.isMemberVariable()) {
                assert.match(codeActions[0].title, /^Generate Getter/);
                assert.strictEqual(codeActions.length, 6);
            }
        }
    });

    test('Test Parsing Functions', () => {
        /* Since we depend on the specific error message thrown from XRegExp.matchRecursive() in
         * order to mask unbalanced delimiters, we meed to test wether the error message has
         * changed in new versions. If the error message has changed then these functions will
         * throw and fail the test. */

        const parentheses = parse.maskParentheses('(foo))');
        assert.strictEqual(parentheses, '(   ) ');

        const braces = parse.maskBraces('{foo}}');
        assert.strictEqual(braces, '{   } ');

        const brackets = parse.maskBrackets('[foo]]');
        assert.strictEqual(brackets, '[   ] ');

        const angleBrackets = parse.maskAngleBrackets('<foo>>');
        assert.strictEqual(angleBrackets, '<   > ');
    });

    interface ContributedCommand { command: string; title: string }

    test('Test Registered Commands', () => {
        const contributedCommands = JSON.parse(packageJson).contributes.commands;
        assert(contributedCommands instanceof Array);

        contributedCommands.forEach((contributedCommand: ContributedCommand) => {
            assert(
                Object.keys(commands).some(command => command === contributedCommand.command),
                `Add '${contributedCommand.command}' to commands in 'src/extension.ts' so that it gets registered.`
            );
        });
    });
});
