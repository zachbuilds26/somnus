import { Router } from 'express';
import {
  computeHash,
  count,
  currentAnchor,
  read,
  readAllFromDisk,
  signerAddress,
  verifyChain,
} from '../services/store';
import { verifyProofSignature } from '../services/proof';
import { lastAnchorInfo } from '../services/anchor';

export const proofRouter: Router = Router();

/** Latest audit entries, newest first. */
proofRouter.get('/proof', (req, res) => {
  const limit = clamp(req.query.limit, 250);
  res.json({ ok: true, anchor: currentAnchor(), total: count(), entries: read(limit).reverse() });
});

/** Last on-chain anchor of the proof chain head, when anchoring is enabled. */
proofRouter.get('/proof/anchor', (_req, res) => {
  res.json({ ok: true, anchor: lastAnchorInfo() });
});

/** Re-verify the hash chain. Default: whole chain from genesis.
 *  Alternative: { prevAnchor, entries } to verify an arbitrary slice.
 *
 *  Also asserts the recomputed head equals the anchor the server reports.
 *  Per-entry linkage alone is not enough: `verifyChain` derives each cursor from
 *  the entry's own `prevHash`, so a running anchor that has drifted out of step
 *  with the chain still passes every link while being wrong. Without this check
 *  the endpoint answers "ok" to a question nobody asked.                      */
proofRouter.post('/proof/verify', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { prevAnchor?: string; entries?: unknown[] };
    const isSlice = Array.isArray(body.entries) || typeof body.prevAnchor === 'string';
    const prev: string = typeof body.prevAnchor === 'string' ? body.prevAnchor : '0'.repeat(64);
    const all = readAllFromDisk();

    // Caller-supplied entries are untrusted. Anything without the fields the
    // verifier reads would throw mid-loop — and an async throw here is an
    // unhandled rejection that takes the whole process down.
    const slice = Array.isArray(body.entries)
      ? (body.entries.filter(isChainEntryLike) as typeof all)
      : all;
    const rejected = Array.isArray(body.entries) ? body.entries.length - slice.length : 0;

    const result = verifyChain(prev, slice);

    // Only meaningful for a full-chain verification.
    const reported = currentAnchor();
    const headMatches = isSlice ? undefined : result.anchor === reported;

    // Hash linkage proves nothing was reordered; signatures prove who wrote it.
    // Checking only linkage lets an "unsigned" or foreign-signed chain pass.
    const expected = signerAddress();
    let signaturesChecked = 0;
    let signaturesValid = 0;
    let unsigned = 0;
    for (const e of slice) {
      // Count unsigned entries whether or not a signer is configured. Counting
      // them only when one exists reports "unsignedEntries: 0" for a chain where
      // NOTHING is signed — which reads as "all good" rather than "unverifiable".
      if (typeof e.signature !== 'string' || e.signature.length === 0) {
        unsigned++;
        continue;
      }
      if (!expected) continue; // signed, but we have no address to check against
      signaturesChecked++;
      const proofHash = computeHash(e.prevHash, e.payloadHash, e.kind);
      if (await verifyProofSignature(proofHash, e.signature, expected)) signaturesValid++;
    }

    const signaturesOk = signaturesChecked === signaturesValid;
    res.json({
      ok: result.ok && headMatches !== false && signaturesOk,
      linkageOk: result.ok,
      headMatches,
      signer: expected,
      signaturesChecked,
      signaturesValid,
      signaturesOk,
      unsignedEntries: unsigned,
      // Be explicit rather than let a reader infer from zeros.
      signatureNote: expected
        ? undefined
        : 'no signing key configured — entries are hash-chained but not signed',
      malformedEntriesIgnored: rejected,
      anchor: result.anchor,
      reportedAnchor: reported,
      onChainAnchor: lastAnchorInfo(),
      checked: result.checked,
      total: count(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? String(err) });
  }
});

/** Minimal shape guard for an untrusted entry the verifier will hash. */
function isChainEntryLike(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.prevHash === 'string' &&
    typeof r.payloadHash === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.payload === 'object' &&
    r.payload !== null
  );
}

function clamp(n: unknown, max: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 1), max) : max;
}