import { defineConfig } from 'vitest/config';

/**
 * PR 阻塞级测试通道。
 *
 * 刻意排除 `*.stress.test.ts`：压力测试要生成几千个文件、几十 MB 的 diff，跑一次几十秒到
 * 几分钟，放进 PR 门禁只会让人开始习惯性忽略红灯。它们走 nightly 通道
 * （`npm run test:stress`，见 vitest.stress.config.ts 与 .github/workflows/nightly.yml）。
 */
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.stress.test.ts'],
  },
});
