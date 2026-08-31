import type { CandidateFinding } from './expert-runner.js';
import type { DeterministicValidationStatus } from './deterministic-evidence-validator.js';
import type { VerifierConclusion } from './verifier-client.js';
import { isSelfRefuting } from './self-refutation-gate.js';

export interface Finding extends CandidateFinding {
  evidence_validation: { status: 'passed'; notes?: string };
  verifier_conclusion: {
    status: 'confirmed';
    notes?: string;
    evidence_refs?: Array<{ path: string; line: number }>;
  };
}

export interface VerifiedCandidate {
  finding: CandidateFinding;
  deterministicStatus: DeterministicValidationStatus;
  deterministicReason?: string;
  verifierConclusion?: VerifierConclusion;
}

export type InternalDiagnosticOutcome =
  | 'confirmed'
  | 'merged_into'
  | 'rejected_deterministic'
  | 'rejected_self_refuted'
  | 'rejected_verifier';

export interface InternalDiagnosticEntry {
  id: string;
  path: string;
  line: number;
  outcome: InternalDiagnosticOutcome;
  mergedIntoId?: string;
  reason?: string;
}

export interface ArbiterResult {
  findings: Finding[];
  internalDiagnostics: InternalDiagnosticEntry[];
}

// Deliberately excludes `category`. It is `{"type":"string","minLength":1}` in
// candidate-finding.schema.json — free text — and the design doc (L139) states
// that severity/confidence/category are "仅用于排序、呈现和统计，不决定是否阻塞".
// Keying dedup on a field the model rewords every run is the same as not
// deduplicating at all.
//
// Measured in the 2026-08-13 full evaluation: the model reported
// "hardcoded credential" and "hardcoded-credential" on the same line — one
// hyphen apart, two separate findings. pool.go:15 collected four wordings
// (concurrency / concurrency-race / unbounded-goroutines /
// unnecessary-complexity). The user-visible result is several inline comments
// stacked on one line, which is this product's most irritating failure mode.
//
// The cost is that two genuinely distinct problems on the same line collapse
// into one. That trade is intentional: one line carrying two independent
// defects is far rarer than wording drift, and the merged-away entry still
// appears in internalDiagnostics with mergedIntoId — it is not silently lost.
function groupKey(finding: CandidateFinding): string {
  return `${finding.path}|${finding.line}`;
}

export function arbitrate(candidates: VerifiedCandidate[]): ArbiterResult {
  const internalDiagnostics: InternalDiagnosticEntry[] = [];
  const confirmedCandidates: VerifiedCandidate[] = [];

  for (const candidate of candidates) {
    // 排在 deterministic / verifier 两道之前：一条自己论证了「不构成缺陷」的
    // finding，无论锚点多合法、verifier 多确信，都不该发出去。verifier 拦不住它
    // ——「描述属实」和「要求对方改」是两回事，而 verifier 被问的是前者。
    if (isSelfRefuting(candidate.finding)) {
      internalDiagnostics.push({
        id: candidate.finding.id,
        path: candidate.finding.path,
        line: candidate.finding.line,
        outcome: 'rejected_self_refuted',
        reason: 'finding text concludes there is no defect / suggestion is a no-op',
      });
      continue;
    }

    if (candidate.deterministicStatus === 'failed') {
      internalDiagnostics.push({
        id: candidate.finding.id,
        path: candidate.finding.path,
        line: candidate.finding.line,
        outcome: 'rejected_deterministic',
        reason: candidate.deterministicReason,
      });
      continue;
    }

    if (candidate.verifierConclusion?.status !== 'confirmed') {
      internalDiagnostics.push({
        id: candidate.finding.id,
        path: candidate.finding.path,
        line: candidate.finding.line,
        outcome: 'rejected_verifier',
        reason: candidate.verifierConclusion?.notes,
      });
      continue;
    }

    confirmedCandidates.push(candidate);
  }

  const groups = new Map<string, VerifiedCandidate[]>();
  for (const candidate of confirmedCandidates) {
    const key = groupKey(candidate.finding);
    const group = groups.get(key);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  }

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const [representative, ...rest] = group;
    if (!representative) continue;

    const verifierConclusion = representative.verifierConclusion;
    const finding: Finding = {
      ...representative.finding,
      evidence_validation: { status: 'passed' },
      verifier_conclusion: {
        status: 'confirmed',
        ...(verifierConclusion?.notes ? { notes: verifierConclusion.notes } : {}),
        ...(verifierConclusion?.evidence_refs ? { evidence_refs: verifierConclusion.evidence_refs } : {}),
      },
    };
    findings.push(finding);

    internalDiagnostics.push({
      id: representative.finding.id,
      path: representative.finding.path,
      line: representative.finding.line,
      outcome: 'confirmed',
    });

    for (const merged of rest) {
      internalDiagnostics.push({
        id: merged.finding.id,
        path: merged.finding.path,
        line: merged.finding.line,
        outcome: 'merged_into',
        mergedIntoId: representative.finding.id,
      });
    }
  }

  return { findings, internalDiagnostics };
}
