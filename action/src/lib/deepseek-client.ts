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
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: `${input.systemPrompt}\n\nRespond with a single JSON object matching this JSON Schema:\n${JSON.stringify(input.jsonSchema)}`,
              },
              { role: 'user', content: input.userPrompt },
            ],
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
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new DeepSeekResponseError(
          'deepseek-client: response missing choices[0].message.content',
        );
      }

      try {
        return JSON.parse(content);
      } catch {
        throw new DeepSeekResponseError('deepseek-client: response content is not valid JSON');
      }
    }
  }

  return { sendStructuredRequest };
}
