import { createHash } from 'node:crypto';
import type { Finding } from './arbiter.js';
import type { SchemaIdentityTuple } from './identity-tuple.js';

export interface ReviewSetIdInput {
  identityTuple: SchemaIdentityTuple;
  engineRevision: string;
  policyRevision: string;
  model: string;
  schemaVersion: string;
  findings: Finding[];
}

export function computeFindingsDigest(findings: Finding[]): string {
  const sortedIds = findings.map((f) => f.id).sort();
  return createHash('sha256').update(JSON.stringify(sortedIds)).digest('hex').slice(0, 16);
}

// Unlike computeFindingsDigest (id-based, used for cheap per-batch publish
// reconciliation), review_set_id must change whenever finding *content*
// changes even if ids happen to repeat across runs, so it hashes full
// finding objects rather than just ids.
function computeFullContentDigest(findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export function computeReviewSetId(input: ReviewSetIdInput): string {
  const payload = {
    identity_tuple: input.identityTuple,
    engine_revision: input.engineRevision,
    policy_revision: input.policyRevision,
    model: input.model,
    schema_version: input.schemaVersion,
    findings_content_digest: computeFullContentDigest(input.findings),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 20);
}
