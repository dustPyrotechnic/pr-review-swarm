/**
 * esbuild 的打包入口：把 analyze 管线里评测需要的那几个真实实现 re-export 出来。
 *
 * 为什么要打包而不是直接 import：这些是 TypeScript 源码，而评测脚本是 `.mjs`。
 * 走 esbuild 意味着评测跑的是**和 `npm run build` 同一套工具链产出的同一份代码**，
 * 不是一份为了好测而写的平行实现。评测一旦度量的是平行实现，它就不再是回归护栏。
 *
 * 这个文件刻意放在 benchmarks/ 下而不是 action/src/ 下：它只服务于评测，不应该
 * 出现在 action 的 typecheck/lint 范围里，更不该有机会被打进发布用的 dist/。
 */
export { runAnalysis } from '../../action/src/entrypoints/analyze.js';
export { parsePatch } from '../../action/src/lib/diff-parser.js';
export { shardFiles } from '../../action/src/lib/sharding.js';
export { classifyFile } from '../../action/src/lib/file-classifier.js';
export { scanAndRedactSecrets } from '../../action/src/lib/secret-scanner.js';
export { validateDeterministicEvidence } from '../../action/src/lib/deterministic-evidence-validator.js';
export { createDeepSeekClient } from '../../action/src/lib/deepseek-client.js';
export { readIndexMd, loadSkill } from '../../action/src/lib/skill-loader.js';
export { computeReviewSetId } from '../../action/src/lib/review-set-id.js';
export { default as centralLimits } from '../../action/config/central-limits.json';
