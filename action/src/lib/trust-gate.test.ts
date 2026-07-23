import { describe, expect, it } from 'vitest';
import { evaluateTrustGate } from './trust-gate.js';
import type { RepoConfig } from './repo-config.js';

const baseRepoConfig: RepoConfig = {
  enabled: true,
  trusted_users: [],
  ignore_globs: [],
  generated_globs: [],
};

describe('evaluateTrustGate', () => {
  it('allows workflow_dispatch regardless of author association', () => {
    const decision = evaluateTrustGate({
      eventName: 'workflow_dispatch',
      authorAssociation: 'NONE',
      senderLogin: 'random-user',
      repoConfig: baseRepoConfig,
    });

    expect(decision).toEqual({ allowed: true, reason: 'workflow_dispatch' });
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
    'allows %s author association on non-dispatch events',
    (authorAssociation) => {
      const decision = evaluateTrustGate({
        eventName: 'pull_request_target',
        authorAssociation,
        senderLogin: 'random-user',
        repoConfig: baseRepoConfig,
      });

      expect(decision).toEqual({ allowed: true, reason: 'author_association' });
    },
  );

  it('allows a sender in the repo config trusted_users whitelist', () => {
    const decision = evaluateTrustGate({
      eventName: 'pull_request_target',
      authorAssociation: 'NONE',
      senderLogin: 'trusted-outsider',
      repoConfig: { ...baseRepoConfig, trusted_users: ['trusted-outsider'] },
    });

    expect(decision).toEqual({ allowed: true, reason: 'trusted_whitelist' });
  });

  it('rejects when author association is untrusted and sender is not whitelisted', () => {
    const decision = evaluateTrustGate({
      eventName: 'pull_request_target',
      authorAssociation: 'NONE',
      senderLogin: 'random-user',
      repoConfig: baseRepoConfig,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: 'author_association_and_whitelist_miss',
    });
  });

  it('rejects CONTRIBUTOR association when not whitelisted (only OWNER/MEMBER/COLLABORATOR are trusted)', () => {
    const decision = evaluateTrustGate({
      eventName: 'pull_request_target',
      authorAssociation: 'CONTRIBUTOR',
      senderLogin: 'random-user',
      repoConfig: baseRepoConfig,
    });

    expect(decision.allowed).toBe(false);
  });

  it('allows anyone when repoConfig.trust_all_prs is true, even with untrusted association and no whitelist entry', () => {
    const decision = evaluateTrustGate({
      eventName: 'pull_request_target',
      authorAssociation: 'NONE',
      senderLogin: 'random-user',
      repoConfig: { ...baseRepoConfig, trust_all_prs: true },
    });

    expect(decision).toEqual({ allowed: true, reason: 'trust_all_prs' });
  });

  it('still enforces the normal checks when trust_all_prs is explicitly false', () => {
    const decision = evaluateTrustGate({
      eventName: 'pull_request_target',
      authorAssociation: 'NONE',
      senderLogin: 'random-user',
      repoConfig: { ...baseRepoConfig, trust_all_prs: false },
    });

    expect(decision.allowed).toBe(false);
  });
});
