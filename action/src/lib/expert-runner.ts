import expertOutputSchema from '../../../schemas/expert-output.schema.json' with { type: 'json' };
import candidateFindingSchema from '../../../schemas/candidate-finding.schema.json' with { type: 'json' };
import { validate } from './schema-validator.js';
import { dereferenceSchema } from './schema-dereferencer.js';
import { wrapUntrustedContent } from '../prompts/data-boundary.js';
import { withRetry } from './retry.js';
import type { StructuredRequestInput } from './deepseek-client.js';

// Thrown when a model response is well-formed JSON but doesn't conform to
// the expert-output schema (e.g. coverage_complete returned as a string
// instead of a boolean). Distinct from network/transport errors so callers
// can retry this specific, empirically stochastic failure mode without
// also retrying on things that shouldn't be retried blindly.
export class ExpertOutputSchemaError extends Error {}

const expertOutputSchemaForModel = dereferenceSchema(expertOutputSchema, {
  [candidateFindingSchema.$id]: candidateFindingSchema,
});

export interface CandidateFinding {
  id: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  evidence: string;
  impact: string;
  suggestion: string;
  introduced_by_pr: boolean;
  cross_file_causal_claim?: boolean;
  causal_evidence_refs?: Array<{ path: string; line: number }>;
  source_agent: string;
}

export interface ExpertOutput {
  shard_id: string;
  agent: string;
  candidate_findings: CandidateFinding[];
  coverage_complete: boolean;
  skill_requests?: string[];
}

export interface ExpertClient {
  sendStructuredRequest(input: StructuredRequestInput): Promise<unknown>;
}

export interface RunExpertInput {
  shardId: string;
  agentName: string;
  systemPromptSkills: string[];
  shardContent: string;
  model: string;
  client: ExpertClient;
  maxCandidateFindingsPerAgentPerShard: number;
  // Retries specifically for a schema-invalid-but-otherwise-successful
  // response (see ExpertOutputSchemaError) — separate from any
  // network-level retry the client itself performs. Defaults to 0 (no
  // retry) so existing callers/tests are unaffected unless they opt in.
  maxSchemaRetries?: number;
  retrySleep?: (ms: number) => Promise<void>;
}

export interface RunExpertResult {
  output: ExpertOutput;
  hardLimitHit: boolean;
}

function buildExpertSystemPrompt(agentName: string, skillBodies: string[]): string {
  return [
    `You are the "${agentName}" reviewer in a multi-expert pull request review swarm.`,
    'Only report issues introduced, exposed, expanded, or made reachable by this PR. ' +
      'Follow every checklist below.',
    ...skillBodies,
  ].join('\n\n');
}

async function requestAndValidate(
  input: RunExpertInput,
  systemPrompt: string,
  userPrompt: string,
): Promise<ExpertOutput> {
  const raw = await input.client.sendStructuredRequest({
    model: input.model,
    systemPrompt,
    userPrompt,
    jsonSchema: expertOutputSchemaForModel,
  });

  const result = validate<ExpertOutput>(
    'https://pr-review-swarm/schemas/expert-output.schema.json',
    raw,
  );
  if (!result.valid) {
    throw new ExpertOutputSchemaError(
      `expert-runner: model response failed expert-output schema validation: ${result.errors.join('; ')}`,
    );
  }

  return result.data;
}

export async function runExpert(input: RunExpertInput): Promise<RunExpertResult> {
  const systemPrompt = buildExpertSystemPrompt(input.agentName, input.systemPromptSkills);
  const userPrompt = wrapUntrustedContent('diff-and-context', input.shardContent);

  const data = await withRetry(() => requestAndValidate(input, systemPrompt, userPrompt), {
    maxRetries: input.maxSchemaRetries ?? 0,
    sleep: input.retrySleep,
    isRetryable: (err) => err instanceof ExpertOutputSchemaError,
  });

  const hardLimitHit =
    data.coverage_complete !== true ||
    data.candidate_findings.length >= input.maxCandidateFindingsPerAgentPerShard;

  return { output: data, hardLimitHit };
}
