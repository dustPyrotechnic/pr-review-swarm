// DeepSeek's json_object response_format only guarantees syntactically valid
// JSON, not compliance with a caller-supplied schema — embedding the schema
// as prompt text was observed to produce responses with made-up field names.
// Forcing a tool call instead constrains the model to the declared
// `parameters` schema.
const SUBMIT_RESULT_FUNCTION_NAME = 'submit_result';

export class DeepSeekTransientError extends Error {}
export class DeepSeekResponseError extends Error {}

export interface StructuredRequestInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: object;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeepSeekClient {
  sendStructuredRequest(input: StructuredRequestInput): Promise<unknown>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return exponential + jitter;
}

/**
 * docs/AGENTS.md hard rule 5: the DeepSeek secret must never reach a log or an
 * artifact. This client is the only thing in the process that holds it, so it
 * is also the only place that can contain a leak at the source.
 *
 * The realistic leak path is the network-error branch below: it interpolates an
 * arbitrary upstream error message, and HTTP stacks routinely include the full
 * request — Authorization header included — in theirs. That message then flows
 * into `stageFailureReason` and out through `core.warning` into the job log.
 * Scrubbing here protects every consumer of the client, not just analyze.
 */
function redactApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('[REDACTED:deepseek-api-key]');
}

export function createDeepSeekClient(options: DeepSeekClientOptions): DeepSeekClient {
  const baseUrl = options.baseUrl ?? 'https://api.deepseek.com';
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function sendStructuredRequest(input: StructuredRequestInput): Promise<unknown> {
    let attempt = 0;

    for (;;) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: input.model,
            messages: [
              { role: 'system', content: input.systemPrompt },
              { role: 'user', content: input.userPrompt },
            ],
            tools: [
              {
                type: 'function',
                function: {
                  name: SUBMIT_RESULT_FUNCTION_NAME,
                  description: 'Submit the structured result of this review.',
                  parameters: input.jsonSchema,
                },
              },
            ],
            tool_choice: {
              type: 'function',
              function: { name: SUBMIT_RESULT_FUNCTION_NAME },
            },
          }),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(backoffDelay(attempt, retryBaseDelayMs));
          continue;
        }
        throw new DeepSeekTransientError(
          `deepseek-client: network error after ${attempt} retries: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (isRetryableStatus(response.status)) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(backoffDelay(attempt, retryBaseDelayMs));
          continue;
        }
        throw new DeepSeekTransientError(
          `deepseek-client: received retryable status ${response.status} after ${attempt} retries`,
        );
      }

      if (!response.ok) {
        throw new DeepSeekResponseError(
          `deepseek-client: request failed with status ${response.status}`,
        );
      }

      const body = (await response.json()) as {
        choices?: Array<{
          message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
        }>;
      };
      const toolCall = body.choices?.[0]?.message?.tool_calls?.find(
        (call) => call.function?.name === SUBMIT_RESULT_FUNCTION_NAME,
      );
      const args = toolCall?.function?.arguments;
      if (typeof args !== 'string') {
        throw new DeepSeekResponseError(
          `deepseek-client: response missing choices[0].message.tool_calls[].function(name=${SUBMIT_RESULT_FUNCTION_NAME}).arguments`,
        );
      }

      try {
        return JSON.parse(args);
      } catch {
        throw new DeepSeekResponseError(
          'deepseek-client: tool call arguments are not valid JSON',
        );
      }
    }
  }

  // Scrub on the way out rather than only in the network branch: any error
  // escaping this client (JSON parse failures over a response body, a custom
  // fetchImpl's own error, …) could carry the key, and the whole point is that
  // callers never have to think about it.
  async function sendStructuredRequestSafely(input: StructuredRequestInput): Promise<unknown> {
    try {
      return await sendStructuredRequest(input);
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err));
      const message = redactApiKey(original.message, options.apiKey);
      if (message === original.message) throw original;

      const Ctor = original.constructor as new (message: string) => Error;
      const scrubbed = new Ctor(message);
      if (original.stack) scrubbed.stack = redactApiKey(original.stack, options.apiKey);
      throw scrubbed;
    }
  }

  return { sendStructuredRequest: sendStructuredRequestSafely };
}
