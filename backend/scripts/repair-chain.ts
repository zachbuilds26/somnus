#!/usr/bin/env tsx
/**
 * Repair one forked proof-chain tail while preserving the original evidence.
 *
 * Usage:
 *   npx tsx scripts/repair-chain.ts --dry-run   # inspect only
 *   npx tsx scripts/repair-chain.ts --apply     # archive and rebuild
 *
 * The script refuses to alter a healthy chain. On apply it:
 *  1. creates a timestamped immutable backup of the whole original JSONL file;
 *  2. archives the invalid tail verbatim;
 *  3. rebuilds that tail from the verified prefix with fresh hash links,
 *     entry IDs, and signatures; and
 *  4. verifies the resulting chain, including signatures when a key is set.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DATA_DIR } from '../src/config';
import { createConfiguredSigner, verifyProofSignature } from '../src/services/proof';

const CHAIN_FILE = join(DATA_DIR, 'proof-chain.jsonl');
const GENESIS = '0'.repeat(64);
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

if ((apply && args.has('--dry-run')) || (!apply && !args.has('--dry-run'))) {
  throw new Error('use exactly one mode: --dry-run or --apply');
}
if (!existsSync(CHAIN_FILE)) throw new Error(`proof chain not found: ${CHAIN_FILE}`);

interface Entry {
  id: string;
  ts: number;
  prevHash: string;
  payloadHash: string;
  signature?: string;
  kind: 'decision' | 'order' | 'claim' | 'config';
  payload: Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(',')}}`;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const payloadHash = (payload: unknown) => sha256(canonicalJson(payload));
const legacyPayloadHash = (payload: unknown) => sha256(JSON.stringify(payload));
const proofHash = (prevHash: string, hash: string, kind: string) => sha256(prevHash + hash + kind);

function payloadMatches(entry: Entry): boolean {
  return entry.payloadHash === payloadHash(entry.payload) || entry.payloadHash === legacyPayloadHash(entry.payload);
}

function readEntries(): Entry[] {
  const entries: Entry[] = [];
  for (const [index, line] of readFileSync(CHAIN_FILE, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Entry;
      if (
        typeof entry.id !== 'string' ||
        typeof entry.prevHash !== 'string' ||
        typeof entry.payloadHash !== 'string' ||
        typeof entry.kind !== 'string' ||
        !entry.payload ||
        typeof entry.payload !== 'object'
      ) {
        throw new Error('missing required fields');
      }
      entries.push(entry);
    } catch (error) {
      throw new Error(`invalid proof-chain entry at line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return entries;
}

function firstBreak(entries: Entry[]): { index: number; expected: string; reason: string } | undefined {
  let cursor = GENESIS;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!payloadMatches(entry)) return { index, expected: cursor, reason: 'payload hash mismatch' };
    if (entry.prevHash !== cursor) return { index, expected: cursor, reason: 'prevHash mismatch' };
    cursor = proofHash(entry.prevHash, entry.payloadHash, entry.kind);
  }
  return undefined;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function verify(entries: Entry[], signerAddress?: string): Promise<{ ok: boolean; head: string; badAt?: number; signaturesValid: number; unsigned: number }> {
  let cursor = GENESIS;
  let signaturesValid = 0;
  let unsigned = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!payloadMatches(entry) || entry.prevHash !== cursor) {
      return { ok: false, head: cursor, badAt: index + 1, signaturesValid, unsigned };
    }
    if (!entry.signature) {
      unsigned++;
    } else if (signerAddress && (await verifyProofSignature(proofHash(entry.prevHash, entry.payloadHash, entry.kind), entry.signature, signerAddress))) {
      signaturesValid++;
    } else if (signerAddress) {
      return { ok: false, head: cursor, badAt: index + 1, signaturesValid, unsigned };
    }
    cursor = proofHash(entry.prevHash, entry.payloadHash, entry.kind);
  }
  return { ok: true, head: cursor, signaturesValid, unsigned };
}

const entries = readEntries();
const broken = firstBreak(entries);
if (!broken) {
  console.log(`proof chain is healthy: ${entries.length} entries, no repair needed`);
  process.exit(0);
}
if (broken.index === 0) {
  throw new Error(`first entry is invalid (${broken.reason}); refusing to rebuild without a verified prefix`);
}

const prefix = entries.slice(0, broken.index);
const tail = entries.slice(broken.index);
const prefixVerification = await verify(prefix);
if (!prefixVerification.ok) throw new Error(`verified prefix unexpectedly fails at entry ${prefixVerification.badAt}`);

console.log(`proof chain: ${entries.length} entries`);
console.log(`verified prefix: ${prefix.length} entries, head ${prefixVerification.head}`);
console.log(`invalid tail: ${tail.length} entries, begins at #${broken.index + 1} (${tail[0]!.id})`);
console.log(`break reason: ${broken.reason}; stored prevHash=${tail[0]!.prevHash}; expected=${broken.expected}`);

if (!apply) {
  console.log('\ndry run only — no files were changed');
  process.exit(0);
}

const signer = createConfiguredSigner();
if (!signer) {
  throw new Error('no proof signing key configured; refusing to rebuild a signed audit trail unsigned');
}

mkdirSync(DATA_DIR, { recursive: true });
const suffix = stamp();
const backupFile = join(DATA_DIR, `proof-chain.backup-before-repair-${suffix}.jsonl`);
const archiveFile = join(DATA_DIR, `proof-chain.forked-tail-archive-${suffix}.jsonl`);
const manifestFile = join(DATA_DIR, `proof-chain.repair-${suffix}.json`);

copyFileSync(CHAIN_FILE, backupFile);
writeFileSync(archiveFile, `${tail.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

let cursor = prefixVerification.head;
const repairedTail: Entry[] = [];
for (const original of tail) {
  const hash = payloadHash(original.payload);
  const hashForChain = original.payloadHash === hash ? hash : hash;
  const currentProofHash = proofHash(cursor, hashForChain, original.kind);
  const signature = await signer.sign(currentProofHash);
  const entry: Entry = {
    id: `somnus-repair-${randomBytes(6).toString('hex')}`,
    ts: original.ts,
    prevHash: cursor,
    payloadHash: hashForChain,
    signature,
    kind: original.kind,
    payload: original.payload,
  };
  repairedTail.push(entry);
  cursor = currentProofHash;
}

const repaired = [...prefix, ...repairedTail];
const repairedVerification = await verify(repaired, signer.address);
if (!repairedVerification.ok) {
  throw new Error(`rebuilt chain failed verification at ${repairedVerification.badAt ?? 'unknown entry'}; active file left untouched`);
}
if (repairedVerification.unsigned > 0) {
  console.warn(`warning: ${repairedVerification.unsigned} historical entries are hash-linked but unsigned`);
}

writeFileSync(CHAIN_FILE, `${repaired.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
writeFileSync(
  manifestFile,
  `${JSON.stringify(
    {
      repairedAt: new Date().toISOString(),
      sourceFile: CHAIN_FILE,
      backupFile,
      archivedForkedTail: archiveFile,
      verifiedPrefixEntries: prefix.length,
      rebuiltEntries: repairedTail.length,
      originalBreak: {
        entryNumber: broken.index + 1,
        entryId: tail[0]!.id,
        reason: broken.reason,
        expectedPrevHash: broken.expected,
        storedPrevHash: tail[0]!.prevHash,
      },
      repairedHead: repairedVerification.head,
      signer: signer.address,
      signaturesValid: repairedVerification.signaturesValid,
      unsignedEntries: repairedVerification.unsigned,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log('\nrepair complete');
console.log(`backup: ${backupFile}`);
console.log(`archived tail: ${archiveFile}`);
console.log(`manifest: ${manifestFile}`);
console.log(`verified: ${repaired.length} entries, ${repairedVerification.signaturesValid} signatures, head ${repairedVerification.head}`);
