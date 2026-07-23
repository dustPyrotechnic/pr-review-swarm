import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultExec(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return { stdout, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message, code: err.code ?? 1 };
  }
}

export function parseOwnerRepo(remoteUrl) {
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  const sshMatch = /^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remoteUrl.trim());
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  return undefined;
}

export async function detectRepo({ exec = defaultExec } = {}) {
  const result = await exec('git', ['remote', 'get-url', 'origin']);
  if (result.code !== 0) {
    throw new Error(
      'not a git repository (or no "origin" remote) — run this inside the target repo, with a GitHub "origin" remote configured.',
    );
  }

  const parsed = parseOwnerRepo(result.stdout);
  if (!parsed) {
    throw new Error(`origin remote is not a GitHub URL: ${result.stdout.trim()}`);
  }

  return parsed;
}
