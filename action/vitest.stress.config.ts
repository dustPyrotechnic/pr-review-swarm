import { defineConfig } from 'vitest/config';

/**
 * nightly 压力测试通道：只跑 `*.stress.test.ts`。
 *
 * 这些用例的输入全部程序生成（几千个变更文件、几十 MB diff、十万行 hunk），不往仓库里提交
 * 大文件。单个用例的预算放宽到 120 秒——它们要证明的是"不 OOM、不指数级回溯、不 hang"，
 * 而不是"很快"。
 */
export default defineConfig({
  test: {
    include: ['**/*.stress.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 压力用例彼此争抢内存，串行跑才能让 OOM 归因到具体某一条。
    fileParallelism: false,
  },
});
