import esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// @immich/sdk is a workspace sibling. Under pnpm's isolated linker its build/
// output is not always visible via node_modules resolution (the .pnpm copy of
// the package lacks the generated build/ dir), which breaks esbuild bundling.
// Resolve it directly from the workspace source so the linker mode doesn't
// matter. Falls back to normal resolution if the direct path doesn't exist.
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
