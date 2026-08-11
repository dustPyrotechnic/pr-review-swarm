import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARKS_DIR = join(__dirname, '..');
const REPO_ROOT = join(BENCHMARKS_DIR, '..');
const ACTION_DIR = join(REPO_ROOT, 'action');
const ENTRY = join(__dirname, 'pipeline-entry.ts');
// 刻意用 .cjs + require 加载，而不是 ESM + 动态 import()：在 Vitest 下跑时，
// Vite 会拦截动态 import 并用自己的模块解析器去找这个文件，而它并不认识
// 一个刚刚在运行期凭空生成的产物。require 走的是 Node 原生解析，不受影响。
//
// 文件名带随机后缀：Vitest 并行跑测试文件，每个 worker 都会各自构建一次
// （模块级 cached 只在自己的模块图里有效）。共用一个输出路径时，一个 worker
// 会 require 到另一个正写到一半的 bundle，报出 "Unexpected end of input" ——
// 随机红、换台机器就复现不了。
//
// 刻意不用 process.pid 做区分：Vitest 默认的 worker 池是 worker_threads，
// 多个 worker 是同一进程里的线程，pid 完全相同，等于没隔离。
const OUT = join(BENCHMARKS_DIR, '.build', `pipeline.${randomUUID()}.cjs`);

let cached;

/**
 * 现场把 action 的 TypeScript 源码打成一份 ESM bundle 并加载，返回 analyze
 * 管线的真实实现。
 *
 * 用的是 action 自己的 esbuild（同一个版本、同一套解析规则），所以评测跑的
 * 代码路径和 `npm run build` 产出的 dist/ 是同一份源码。
 */
export async function loadPipeline() {
  if (cached) {
    return cached;
  }

  const esbuild = requireFromAction('esbuild');

  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // action 的运行时依赖（@actions/core 等）一并打进来，和生产 bundle 一致。
    external: [],
    sourcemap: false,
    // 只报 error。这里唯一会出现的 warning 是 skill-loader 里那句
    // `import.meta.url` 在 cjs 下为空——那是它 GITHUB_ACTION_PATH 缺失时的兜底
    // 分支，本模块下面会显式设置该环境变量，永远走不到。action 自己的生产构建
    // 也带着同一条警告（见 skill-loader.ts 的注释）。让它在每个测试 worker 里
    // 重复刷屏，只会训练人忽略 esbuild 的输出。
    logLevel: 'error',
  });

  // skill-loader 优先认 GITHUB_ACTION_PATH，其次靠 __dirname 猜层级。bundle 落在
  // benchmarks/.build/ 下，层级猜测会指到仓库外面，所以这里显式给出生产语义的
  // 路径：GITHUB_ACTION_PATH 指向 action/，skillsDir 解析为 <repo>/skills。
  process.env.GITHUB_ACTION_PATH = ACTION_DIR;

  cached = createRequire(import.meta.url)(OUT);

  // 每个进程一个 ~1.3MB 的 bundle，不清理的话反复跑测试会在 .build/ 里攒一堆
  // 死文件。已经 require 进内存了，文件本身不再需要。
  process.once('exit', () => {
    try {
      rmSync(OUT, { force: true });
    } catch {
      // 清理失败不该影响任何结论；.build/ 已在 .gitignore 里。
    }
  });

  return cached;
}

function requireFromAction(name) {
  const actionPackageJson = join(ACTION_DIR, 'package.json');
  if (!existsSync(join(ACTION_DIR, 'node_modules'))) {
    throw new Error(
      '评测需要 action 的依赖（esbuild 等）。先跑：cd action && npm ci',
    );
  }
  return createRequire(actionPackageJson)(name);
}
