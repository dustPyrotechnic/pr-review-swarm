import type { CandidateFinding } from './expert-runner.js';
import type { DeterministicValidationStatus } from './deterministic-evidence-validator.js';
import type { VerifierConclusion } from './verifier-client.js';

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

function groupKey(finding: CandidateFinding): string {
  return `${finding.path}|${finding.line}|${finding.category}`;
}

export function arbitrate(candidates: VerifiedCandidate[]): ArbiterResult {
  const internalDiagnostics: InternalDiagnosticEntry[] = [];
  const confirmedCandidates: VerifiedCandidate[] = [];

  for (const candidate of candidates) {
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
