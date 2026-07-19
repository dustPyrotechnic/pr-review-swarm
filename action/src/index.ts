import * as core from '@actions/core';

async function run(): Promise<void> {
  const entrypoint = core.getInput('entrypoint', { required: true });
  switch (entrypoint) {
    case 'status-start':
      return (await import('./entrypoints/status-start.js')).run();
    case 'lightweight-cleanup':
      return (await import('./entrypoints/lightweight-cleanup.js')).run();
    case 'prepare':
      return (await import('./entrypoints/prepare.js')).run();
    case 'analyze':
      return (await import('./entrypoints/analyze.js')).run();
    case 'publish':
      return (await import('./entrypoints/publish.js')).run();
    case 'status-finalize':
      return (await import('./entrypoints/status-finalize.js')).run();
    case 'watchdog':
      return (await import('./entrypoints/watchdog.js')).run();
    default:
      core.setFailed(`unknown entrypoint: ${entrypoint}`);
  }
}

run().catch((err) => core.setFailed(err instanceof Error ? err.message : String(err)));
