// Regenerates manifest.json from tasks.mjs:  node test/agent-runtime/corpus/build-manifest.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './index.mjs';

const file = fileURLToPath(new URL('./manifest.json', import.meta.url));
writeFileSync(file, `${JSON.stringify(buildManifest(), null, 2)}\n`);
process.stderr.write(`wrote ${file}\n`);
