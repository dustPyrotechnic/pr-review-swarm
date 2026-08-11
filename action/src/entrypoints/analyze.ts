import { writeFileSync } from 'node:fs';
import * as core from '@actions/core';
import centralLimits from '../../config/central-limits.json' with { type: 'json' };
import { assertModelAllowed } from '../lib/model-allowlist.js';
import { createDeepSeekClient } from '../lib/deepseek-client.js';
import {
  parseIndex,
  loadSkill,
  readIndexMd,
  matchTriggeredSkills,
  validateSkillRequests,
  type SkillIndexEntry,
  type LoadedSkill,
} from '../lib/skill-loader.js';
import { runExpert, type CandidateFinding, type ExpertClient } from '../lib/expert-runner.js';
import { validateDeterministicEvidence } from '../lib/deterministic-evidence-validator.js';
import {
  verifyFinding,
  VerifierUnavailableError,
  type VerifierClient,
} from '../lib/verifier-client.js';
import { arbitrate, type Finding, type InternalDiagnosticEntry, type VerifiedCandidate } from '../lib/arbiter.js';
import type { DiffHunk } from '../lib/diff-parser.js';
import type { PrepareArtifact, PrepareShard, CoverageManifest } from './prepare.js';
import { readRequiredArtifact, type ReadArtifactOptions } from '../lib/artifact-reader.js';

export function readPrepareArtifactFromFile(
  filePath: string,
  options?: ReadArtifactOptions,
): PrepareArtifact {
  return readRequiredArtifact<PrepareArtifact>({
    label: 'prepare-artifact',
    filePath,
    schemaId: 'https://pr-review-swarm/schemas/prepare-artifact.schema.json',
    ...(options ? { options } : {}),
  });
}

export interface AnalyzeArtifact {
  findings: Finding[];
  coverage_manifest: CoverageManifest;
}

export function writeAnalyzeArtifactToFile(artifact: AnalyzeArtifact, filePath: string): void {
  writeFileSync(filePath, JSON.stringify(artifact));
}

const AGENT_NAMES = ['generic-correctness', 'generic-security', 'generic-maintainability'] as const;

export interface AnalyzeLimits {
  maxCandidateFindingsPerAgentPerShard: number;
  maxSkillRequestsPerRun: number;
  maxVerifierCallsPerRun: number;
  maxFinalFindingsPerRun: number;
  // Retries for a schema-invalid-but-otherwise-successful expert response
  // (empirically a stochastic model-formatting glitch, not a deterministic
  // prompt defect — see expert-runner.ts's ExpertOutputSchemaError).
  maxExpertSchemaRetries: number;
}

export interface AnalyzeCoreInput {
  prepareArtifact: PrepareArtifact;
  skillIndexMd: string;
  loadSkillFn?: (name: string) => LoadedSkill;
  model: string;
  client: ExpertClient & VerifierClient;
  limits: AnalyzeLimits;
}

export interface AnalyzeCoreResult {
  findings: Finding[];
  coverageManifest: CoverageManifest;
  hardLimitHit: boolean;
  anyRequiredStageFailed: boolean;
  internalDiagnostics: InternalDiagnosticEntry[];
  // Diagnostic only (not schema/output-critical): the underlying error
  // message from whichever stage first set anyRequiredStageFailed, so the
  // job log doesn't silently swallow the real cause. Never include finding
  // content or PR data here, since it flows into core.warning/job logs.
  stageFailureReason?: string;
}

function agentCategory(agentName: string): string {
  return agentName.replace('generic-', '');
}

function skillsForAgent(
  agentName: string,
  filePaths: string[],
  skillIndex: SkillIndexEntry[],
  loadSkillFn: (name: string) => LoadedSkill,
): LoadedSkill[] {
  const triggered = matchTriggeredSkills(filePaths, skillIndex);
  const category = agentCategory(agentName);
  return triggered.map((e) => loadSkillFn(e.name)).filter((s) => s.meta.category === category);
}

// Width of the line-number gutter. Wide enough for six-digit files; anything
// longer just shifts the marker right, which costs nothing.
const LINE_NO_WIDTH = 6;

/**
 * Renders the diff the experts actually see.
 *
 * Every post-image line carries its real line number. This is not cosmetic:
 * `validateDeterministicEvidence` rejects any finding whose `line` falls
 * outside `[hunk.newStart, hunk.newStart + hunk.newLines - 1]`, so a model that
 * cannot see real line numbers cannot produce an acceptable finding. Before
 * this gutter existed the shard content had no `@@` header and no numbers at
 * all — the model counted from 1 within the text it was shown, and its
 * candidates were rejected in bulk (16/16 in the first real benchmark run,
 * reported as #9).
 *
 * Deleted lines deliberately get no number: they don't exist in the post-image,
 * and findings must anchor to `side: RIGHT`. Printing the old-side number there
 * would invite the model to anchor to a position the validator always rejects.
 */
export function buildShardContent(shard: PrepareShard): string {
  return shard.files
    .map((file) => {
      const hunkText = file.hunks
        .map((hunk) =>
          hunk.lines
            .map((line) => {
              if (line.type === 'del') {
                return `${' '.repeat(LINE_NO_WIDTH)} -${line.content}`;
              }
              const marker = line.type === 'add' ? '+' : ' ';
              const lineNo = String(line.newLine ?? '').padStart(LINE_NO_WIDTH);
              return `${lineNo} ${marker}${line.content}`;
            })
            .join('\n'),
        )
        .join('\n');
      return `File: ${file.path}\n${hunkText}`;
    })
    .join('\n\n');
}

function buildContextContentByPath(artifact: PrepareArtifact): Map<string, string> {
  const result = new Map<string, string>();
  for (const shard of artifact.shards) {
    for (const file of shard.files) {
      const entries = Object.entries(file.contextContents).map(
        ([path, content]) => `File: ${path}\n${content}`,
      );
      result.set(file.path, entries.join('\n\n'));
    }
  }
  return result;
}

export async function runAnalysis(input: AnalyzeCoreInput): Promise<AnalyzeCoreResult> {
  const loadSkillFn = input.loadSkillFn ?? loadSkill;
  const skillIndex = parseIndex(input.skillIndexMd);

  const allCandidates: CandidateFinding[] = [];
  const skillRequestsCollected: string[] = [];
  let hardLimitHit = false;
  let stop = false;
  let anyRequiredStageFailed = false;
  let stageFailureReason: string | undefined;

  outer: for (const shard of input.prepareArtifact.shards) {
    const filePaths = shard.files.map((f) => f.path);
    const shardContent = buildShardContent(shard);

    for (const agentName of AGENT_NAMES) {
      let result;
      try {
        const skills = skillsForAgent(agentName, filePaths, skillIndex, loadSkillFn);
        result = await runExpert({
          shardId: shard.id,
          agentName,
          systemPromptSkills: skills.map((s) => s.body),
          shardContent,
          model: input.model,
          client: input.client,
          maxCandidateFindingsPerAgentPerShard: input.limits.maxCandidateFindingsPerAgentPerShard,
          maxSchemaRetries: input.limits.maxExpertSchemaRetries,
        });
      } catch (err) {
        // A DeepSeek outage, a model response that fails expert-output schema
        // validation, or a malformed skill file (skillsForAgent/loadSkillFn)
        // is exactly as "required stage failed" as a verifier failure below —
        // degrade to incomplete instead of hard-failing the whole job.
        anyRequiredStageFailed = true;
        stageFailureReason = err instanceof Error ? err.message : String(err);
        stop = true;
        break outer;
      }

      allCandidates.push(...result.output.candidate_findings);
      if (result.output.skill_requests) {
        skillRequestsCollected.push(...result.output.skill_requests);
      }

      if (result.hardLimitHit) {
        hardLimitHit = true;
        stop = true;
        break outer;
      }
    }
  }

  if (!stop && skillRequestsCollected.length > 0) {
    let validRequests: string[] = [];
    try {
      validRequests = validateSkillRequests(
        [...new Set(skillRequestsCollected)],
        skillIndex,
        input.limits.maxSkillRequestsPerRun,
      );
    } catch {
      validRequests = [];
    }

    let requestedSkillBodies: string[] = [];
    if (validRequests.length > 0) {
      try {
        requestedSkillBodies = validRequests.map((name) => loadSkillFn(name).body);
      } catch (err) {
        anyRequiredStageFailed = true;
        stageFailureReason ??= err instanceof Error ? err.message : String(err);
        validRequests = [];
      }
    }

    if (validRequests.length > 0) {
      supplement: for (const shard of input.prepareArtifact.shards) {
        const shardContent = buildShardContent(shard);
        let result;
        try {
          result = await runExpert({
            shardId: shard.id,
            agentName: 'targeted-supplement',
            systemPromptSkills: requestedSkillBodies,
            shardContent,
            model: input.model,
            client: input.client,
            maxCandidateFindingsPerAgentPerShard: input.limits.maxCandidateFindingsPerAgentPerShard,
            maxSchemaRetries: input.limits.maxExpertSchemaRetries,
          });
        } catch (err) {
          anyRequiredStageFailed = true;
          stageFailureReason ??= err instanceof Error ? err.message : String(err);
          break supplement;
        }

        allCandidates.push(...result.output.candidate_findings);

        if (result.hardLimitHit) {
          hardLimitHit = true;
          break supplement;
        }
      }
    }
  }

  const hunksByPath = new Map<string, DiffHunk[]>();
  for (const shard of input.prepareArtifact.shards) {
    for (const file of shard.files) {
      hunksByPath.set(file.path, file.hunks);
    }
  }
  const contextContentByPath = buildContextContentByPath(input.prepareArtifact);

  const verifiedCandidates: VerifiedCandidate[] = [];
  let verifierCallCount = 0;

  for (const finding of allCandidates) {
    const hunks = hunksByPath.get(finding.path) ?? [];
    const deterministic = validateDeterministicEvidence(finding, finding.path, hunks);

    if (deterministic.status === 'failed') {
      verifiedCandidates.push({
        finding,
        deterministicStatus: 'failed',
        deterministicReason: deterministic.reason,
      });
      continue;
    }

    if (verifierCallCount >= input.limits.maxVerifierCallsPerRun) {
      hardLimitHit = true;
      verifiedCandidates.push({
        finding,
        deterministicStatus: deterministic.status,
        verifierConclusion: {
          status: 'rejected',
          notes: 'dropped: maxVerifierCallsPerRun exhausted before this candidate could be verified',
        },
      });
      continue;
    }

    verifierCallCount += 1;
    try {
      const conclusion = await verifyFinding({
        finding,
        contextContent: contextContentByPath.get(finding.path) ?? '',
        model: input.model,
        client: input.client,
      });
      verifiedCandidates.push({
        finding,
        deterministicStatus: deterministic.status,
        verifierConclusion: conclusion,
      });
    } catch (err) {
      if (err instanceof VerifierUnavailableError) {
        anyRequiredStageFailed = true;
        stageFailureReason ??= err.message;
        continue;
      }
      throw err;
    }
  }

  const { findings, internalDiagnostics } = arbitrate(verifiedCandidates);

  if (findings.length > input.limits.maxFinalFindingsPerRun) {
    hardLimitHit = true;
  }

  const coverageManifest: CoverageManifest = {
    ...input.prepareArtifact.coverage_manifest,
    hard_limit_hit: input.prepareArtifact.coverage_manifest.hard_limit_hit || hardLimitHit,
  };

  return {
    findings,
    coverageManifest,
    hardLimitHit,
    anyRequiredStageFailed,
    internalDiagnostics,
    ...(stageFailureReason !== undefined ? { stageFailureReason } : {}),
  };
}

export async function run(): Promise<void> {
  const prepareArtifactPath = core.getInput('prepare_artifact_path', { required: true });
  const model = core.getInput('model', { required: true });
  const prepareArtifact = readPrepareArtifactFromFile(prepareArtifactPath);
  // Reject any model name not in action/config/allowed-models.json before it
  // is ever sent to DeepSeek — a compromised or misconfigured caller workflow
  // must not be able to redirect requests to an arbitrary model.
  assertModelAllowed(model);
  // skills/ ships inside this action's own repo, reachable via
  // GITHUB_ACTION_PATH regardless of this job's GitHub API permissions
  // (permissions: {} only restricts GITHUB_TOKEN, not local fs reads of the
  // action's own bundled files) — so this never needs a workflow input.
  const skillIndexMd = readIndexMd();

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('analyze: DEEPSEEK_API_KEY is not set');
  }
  // Defence in depth for docs/AGENTS.md hard rule 5. The client scrubs the key
  // out of its own errors, but registering it here makes Actions mask it across
  // every log line this job ever writes, including ones from code that has no
  // idea a secret is in play. Must happen before the client exists, so nothing
  // can throw unmasked in between.
  core.setSecret(apiKey);
  const client = createDeepSeekClient({ apiKey });

  const result = await runAnalysis({
    prepareArtifact,
    skillIndexMd,
    model,
    client,
    limits: {
      maxCandidateFindingsPerAgentPerShard: centralLimits.maxCandidateFindingsPerAgentPerShard,
      maxSkillRequestsPerRun: centralLimits.maxSkillRequestsPerRun,
      maxVerifierCallsPerRun: centralLimits.maxVerifierCallsPerRun,
      maxFinalFindingsPerRun: centralLimits.maxFinalFindingsPerRun,
      maxExpertSchemaRetries: centralLimits.maxExpertSchemaRetries,
    },
  });

  if (result.stageFailureReason) {
    // Diagnostic only — never contains PR content, just the calling code's
    // own error message (schema validation errors, HTTP status text, etc).
    core.warning(`analyze: any_required_stage_failed — ${result.stageFailureReason}`);
  }

  const analyzeArtifactPath = core.getInput('analyze_artifact_path', { required: true });
  writeAnalyzeArtifactToFile({ findings: result.findings, coverage_manifest: result.coverageManifest }, analyzeArtifactPath);

  core.setOutput('hard_limit_hit', String(result.hardLimitHit));
  core.setOutput('any_required_stage_failed', String(result.anyRequiredStageFailed));
  core.setOutput('internal_diagnostics', JSON.stringify(result.internalDiagnostics));
}
