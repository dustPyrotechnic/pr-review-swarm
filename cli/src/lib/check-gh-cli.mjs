import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultExec(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { stdout, stderr: stderr ?? '', code: 0 };
  } catch (err) {
    if (err.code === 'ENOENT') throw err;
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message, code: err.code ?? 1 };
  }
}

export async function checkGhCli({ exec = defaultExec } = {}) {
  let result;
  try {
    result = await exec('gh', ['auth', 'status']);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('gh CLI not found — install it from https://cli.github.com/ and run `gh auth login` first.');
    }
    throw err;
  }

  if (result.code !== 0) {
    throw new Error('gh CLI is not logged in — run `gh auth login` first.');
  }
}
