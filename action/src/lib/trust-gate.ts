import type { RepoConfig } from './repo-config.js';

export type TrustDecision =
  | { allowed: true; reason: 'workflow_dispatch' | 'author_association' | 'trusted_whitelist' | 'trust_all_prs' }
  | { allowed: false; reason: 'author_association_and_whitelist_miss' };

const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function evaluateTrustGate(input: {
  eventName: string;
  authorAssociation: string;
  senderLogin: string;
  repoConfig: RepoConfig;
}): TrustDecision {
  if (input.eventName === 'workflow_dispatch') {
    return { allowed: true, reason: 'workflow_dispatch' };
  }

  // Opt-in escape hatch (repo-config `trust_all_prs: true`): every PR gets a
  // real review regardless of author association or whitelist membership.
  // Still safe under the existing security model — analyze never holds
  // write/DeepSeek-adjacent GitHub credentials and PR head code is never
  // checked out or executed — this only widens *whose diffs get analyzed*,
  // not what the bot is able to do with the result.
  if (input.repoConfig.trust_all_prs) {
    return { allowed: true, reason: 'trust_all_prs' };
  }

  if (TRUSTED_AUTHOR_ASSOCIATIONS.has(input.authorAssociation)) {
    return { allowed: true, reason: 'author_association' };
  }

  if (input.repoConfig.trusted_users.includes(input.senderLogin)) {
    return { allowed: true, reason: 'trusted_whitelist' };
  }

  return { allowed: false, reason: 'author_association_and_whitelist_miss' };
}
