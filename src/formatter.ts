import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import * as vscode from 'vscode';
import { FormatError, isErrnoException } from './error';

function createWorker(currentWorkspace: vscode.WorkspaceFolder) {
  let config = vscode.workspace.getConfiguration('perltidy-more');

  var executable = config.get('executable', '');
  let profile = config.get('profile', '');

  let args: string[] = [
    "--standard-output",
    // Terminal newline causes a problem when formatting selection.
    // We cannot determine whether the terminal newline is from original code, or appended by perltidy.
    // With terminal newline: "foo\n" -> "foo\n", "foo" -> "foo\n"
    // Expected result:       "foo\n" -> "foo\n", "foo" -> "foo"
    "-no-add-terminal-newline",
  ];

  if (profile) {
    args.push("--profile=" + profile);
  }

  let options = {
    cwd: currentWorkspace.uri.fsPath
  };

  // Support for spawn at virtual filesystems
  if (currentWorkspace.uri.scheme != "file") {
    options.cwd = ".";
  }

  // Support for executing relative path script from the current workspace. eg: ./script/perltidy-wrapper.pl
  if (!isAbsolute(executable)) {
    let resolved = join(currentWorkspace.uri.path, executable)

    if (existsSync(resolved)) {
      executable = resolved;

      // Also we change cwd to support for local .perltidyrc in case of run it
      // in docker image (may be cwd will be set to workspace folder for all
      // cases)
      options.cwd = currentWorkspace.uri.path;
    }
  }
  return {
    worker: spawn(executable, args, options),
    executable,
  };
}

export class Formatter {
  constructor() {}
  /**
   * format text by perltidy.
   * @param document Documents containing text 
   * @param range Range of text
   * @returns Returns the formatted text. However, Returns `undefined` if formatting is skipped.
   * @throws {import('./error').FormatError} Throw an error if failed to format.
   * @throws {unknown} Throw an error an unexpected problem has occurred.
   */
  async format (document: vscode.TextDocument, range: vscode.Range): Promise<string | undefined> {
    let text = document.getText(range);
    if (!text || text.length === 0) return new Promise((resolve) => { resolve('') });

    const currentWorkspace = vscode.workspace.getWorkspaceFolder(
      document.uri
    )

    if (currentWorkspace === undefined) {
      throw new FormatError('Format failed. File must be belong to one workspace at least.');
    }

    let config = vscode.workspace.getConfiguration('perltidy-more');
    if (config.get('autoDisable', false)) {
      if (!existsSync(join(currentWorkspace.uri.path, '.perltidyrc'))) {
        return Promise.resolve(undefined);
      }
    }

    const { worker, executable } = createWorker(currentWorkspace);

    return new Promise((resolve, reject) => {
      try {

        worker.stdin.write(text);
        worker.stdin.end();

        let result_text = '';
        let error_text = '';

        worker.on('error', (e) => {
          // When the process fails to start, terminate, or send a message to the process
          // ref: https://nodejs.org/api/child_process.html#child_process_event_error
          if (isErrnoException(e) && e.code === 'ENOENT') {
            if (executable === 'perltidy') {
              reject(new FormatError(`Format failed. Executable file (\`${executable}\`) is not found. You probably forgot to install perltidy.`));
            } else {
              reject(new FormatError(`Format failed. Executable file (\`${executable}\`) is not found.`));
            }
          } else {
            reject(e);
          }
        });

        worker.stdout.on('data', (chunk) => {
          result_text += chunk;
        });
        worker.stderr.on('data', (chunk) => {
          error_text += chunk;
        });

        worker.on('close', (code) => {
          if (code !== 0) {
            // ref: http://perltidy.sourceforge.net/perltidy.html#ERROR-HANDLING
            if (error_text === '') {
              reject(new FormatError(`Format failed. Perltidy exited with exit code ${code}.`));
            } else {
              reject(new FormatError(`Format failed. Perltidy exited with exit code ${code}. Error messages: ${error_text}`));
            }
          } else {
            resolve(result_text);
          }
        });
      }
      catch (error) {
        // internal error
        reject(error);
      }
    });
  }
}