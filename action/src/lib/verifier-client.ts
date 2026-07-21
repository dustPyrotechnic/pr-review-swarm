import verifierConclusionSchema from '../../../schemas/verifier-conclusion.schema.json' with { type: 'json' };
import { validate } from './schema-validator.js';
import { wrapUntrustedContent } from '../prompts/data-boundary.js';
import type { StructuredRequestInput } from './deepseek-client.js';
import type { CandidateFinding } from './expert-runner.js';

export class VerifierUnavailableError extends Error {}

export interface VerifierConclusion {
  status: 'confirmed' | 'rejected';
  notes?: string;
  evidence_refs?: Array<{ path: string; line: number }>;
}

export interface VerifierClient {
  sendStructuredRequest(input: StructuredRequestInput): Promise<unknown>;
}

export interface VerifyFindingInput {
  finding: CandidateFinding;
  contextContent: string;
  model: string;
  client: VerifierClient;
}

const VERIFIER_SYSTEM_PROMPT =
  'You are an independent verifier reviewing a single candidate finding raised by another reviewer. ' +
  'Actively look for counterexamples, missing preconditions, and existing safeguards that would make ' +
  'this finding invalid. If the finding claims a cross-file causal link (cross_file_causal_claim), you ' +
  'must locate a real call site or reference in the given context that supports the claim in ' +
  'evidence_refs — do not accept the claim on the reviewer\'s word alone. Respond with status ' +
  '"confirmed" only if the finding holds up after this scrutiny; otherwise respond "rejected".';

export async function verifyFinding(input: VerifyFindingInput): Promise<VerifierConclusion> {
  let raw: unknown;
  try {
    raw = await input.client.sendStructuredRequest({
      model: input.model,
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      userPrompt: wrapUntrustedContent(
        'candidate-finding-and-context',
        `${JSON.stringify(input.finding)}\n\n${input.contextContent}`,
      ),
      jsonSchema: verifierConclusionSchema,
    });
  } catch (err) {
    throw new VerifierUnavailableError(
      `verifier-client: verifier call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = validate<VerifierConclusion>(
    'https://pr-review-swarm/schemas/verifier-conclusion.schema.json',
    raw,
  );
  if (!result.valid) {
    throw new VerifierUnavailableError(
      `verifier-client: verifier response failed schema validation: ${result.errors.join('; ')}`,
    );
  }

  if (input.finding.cross_file_causal_claim === true && result.data.status === 'confirmed') {
    const refs = result.data.evidence_refs ?? [];
    if (refs.length === 0) {
      return {
        status: 'rejected',
        notes:
          'cross-file causal claim rejected: verifier did not cite any evidence_refs supporting the claim',
      };
    }
  }

  return result.data;
}
