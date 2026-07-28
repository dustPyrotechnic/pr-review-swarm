import { spawn } from 'node:child_process';

async function defaultExec(cmd, args, { input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Scrub the key out of an error before it escapes this module.
 *
 * The non-zero-exit path below already refuses to echo gh's stderr, on the
 * principle that a downstream CLI's output isn't safe to print verbatim right
 * after a secret was piped into it. The same holds for a *thrown* error: a
 * spawn/EPIPE failure, or any wrapping exec implementation, can carry the
 * piped input in its message or stack. Scrub rather than discard, so the
 * underlying cause stays debuggable.
 */
function scrubKey(err, key) {
  const original = err instanceof Error ? err : new Error(String(err));
  if (!key || !original.message.includes(key)) return original;

  const scrubbed = new Error(original.message.split(key).join('[REDACTED:deepseek-api-key]'));
  if (original.stack) scrubbed.stack = original.stack.split(key).join('[REDACTED:deepseek-api-key]');
  return scrubbed;
}

export async function setSecret({ owner, repo, key, exec = defaultExec }) {
  if (!key) {
    throw new Error('no DeepSeek API key provided — pass --deepseek-key, set DEEPSEEK_API_KEY, or answer the prompt.');
  }

  let result;
  try {
    result = await exec('gh', ['secret', 'set', 'DEEPSEEK_API_KEY', '--repo', `${owner}/${repo}`], {
      input: key,
    });
  } catch (err) {
    throw scrubKey(err, key);
  }

  if (result.code !== 0) {
    // Deliberately do not include result.stderr's raw text if it could echo
    // the key back (gh doesn't, but keep the error message generic anyway —
    // never assume a downstream CLI's error output is safe to print verbatim
    // when a secret was just piped into it).
    throw new Error(`failed to set DEEPSEEK_API_KEY on ${owner}/${repo} (gh exited non-zero).`);
  }
}
