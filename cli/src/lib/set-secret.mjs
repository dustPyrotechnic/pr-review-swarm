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

export async function setSecret({ owner, repo, key, exec = defaultExec }) {
  if (!key) {
    throw new Error('no DeepSeek API key provided — pass --deepseek-key, set DEEPSEEK_API_KEY, or answer the prompt.');
  }

  const result = await exec('gh', ['secret', 'set', 'DEEPSEEK_API_KEY', '--repo', `${owner}/${repo}`], {
    input: key,
  });

  if (result.code !== 0) {
    // Deliberately do not include result.stderr's raw text if it could echo
    // the key back (gh doesn't, but keep the error message generic anyway —
    // never assume a downstream CLI's error output is safe to print verbatim
    // when a secret was just piped into it).
    throw new Error(`failed to set DEEPSEEK_API_KEY on ${owner}/${repo} (gh exited non-zero).`);
  }
}
