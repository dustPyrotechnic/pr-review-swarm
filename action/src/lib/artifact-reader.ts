import { existsSync, readFileSync, statSync } from 'node:fs';
import centralLimits from '../../config/central-limits.json' with { type: 'json' };
import { validate } from './schema-validator.js';

/**
 * Job 之间通过文件 + upload/download-artifact 传输的产物，读取时的统一闸门。
 *
 * 这条链路（见 docs/plans/2026-07-27-prepare-artifact-file-transport.md）此前是
 * `JSON.parse(readFileSync(...)) as T` —— 一次无条件的类型断言。analyze 持有 DeepSeek
 * Secret 且 `permissions: {}`，它对这个文件的信任完全是隐式的：一个被截断的 artifact
 * 会变成结构错乱的对象继续往下流，最糟的情形是 publish 把一个损坏的 analyze artifact
 * 当成"零 finding"，发出一个 pass 的 COMMENT —— 静默漏审。
 *
 * 四道闸门，顺序有意义：
 *   1. 存在性 —— 明确报错，不静默当空输入；
 *   2. 大小 —— 在**读文件之前**用 stat 判定，一个 1GB 的 artifact 不能先被读进内存；
 *   3. JSON 可解析性；
 *   4. schema 校验。
 *
 * 边界要说清楚：这里只保证"结构合法"，不保证"内容可信"。完整性校验从来不是信任证明，
 * finding 的路径/行号仍然要走 deterministic-evidence-validator。
 */
export interface ReadArtifactOptions {
  /** 覆盖大小上限，主要供测试使用。 */
  maxBytes?: number;
}

export class ArtifactReadError extends Error {}

function assertSizeWithinLimit(label: string, filePath: string, maxBytes: number): void {
  const { size } = statSync(filePath);
  if (size > maxBytes) {
    throw new ArtifactReadError(
      `${label}: 文件大小 ${size} bytes 超过上限 ${maxBytes} bytes (size limit exceeded)，拒绝读取`,
    );
  }
}

function parseJson(label: string, filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ArtifactReadError(
      `${label}: 内容不是合法 JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

function validateAgainstSchema<T>(label: string, schemaId: string, data: unknown): T {
  const result = validate<T>(schemaId, data);
  if (!result.valid) {
    throw new ArtifactReadError(`${label}: schema validation failed — ${result.errors.join('; ')}`);
  }
  return result.data;
}

/** 读取一个必须存在的 artifact。缺失即错误。 */
export function readRequiredArtifact<T>(params: {
  label: string;
  filePath: string;
  schemaId: string;
  options?: ReadArtifactOptions;
}): T {
  const { label, filePath, schemaId } = params;
  const maxBytes = params.options?.maxBytes ?? centralLimits.maxArtifactBytes;

  if (!existsSync(filePath)) {
    throw new ArtifactReadError(`${label}: 文件不存在：${filePath}`);
  }
  assertSizeWithinLimit(label, filePath, maxBytes);
  return validateAgainstSchema<T>(label, schemaId, parseJson(label, filePath));
}

/**
 * 读取一个**可以合法缺失**的 artifact。
 *
 * 缺失与损坏必须区别对待：缺失是正常路径（prepare 判定 stale 时 analyze 整个被跳过，
 * 从不写这个文件），损坏则绝不能被当成"零 finding"继续发布。
 */
export function readOptionalArtifact<T>(params: {
  label: string;
  filePath: string;
  schemaId: string;
  options?: ReadArtifactOptions;
}): T | undefined {
  if (!existsSync(params.filePath)) return undefined;
  return readRequiredArtifact<T>(params);
}
