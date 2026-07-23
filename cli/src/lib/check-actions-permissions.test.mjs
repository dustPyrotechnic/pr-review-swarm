import { describe, expect, it, vi } from 'vitest';
import { checkActionsPermissions } from './check-actions-permissions.mjs';

describe('checkActionsPermissions', () => {
  it('reports ok when Actions can create/approve PRs', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ can_approve_pull_request_reviews: true }),
      stderr: '',
    });
    const result = await checkActionsPermissions({ owner: 'octo', repo: 'repo', exec });
    expect(result.ok).toBe(true);
  });

  it('reports not ok with a settings-page hint when Actions cannot create/approve PRs', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ can_approve_pull_request_reviews: false }),
      stderr: '',
    });
    const result = await checkActionsPermissions({ owner: 'octo', repo: 'repo', exec });
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/settings\/actions/);
  });

  it('reports not ok without throwing when the API call itself fails (e.g. insufficient token scope)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'HTTP 403' });
    const result = await checkActionsPermissions({ owner: 'octo', repo: 'repo', exec });
    expect(result.ok).toBe(false);
  });
});
