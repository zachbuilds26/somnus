#!/usr/bin/env tsx
/** One-off repair (2026-08-25): a stale-writer process appended entry #825
 *  with an out-of-date prevHash, disconnecting entries 825+ from the verified
 *  824-entry prefix. This script:
 *    1. backs up the whole file,
 *    2. archives the stale-linked tail verbatim,
 *    3. truncates to the healthy prefix,
 *    4. re-appends the exact same payloads so they link freshly and re-sign,
 *    5. verifies the repaired chain end-to-end.
 *  Idempotence: refuses to run if the file does not break exactly where expected.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../src/config';

const CHAIN_FILE = join(DATA_DIR, 'proof-chain.jsonl');
const GENESIS = '0'.repeat(64);
const EXPECTED_BREAK_AT = 824; // 1-based index of last GOOD entry

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const computeHash = (prev: string, payloadHash: string, kind: string) =>
  sha(prev + payloadHash + kind);

interface Entry {
  id: string; ts: number; prevHash: string; payloadHash: string;
  signature?: string; kind: 'decision' | 'order' | 'claim' | 'config';
  payload: Record<string, unknown>;
}

if (!existsSync(CHAIN_FILE)) throw new Error('no chain file');

const lines = readFileSync(CHAIN_FILE, 'utf8')
  .split('\n').filter((l) => l.trim() !== '');
console.log(`file has ${lines.length} entries`);

// Walk the prefix, confirming it breaks exactly after EXPECTED_BREAK_AT.
let cursor = GENESIS;
for (let i = 0; i < lines.length; i++) {
  const e = JSON.parse(lines[i]) as Entry;
  if (e.prevHash !== cursor) {
    if (i !== EXPECTED_BREAK_AT) {
      throw new Error(`chain breaks at entry ${i + 1}, expected ${EXPECTED_BREAK_AT + 1} — refusing`);
    }
    console.log(`break confirmed at entry ${i + 1} (id=${e.id}) as expected`);
    break;
  }
  cursor = computeHash(e.prevHash, e.payloadHash, e.kind);
}
if (cursor !== 'e569d3631df08eda538a79966cbc842dc118f342b974230f9333cc58e444e60c') {
  throw new Error(`prefix head ${cursor} is not the expected e569d363… — refusing`);
}
console.log(`prefix of ${EXPECTED_BREAK_AT} entries verified, head e569d363…`);

// 1. backup, 2. archive tail verbatim, 3. truncate.
copyFileSync(CHAIN_FILE, join(DATA_DIR, 'proof-chain.backup-prerepair-2026-08-25.jsonl'));
const tailLines = lines.slice(EXPECTED_BREAK_AT);
writeFileSync(
  join(DATA_DIR, 'proof-chain.stale-tail-archive-2026-08-25.jsonl'),
  tailLines.join('\n') + '\n',
  'utf8',
);
writeFileSync(CHAIN_FILE, lines.slice(0, EXPECTED_BREAK_AT).join('\n') + '\n', 'utf8');
console.log(`archived ${tailLines.length} tail entries verbatim; file truncated to healthy prefix`);

// 4. re-append the same payloads. Import AFTER truncation so the module
// restores the now-healthy chain and continues from its true head.
const { appendEntry, currentAnchor } = await import('../src/services/store');
if (currentAnchor() !== 'e569d3631df08eda538a79966cbc842dc118f342b974230f9333cc58e444e60c') {
  throw new Error(`store restored unexpected anchor ${currentAnchor()} — refusing to append`);
}
for (const line of tailLines) {
  const e = JSON.parse(line) as Entry;
  const node = await appendEntry({ kind: e.kind, payload: e.payload });
  console.log(`re-chained ${e.kind} (was ${e.id} → now ${node.id})`);
}

// 5. verify everything from disk, fresh parse.
const verifyLines = readFileSync(CHAIN_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
let vcursor = GENESIS;
let ok = true;
for (const l of verifyLines) {
  const e = JSON.parse(l) as Entry;
  if (e.prevHash !== vcursor) { ok = false; console.log(`LINKAGE FAIL at ${e.id}`); break; }
  vcursor = computeHash(e.prevHash, e.payloadHash, e.kind);
}
console.log(`\nrepaired chain: ${verifyLines.length} entries, linkage ${ok ? 'OK' : 'BROKEN'}, head ${vcursor}`);
if (!ok) process.exitCode = 1;
process.exit(process.exitCode ?? 0);
