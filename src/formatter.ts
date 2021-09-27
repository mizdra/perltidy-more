import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import * as vscode from 'vscode';
import { FormatError, isErrnoException } from './error';

function createWorker(workspace: vscode.WorkspaceFolder) {
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
    cwd: workspace.uri.fsPath
  };

  // Support for spawn at virtual filesystems
  if (workspace.uri.scheme != "file") {
    options.cwd = ".";
  }

  // Support for executing relative path script from the current workspace. eg: ./script/perltidy-wrapper.pl
  if (!isAbsolute(executable)) {
    let resolved = join(workspace.uri.path, executable)

    if (existsSync(resolved)) {
      executable = resolved;

      // Also we change cwd to support for local .perltidyrc in case of run it
      // in docker image (may be cwd will be set to workspace folder for all
      // cases)
      options.cwd = workspace.uri.path;
    }
  }
  return {
    worker: spawn(executable, args, options),
    executable,
  };
}

function isFormatEnabled(workspace: vscode.WorkspaceFolder): boolean {
  let config = vscode.workspace.getConfiguration('perltidy-more');
  if (config.get('autoDisable', false)) {
    if (!existsSync(join(workspace.uri.path, '.perltidyrc'))) {
      return false;
    }
  }
  return true;
}

export class Formatter {
  workerCacheMap: Map<vscode.WorkspaceFolder, { worker: ChildProcessWithoutNullStreams, executable: string }>;
  
  constructor() {
    this.workerCacheMap = new Map();
  }

  /**
   * Start the perltidy process and keep it waiting.
   * @param workspace Workspace containing the open file.
   * @returns Returns a worker wrapping the perltidy process and path of the executable file.
   */
  async standBy (workspace: vscode.WorkspaceFolder | undefined) {
    if (workspace === undefined) throw new FormatError('Format failed. File must be belong to one workspace at least.');
    if (!isFormatEnabled(workspace)) throw new FormatError('Format failed. File must be belong to one workspace at least.');

    const result = this.workerCacheMap.get(workspace);
    if (result) {
      // If the process is already in standby, return it.
      return result;
    } else {
      // If the process is not yet in standby, create process
      const result = createWorker(workspace);
      this.workerCacheMap.set(workspace, result);
      return result;
    }
  }

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
    );

    const { worker, executable } = await this.standBy(currentWorkspace);

    return new Promise((resolve, reject) => {
      try {

        worker.stdin.write(text);
        worker.stdin.end();

        let result_text = '';
        let error_text = '';

        worker.on('error', (e) => {
          this.workerCacheMap.delete(currentWorkspace!);
          this.standBy(currentWorkspace!);
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
          this.workerCacheMap.delete(currentWorkspace!);
          this.standBy(currentWorkspace!);
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
        this.workerCacheMap.delete(currentWorkspace!);
        this.standBy(currentWorkspace!);
        // internal error
        reject(error);
      }
    });
  }
}