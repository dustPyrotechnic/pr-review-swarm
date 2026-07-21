import type { RepoConfig } from './repo-config.js';

export type TrustDecision =
  | { allowed: true; reason: 'workflow_dispatch' | 'author_association' | 'trusted_whitelist' }
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

  if (TRUSTED_AUTHOR_ASSOCIATIONS.has(input.authorAssociation)) {
    return { allowed: true, reason: 'author_association' };
  }

  if (input.repoConfig.trusted_users.includes(input.senderLogin)) {
    return { allowed: true, reason: 'trusted_whitelist' };
  }

  return { allowed: false, reason: 'author_association_and_whitelist_miss' };
}
