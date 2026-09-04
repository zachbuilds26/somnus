import { Router } from 'express';
import {
  computeHash,
  count,
  currentAnchor,
  readAllFromDisk,
  readChainPage,
  signerAddress,
  verifyChain,
} from '../services/store';
import { verifyProofSignature } from '../services/proof';
import { lastAnchorInfo } from '../services/anchor';

export const proofRouter: Router = Router();

/** Latest audit entries, newest first.
 *
 *  Supports `kind`, `since`, `until` and `cursor` so a verifier or a dashboard can
 *  walk a range instead of downloading the chain to inspect one day of it. */
proofRouter.get('/proof', (req, res) => {
  const page = readChainPage({
    limit: clamp(req.query.limit, 250),
    kind: req.query.kind,
    since: req.query.since,
    until: req.query.until,
    cursor: req.query.cursor,
  });
  res.json({
    ok: true,
    anchor: currentAnchor(),
    total: count(),
    entries: page.entries,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    matched: page.matched,
  });
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
 *  the endpoint answers "ok" to a question nobody asked.
 *
 *  Reachable without the gateway key (see `KEY_EXEMPT_PATHS`), because "anyone can
 *  audit the chain" is the project's central claim and a POST that needs a secret
 *  does not deliver it. It is a POST only because it takes a body — it mutates
 *  nothing. The entry cap below is what makes that safe to expose.            */
const MAX_VERIFY_ENTRIES = 5_000;

proofRouter.post('/proof/verify', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { prevAnchor?: string; entries?: unknown[] };

    // Each entry costs an ECDSA recover, and this route takes no key. Without a
    // ceiling one unauthenticated request could pin a CPU for as long as it liked.
    if (Array.isArray(body.entries) && body.entries.length > MAX_VERIFY_ENTRIES) {
      res.status(413).json({
        ok: false,
        error:
          `${body.entries.length} entries exceeds the ${MAX_VERIFY_ENTRIES} per-request limit — ` +
          'each one costs a signature recovery. Verify in pages, or omit `entries` to have the ' +
          'server verify its own full chain from genesis.',
      });
      return;
    }

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