import expertOutputSchema from '../../../schemas/expert-output.schema.json' with { type: 'json' };
import { validate } from './schema-validator.js';
import { wrapUntrustedContent } from '../prompts/data-boundary.js';
import type { StructuredRequestInput } from './deepseek-client.js';

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

export async function runExpert(input: RunExpertInput): Promise<RunExpertResult> {
  const systemPrompt = buildExpertSystemPrompt(input.agentName, input.systemPromptSkills);
  const userPrompt = wrapUntrustedContent('diff-and-context', input.shardContent);

  const raw = await input.client.sendStructuredRequest({
    model: input.model,
    systemPrompt,
    userPrompt,
    jsonSchema: expertOutputSchema,
  });

  const result = validate<ExpertOutput>(
    'https://pr-review-swarm/schemas/expert-output.schema.json',
    raw,
  );
  if (!result.valid) {
    throw new Error(
      `expert-runner: model response failed expert-output schema validation: ${result.errors.join('; ')}`,
    );
  }

  const hardLimitHit =
    result.data.coverage_complete !== true ||
    result.data.candidate_findings.length >= input.maxCandidateFindingsPerAgentPerShard;

  return { output: result.data, hardLimitHit };
}
