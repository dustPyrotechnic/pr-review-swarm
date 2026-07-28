import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CENTRAL_REPO = 'dustPyrotechnic/pr-review-swarm';

/** Moving major tag the central repo re-points on every release. */
export const DEFAULT_REF = 'v1';

async function defaultExec(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args);
    return { stdout, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message, code: err.code ?? 1 };
  }
}

export async function resolveRef({ pinSha = false, exec = defaultExec } = {}) {
  if (!pinSha) return { ref: DEFAULT_REF, mode: 'tag' };

  const result = await exec('gh', ['api', `repos/${CENTRAL_REPO}/commits/${DEFAULT_REF}`, '--jq', '.sha']);
  if (result.code !== 0) {
    throw new Error(
      `could not resolve the ${DEFAULT_REF} tag of ${CENTRAL_REPO}: ${(result.stderr ?? '').trim() || 'gh exited non-zero'}`,
    );
  }

  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`expected a 40-character commit SHA for ${CENTRAL_REPO}@${DEFAULT_REF}, got: ${sha || '(empty)'}`);
  }

  return { ref: sha, mode: 'sha' };
}
