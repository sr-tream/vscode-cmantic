import * as vscode from 'vscode';
import { getMatchingHeaderSource, logger, activeLanguageServer, LanguageServer } from '../extension';


export async function switchHeaderSourceInWorkspace(): Promise<boolean | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logger.alertError('No active text editor detected.');
        return;
    }

    const matchingUri = await getMatchingHeaderSource(editor.document.uri);
    if (!matchingUri) {
        if (activeLanguageServer() === LanguageServer.cpptools) {
            vscode.commands.executeCommand('C_Cpp.SwitchHeaderSource');
        } else if (activeLanguageServer() === LanguageServer.clangd) {
            vscode.commands.executeCommand('clangd.switchheadersource');
        } else {
            logger.alertInformation('No matching header/source file was found.');
            return false;
        }
        logger.logInfo('No matching header/source file was found.');
        return true;
    }

    await vscode.window.showTextDocument(matchingUri);
    return true;
}
