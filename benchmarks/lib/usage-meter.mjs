/**
 * 在 `fetch` 这一层计量 token 用量与延迟。
 *
 * 为什么在这里而不是在客户端里：`createDeepSeekClient` 的
 * `sendStructuredRequest` 只返回解析后的业务 JSON，API 响应里的 `usage` 字段
 * 到不了调用方。而 `DeepSeekClientOptions.fetchImpl` 是个现成的注入点，
 * 用它就能拿到原始响应，且**不需要为了评测去改生产代码**。
 *
 * 计量层必须对下游完全透明：响应体只读克隆，原响应原样返回。
 */
export function createMeteredFetch(baseFetch, pricing) {
  const stats = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    missingUsage: 0,
    // 每个元素是**一次 HTTP 请求**的耗时，不是一次审核的端到端耗时。
    // 端到端延迟由 run-evaluation.mjs 自己在 runAnalysis 外层计时。
    latenciesMs: [],
    get costUsd() {
      return (
        (this.promptTokens / 1_000_000) * pricing.input_usd_per_million +
        (this.completionTokens / 1_000_000) * pricing.output_usd_per_million
      );
    },
  };

  async function fetchImpl(...args) {
    stats.requests += 1;
    const startedAt = Date.now();
    let response;
    try {
      response = await baseFetch(...args);
    } catch (err) {
      // 失败的请求同样要记延迟：只统计成功路径会让 p95 把超时全藏起来，
      // 而超时正是最需要被门槛拦住的那一类劣化。
      stats.latenciesMs.push(Date.now() - startedAt);
      throw err;
    }
    stats.latenciesMs.push(Date.now() - startedAt);

    await recordUsage(response, stats);
    return response;
  }

  return { fetchImpl, stats };
}

async function recordUsage(response, stats) {
  try {
    // clone() 是关键：直接读会消费掉 body，客户端随后拿到的是空流。
    const body = await response.clone().json();
    const usage = body?.usage;
    if (
      !usage ||
      !Number.isFinite(usage.prompt_tokens) ||
      !Number.isFinite(usage.completion_tokens)
    ) {
      // 不静默当成 0：API 改了字段名的话，成本门槛会从此永远绿灯。
      stats.missingUsage += 1;
      return;
    }
    stats.promptTokens += usage.prompt_tokens;
    stats.completionTokens += usage.completion_tokens;
  } catch {
    // 非 JSON 响应（网关错误页、限流页）没有 usage 可言，不该让评测崩掉。
    stats.missingUsage += 1;
  }
}

/**
 * p95：向上取整的秩次法。样本很少时（评测通常几十次请求）比线性插值更保守，
 * 不会因为插值把最慢的那次抹平。
 */
export function percentile(values, p) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}
