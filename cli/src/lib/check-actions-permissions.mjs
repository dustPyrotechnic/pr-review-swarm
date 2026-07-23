import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultExec(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { stdout, stderr: stderr ?? '', code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message, code: err.code ?? 1 };
  }
}

export async function checkActionsPermissions({ owner, repo, exec = defaultExec }) {
  const hint = `Actions doesn't appear to be allowed to create/approve pull requests for ${owner}/${repo} — enable it at https://github.com/${owner}/${repo}/settings/actions (under "Workflow permissions").`;

  const result = await exec('gh', ['api', `repos/${owner}/${repo}/actions/permissions`]);
  if (result.code !== 0) {
    return { ok: false, hint };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, hint };
  }

  if (parsed.can_approve_pull_request_reviews !== true) {
    return { ok: false, hint };
  }

  return { ok: true, hint: undefined };
}
