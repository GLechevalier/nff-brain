// Dependency-free ZIP writer for the Chrome Web Store upload.
//
// Why not `npx bestzip` (the precedent set by `npx @vscode/vsce package`):
// the store requires manifest.json at the ZIP ROOT, which means zipping the
// CONTENTS of dist/ rather than dist/ itself — `cd dist && zip ../out.zip *`.
// That glob does not expand on Windows, where this repo is primarily developed,
// so the package script would only work on CI. Node's zlib already provides the
// raw DEFLATE stream that ZIP method 8 is defined as, so the whole writer is
// about eighty lines and needs no network at package time.

import { deflateRawSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = 'dist';
const OUT = 'nff-brain-chrome.zip';

// Fixed 1980-01-01 rather than mtime, so the same dist/ always produces a
// byte-identical archive — a reviewer can diff two builds.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Every file under dir, as POSIX-separated paths relative to it, sorted. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

if (!fs.existsSync(SRC)) {
  console.error(`zip: ${SRC}/ does not exist — run \`npm run build\` first`);
  process.exit(1);
}
if (!fs.existsSync(path.join(SRC, 'manifest.json'))) {
  console.error(`zip: ${SRC}/manifest.json is missing — the store requires it at the archive root`);
  process.exit(1);
}
{
  // A dist built with NFF_BRAIN_TEST_MANIFEST=1 (the eval harness's variant,
  // see build.mjs writeTestManifest) promotes optional permissions to
  // install-time grants. Shipping that to the store would be a silent
  // permission escalation — refuse and demand a clean rebuild.
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  if (m.host_permissions !== undefined) {
    console.error('zip: dist/manifest.json declares host_permissions — this is the TEST manifest variant.');
    console.error('     rebuild without NFF_BRAIN_TEST_MANIFEST before packaging: npm run build');
    process.exit(1);
  }
}
{
  // A dist built with NFF_BRAIN_BENCH=1 embeds the act-benchmark driver in
  // sw.js (see build.mjs) — an unauthenticated loopback command channel.
  // Shipping it would be a remote-control backdoor — refuse.
  const sw = fs.readFileSync(path.join(SRC, 'sw.js'), 'utf8');
  if (sw.includes('__NFF_BENCH_DRIVER__')) {
    console.error('zip: dist/sw.js contains the bench-driver sentinel — this is the BENCH build variant.');
    console.error('     rebuild without NFF_BRAIN_BENCH before packaging: npm run build');
    process.exit(1);
  }
}

const names = walk(SRC);
const local = [];
const central = [];
let offset = 0;

for (const name of names) {
  const raw = fs.readFileSync(path.join(SRC, name));
  const deflated = deflateRawSync(raw, { level: 9 });
  // Storing is smaller than deflating for already-compressed bytes (PNG icons).
  const stored = deflated.length >= raw.length;
  const body = stored ? raw : deflated;
  const method = stored ? 0 : 8;
  const crc = crc32(raw);
  const nameBuf = Buffer.from(name, 'utf8');

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt16LE(DOS_TIME, 10);
  lfh.writeUInt16LE(DOS_DATE, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(body.length, 18);
  lfh.writeUInt32LE(raw.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28); // extra
  local.push(lfh, nameBuf, body);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4); // version made by
  cdh.writeUInt16LE(20, 6); // version needed
  cdh.writeUInt16LE(0, 8); // flags
  cdh.writeUInt16LE(method, 10);
  cdh.writeUInt16LE(DOS_TIME, 12);
  cdh.writeUInt16LE(DOS_DATE, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(body.length, 20);
  cdh.writeUInt32LE(raw.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30); // extra
  cdh.writeUInt16LE(0, 32); // comment
  cdh.writeUInt16LE(0, 34); // disk number start
  cdh.writeUInt16LE(0, 36); // internal attrs
  cdh.writeUInt32LE(0o644 << 16, 38); // external attrs (unix mode in the high word)
  cdh.writeUInt32LE(offset, 42);
  central.push(cdh, nameBuf);

  offset += lfh.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4); // disk number
eocd.writeUInt16LE(0, 6); // disk with central dir
eocd.writeUInt16LE(names.length, 8);
eocd.writeUInt16LE(names.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20); // comment

fs.writeFileSync(OUT, Buffer.concat([...local, centralBuf, eocd]));
console.log(`wrote ${OUT} — ${names.length} file(s), ${fs.statSync(OUT).size} bytes`);
