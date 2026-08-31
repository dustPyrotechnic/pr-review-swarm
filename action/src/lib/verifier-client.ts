import verifierConclusionSchema from '../../../schemas/verifier-conclusion.schema.json' with { type: 'json' };
import { validate } from './schema-validator.js';
import { wrapUntrustedContent } from '../prompts/data-boundary.js';
import { withRetry } from './retry.js';
import { DeepSeekMalformedResultError, type StructuredRequestInput } from './deepseek-client.js';
import type { CandidateFinding } from './expert-runner.js';

export class VerifierUnavailableError extends Error {}

/**
 * verifier 的**响应结构**不可用 —— 模型这一次没按 schema 输出。2026-08-29 的
 * ios-source-learning#9 第 17 轮就是这个：响应少了 `status`，整轮判 incomplete。
 *
 * 和 expert-runner 的 ExpertOutputSchemaError 同一性质：经验上是随机的，同样的
 * 请求下一次通常就好了。单独立成子类，是因为 verifyFinding 会把客户端的**任何**
 * 异常都包成 VerifierUnavailableError —— 其中 401、空响应体、缺 tool_calls 都是
 * 确定性失败，重试只烧配额（deepseek-client.ts 的注释对这一点写得很清楚）。
 * 只有这一类和 DeepSeekMalformedResultError 值得重试。
 */
export class VerifierSchemaError extends VerifierUnavailableError {}

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
  // 与 expert-runner 的 maxSchemaRetries 同一语义：模型这一次输出结构不可用，
  // 同样的请求下一次通常就好了。默认 0，既有调用方不受影响。
  maxSchemaRetries?: number;
  retrySleep?: (ms: number) => Promise<void>;
}

const VERIFIER_SYSTEM_PROMPT =
  'You are an independent verifier reviewing a single candidate finding raised by another reviewer. ' +
  'Actively look for counterexamples, missing preconditions, and existing safeguards that would make ' +
  'this finding invalid. If the finding claims a cross-file causal link (cross_file_causal_claim), you ' +
  'must locate a real call site or reference in the given context that supports the claim in ' +
  'evidence_refs — do not accept the claim on the reviewer\'s word alone. Respond with status ' +
  '"confirmed" only if the finding holds up after this scrutiny; otherwise respond "rejected". ' +
  // 实测里 12/62 条 finding 的正文自己论证完就写「不构成缺陷」，verifier 却照样
  // 给了 confirmed —— 因为它被问的是「描述是否属实」，而那些描述确实属实。
  // 这里把「要求对方改什么」也纳入判断。确定性防线在 arbiter 的
  // self-refutation-gate，这条只是补强。
  'Reject the finding outright if its own text concludes that the code is correct, or if its ' +
  '`suggestion` field does not actually ask for a change (for example "无", "无需修改", ' +
  '"none") — a finding that requests nothing is not a finding, however sound its analysis is.';

async function requestAndValidate(input: VerifyFindingInput): Promise<VerifierConclusion> {
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
    // 带上 cause，让下面的 isRetryable 能分辨「模型这次抽了」（畸形 tool-call）
    // 和「401 / 空响应体 / 缺 tool_calls」这两种完全不同的失败。
    throw new VerifierUnavailableError(
      `verifier-client: verifier call failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = validate<VerifierConclusion>(
    'https://pr-review-swarm/schemas/verifier-conclusion.schema.json',
    raw,
  );
  if (!result.valid) {
    throw new VerifierSchemaError(
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

export async function verifyFinding(input: VerifyFindingInput): Promise<VerifierConclusion> {
  return withRetry(() => requestAndValidate(input), {
    maxRetries: input.maxSchemaRetries ?? 0,
    ...(input.retrySleep ? { sleep: input.retrySleep } : {}),
    // 只重试真正随机的两类。默认的 isRetryable 会把「没有 status 字段的异常」
    // 一律当成可重试，那会把 401 和空响应体也算进去 —— 明确覆盖掉。
    isRetryable: (err) =>
      err instanceof VerifierSchemaError ||
      (err as { cause?: unknown } | null)?.cause instanceof DeepSeekMalformedResultError,
  });
}
