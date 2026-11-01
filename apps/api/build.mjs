// Bundles the API and the shared core into one file; native and server packages stay in node_modules.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  alias: { '@optimystic/core': '../../packages/core/src/index.ts' },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
});
console.log('built dist/index.js');
