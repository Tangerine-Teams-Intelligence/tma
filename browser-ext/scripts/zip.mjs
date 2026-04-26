#!/usr/bin/env node
/**
 * Pack `dist/` into `tangerine-ext-<version>.zip` for Chrome Web Store upload.
 */

import archiver from 'archiver';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist/ not found — run `npm run build` first');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, `tangerine-ext-${pkg.version}.zip`);

const stream = createWriteStream(out);
const zip = archiver('zip', { zlib: { level: 9 } });
zip.pipe(stream);
zip.directory(dist, false);

stream.on('close', () => console.log(`wrote ${out} (${zip.pointer()} bytes)`));
zip.on('error', (err) => { throw err; });
zip.finalize();
