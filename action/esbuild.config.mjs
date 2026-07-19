import * as esbuild from 'esbuild';
import { writeFileSync } from 'node:fs';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [],
  sourcemap: false,
  logLevel: 'info',
});

// The root package.json declares "type": "module", which would otherwise make
// Node treat dist/index.js as ESM. This nested package.json scopes dist/ back
// to CommonJS to match the esbuild "cjs" output format.
writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
