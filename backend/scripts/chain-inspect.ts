#!/usr/bin/env tsx
/** Read-only chain inspector: walk proof-chain.jsonl, report every linkage
 *  break and payload-hash mismatch with enough detail to decide a repair.
 *  Writes nothing. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../src/config';

const GENESIS = '0'.repeat(64);
const { createHash } = await import('node:crypto');

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hashPayload = (p: unknown) => sha(canonicalJson(p));
const legacyHashPayload = (p: unknown) => sha(JSON.stringify(p));
const computeHash = (prev: string, payloadHash: string, kind: string) =>
  sha(prev + payloadHash + kind);

interface Entry {
  id: string; ts: number; prevHash: string; payloadHash: string;
  signature?: string; kind: string; payload: Record<string, unknown>;
}

function load(name: string): Entry[] {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l, i) => {
      try { return JSON.parse(l) as Entry; } catch { console.log(`  [${name}] torn line ${i + 1}`); return null; }
    })
    .filter((e): e is Entry => e !== null);
}

function walk(entries: Entry[], label: string): void {
  console.log(`\n== ${label}: ${entries.length} entries ==`);
  let cursor = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const canonical = hashPayload(e.payload);
    const legacy = legacyHashPayload(e.payload);
    const payloadOk = e.payloadHash === canonical || e.payloadHash === legacy;
    const prevOk = e.prevHash === cursor;
    if (!prevOk || !payloadOk) {
      const scheme = e.payloadHash === canonical ? 'canonical' : e.payloadHash === legacy ? 'legacy' : 'NEITHER';
      console.log(`\nBREAK at entry #${i + 1} (id=${e.id}, kind=${e.kind}, ts=${new Date(e.ts).toISOString()})`);
      console.log(`  prevHash stored:   ${e.prevHash}`);
      console.log(`  prevHash expected: ${cursor}`);
      console.log(`  payloadHash: ${scheme}${payloadOk ? ' (matches payload)' : ' (MISMATCH)'}`);
      if (!payloadOk) console.log(`  recomputed canonical: ${canonical}`);
      console.log(`  signature present: ${e.signature ? 'yes' : 'no'}`);
      // What WOULD the chain look like if we continue from THIS entry's stored fields?
      cursor = computeHash(e.prevHash, e.payloadHash, e.kind);
    } else {
      cursor = computeHash(e.prevHash, e.payloadHash, e.kind);
    }
  }
  console.log(`final head: ${cursor}`);
}

const main = load('proof-chain.jsonl');
walk(main, 'proof-chain.jsonl');

for (const f of ['proof-chain.corrupt.jsonl', 'proof-chain.prefix-archive.jsonl']) {
  const alt = load(f);
  if (alt.length) walk(alt.slice(Math.max(0, main.length - 10), alt.length), `${f} (tail)`);
}

// Show the neighborhood of the first break in the main file.
let cursor = GENESIS;
for (let i = 0; i < main.length; i++) {
  const e = main[i];
  if (i > 0 && e.prevHash !== cursor) {
    console.log(`\n== context around break (entries ${Math.max(0, i - 2) + 1}..${Math.min(main.length, i + 4)}) ==`);
    for (let j = Math.max(0, i - 2); j < Math.min(main.length, i + 4); j++) {
      const x = main[j];
      console.log(`#${j + 1} id=${x.id} kind=${x.kind} ts=${new Date(x.ts).toISOString()} prevHash=${x.prevHash.slice(0, 12)}… payloadHash=${x.payloadHash.slice(0, 12)}… signed=${!!x.signature}`);
    }
    break;
  }
  cursor = computeHash(e.prevHash, e.payloadHash, e.kind);
}
