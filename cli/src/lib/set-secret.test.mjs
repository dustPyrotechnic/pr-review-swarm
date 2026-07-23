import { describe, expect, it, vi } from 'vitest';
import { setSecret } from './set-secret.mjs';

describe('setSecret', () => {
  it('calls gh secret set with the key piped via stdin, never as a CLI argument', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await setSecret({ owner: 'octo', repo: 'repo', key: 'sk-super-secret', exec });

    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['secret', 'set', 'DEEPSEEK_API_KEY', '--repo', 'octo/repo']);
    expect(opts.input).toBe('sk-super-secret');
    // The key must not appear anywhere in the argv array itself.
    expect(args.join(' ')).not.toContain('sk-super-secret');
  });

  it('throws when gh secret set fails, without leaking the key in the error message', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'HTTP 403: Forbidden' });
    await expect(setSecret({ owner: 'octo', repo: 'repo', key: 'sk-super-secret', exec })).rejects.toThrow(
      /failed to set DEEPSEEK_API_KEY/i,
    );
    await expect(setSecret({ owner: 'octo', repo: 'repo', key: 'sk-super-secret', exec })).rejects.not.toThrow(
      /sk-super-secret/,
    );
  });

  it('throws when no key is provided at all', async () => {
    const exec = vi.fn();
    await expect(setSecret({ owner: 'octo', repo: 'repo', key: undefined, exec })).rejects.toThrow(/deepseek/i);
    expect(exec).not.toHaveBeenCalled();
  });
});
