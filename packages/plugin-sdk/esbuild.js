import esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// @immich/sdk is a workspace sibling. Even with node-linker=hoisted, esbuild's
// exporter resolution against @immich/sdk's "exports" map occasionally fails
// to pick up the freshly-built build/index.js during the bundled Docker build.
// Resolve it directly from the workspace source so bundling is deterministic.
// Falls back to normal resolution if the direct path doesn't exist.
const sdkEntry = resolve(here, '../sdk/build/index.js');
const alias = existsSync(sdkEntry) ? { '@immich/sdk': sdkEntry } : undefined;

esbuild.build({
  entryPoints: ['src/index.ts', 'src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  sourcemap: false,
  minify: false,
  format: 'esm',
  platform: 'node',
  target: ['es2020'],
  ...(alias ? { alias } : {}),
});
