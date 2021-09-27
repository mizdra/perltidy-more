'use strict';

import * as vscode from 'vscode';
import { handleTidyError } from './error';
import { Formatter } from './formatter';

export function activate(context: vscode.ExtensionContext) {
  const formatter = new Formatter();
  const selector = ['perl', 'perl+mojolicious'];
  function get_range(document: vscode.TextDocument, range: vscode.Range | null, selection: vscode.Selection | null) {
    if (!(selection === null) && !selection.isEmpty) {
      range = new vscode.Range(selection.start, selection.end);
    }

    if (range === null) {
      let start = new vscode.Position(0, 0);
      let end = new vscode.Position(document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
      range = new vscode.Range(start, end);
    }

    return range;
  }

  let provider = vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
    provideDocumentRangeFormattingEdits: async (document, range, options, token) => {
      // To keep indent level, expand the range to include the beginning of the line.
      // "  [do {]" -> "[  do {]"
      //
      // Don't expand if there is a non-whitespace character between the beginning of the line and the range
      // "return [do {]" -> "return [do {]"
      const indentRange = new vscode.Range(new vscode.Position(range.start.line, 0), range.start);
      if (document.getText(indentRange).match(/^\s*$/)) {
        range = new vscode.Range(new vscode.Position(range.start.line, 0), range.end);
      }

      range = get_range(document, range, null);

      try {
        let res = await formatter.format(document, range);
        if (res === undefined) return;
        let result: vscode.TextEdit[] = [];
        result.push(new vscode.TextEdit(range, res));
        return result;
      } catch (e) {
        handleTidyError(e);
        return;
      }
    }
  });

  let formatOnTypeProvider = vscode.languages.registerOnTypeFormattingEditProvider(selector, {
    provideOnTypeFormattingEdits: async (document, position, ch, options, token) => {
        // Determine start position. start format from the next line of the previous ';'.
        let start = new vscode.Position(0, 0);
        let lineNumber = position.line - 1;
        while (lineNumber >= 0) {
          const line = document.lineAt(lineNumber);
          const indexOfSemicolon = line.text.lastIndexOf(';');
          if (indexOfSemicolon >= 0) {
            start = new vscode.Position(lineNumber + 1, 0);
            break;
          }
          lineNumber--;
        }
        const range = new vscode.Range(start, position);

      try {
        const res = await formatter.format(document, range);
        if (res === undefined || token.isCancellationRequested) {
          return;
        }
        const result: vscode.TextEdit[] = [];
        result.push(new vscode.TextEdit(range, res));
        return result;
      } catch (e) {
        handleTidyError(e);
        return;
      }
    }
  }, ';', '}', ')', ']');

  let command = vscode.commands.registerCommand('perltidy-more.tidy', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    let document = editor.document;
    let selection = editor.selection;

    let range = get_range(document, null, selection);

    try {
      const res = await formatter.format(document, range);
      if (res === undefined) return;
      editor.edit((builder: vscode.TextEditorEdit) => {
        builder.replace(range, res);
      });
    } catch (e) {
      handleTidyError(e);
      return;
    }
  });

  context.subscriptions.push(provider);
  context.subscriptions.push(formatOnTypeProvider);
  context.subscriptions.push(command);
}
