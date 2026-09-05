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
 *  nothing.
 *
 *  ── Why there are THREE limits and not one ──────────────────────────────────
 *
 *  Opening this route without also bounding its cost was a denial of service, and a
 *  measured one rather than a theoretical one: an empty body means "verify everything",
 *  which was 2,799 ECDSA public-key recoveries at ~36ms each — 78 seconds of CPU on the
 *  live free instance, from one unauthenticated request, growing with the chain forever.
 *  `MAX_VERIFY_ENTRIES` did not help, because it only ever bounded CALLER-SUPPLIED
 *  slices; omitting `entries` skipped it entirely.
 *
 *  So: linkage is cheap and always runs over everything (1.2s for 2,885 entries, and
 *  it is the primary guarantee). Signature recovery is the expensive half, so it is
 *  bounded per request and the response says exactly how many were checked and how to
 *  check the rest. And the whole result is cached against the chain head, so repeated
 *  requests — the actual attack — cost nothing at all, while a genuine auditor after
 *  the next append still gets a fresh answer.                                      */
const MAX_VERIFY_ENTRIES = 5_000;

/** Signature recoveries any ONE request may spend, whatever it asks for.
 *
 *  Most recent first: a reader checking whether the chain is honest cares far more
 *  about the entries written since they last looked than about entry 12 from August.
 *  Everything else stays reachable through `prevAnchor`/`entries` paging. */
const MAX_SIGNATURE_CHECKS = Number(process.env.SOMNUS_MAX_SIGNATURE_CHECKS ?? 400);

/** Full-chain verification is deterministic for a given head, so it is worth computing
 *  once. Keyed on the anchor AND the entry count: the anchor alone would be enough in
 *  practice, but two keys make a stale hit impossible rather than merely unlikely, and
 *  the cost of being wrong here is reporting a verification that never happened. */
let verifyCache: { anchor: string; entries: number; body: Record<string, unknown> } | undefined;

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
        note:
          'the request body is also capped at 1mb by the JSON parser, which at ~866 bytes ' +
          'per entry binds first at roughly 1,200 entries',
      });
      return;
    }

    const isSlice = Array.isArray(body.entries) || typeof body.prevAnchor === 'string';

    // Serve a cached full-chain answer when the chain has not moved. Only for the
    // default request: a caller-supplied slice is a different question every time.
    if (!isSlice && verifyCache) {
      const anchorNow = currentAnchor();
      if (verifyCache.anchor === anchorNow && verifyCache.entries === count()) {
        res.json({ ...verifyCache.body, cached: true });
        return;
      }
    }

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
    //
    // Linkage above covered every entry — it is cheap. Signature recovery is not, so it
    // runs over the most recent `MAX_SIGNATURE_CHECKS` and no further. Newest first,
    // because a reader asking whether this chain is honest cares about what was written
    // since they last looked, not about entry 12 from August; the rest stays reachable
    // by paging with `prevAnchor`/`entries`.
    const expected = signerAddress();
    let signaturesChecked = 0;
    let signaturesValid = 0;
    let unsigned = 0;
    let signaturesSkipped = 0;
    for (let i = slice.length - 1; i >= 0; i--) {
      const e = slice[i]!;
      // Count unsigned entries whether or not a signer is configured. Counting
      // them only when one exists reports "unsignedEntries: 0" for a chain where
      // NOTHING is signed — which reads as "all good" rather than "unverifiable".
      if (typeof e.signature !== 'string' || e.signature.length === 0) {
        unsigned++;
        continue;
      }
      if (!expected) continue; // signed, but we have no address to check against
      if (signaturesChecked >= MAX_SIGNATURE_CHECKS) {
        signaturesSkipped++;
        continue;
      }
      signaturesChecked++;
      const proofHash = computeHash(e.prevHash, e.payloadHash, e.kind);
      if (await verifyProofSignature(proofHash, e.signature, expected)) signaturesValid++;
    }

    const signaturesOk = signaturesChecked === signaturesValid;
    const payload: Record<string, unknown> = {
      // `ok` deliberately does NOT claim more than was done. Linkage covered everything;
      // signatures covered a bounded window, and `signaturesSkipped` says how much was
      // left. Reporting ok:true while silently skipping 2,400 recoveries would be the
      // same class of lie this whole route exists to prevent.
      ok: result.ok && headMatches !== false && signaturesOk,
      linkageOk: result.ok,
      headMatches,
      signer: expected,
      signaturesChecked,
      signaturesValid,
      signaturesOk,
      ...(signaturesSkipped > 0
        ? {
            signaturesSkipped,
            signatureCoverage:
              `signatures were verified over the most recent ${signaturesChecked} signed ` +
              `entries; ${signaturesSkipped} older ones were not checked in this request. ` +
              'Linkage covered all ' +
              `${result.checked}. Page through the rest with {prevAnchor, entries}, or raise ` +
              'SOMNUS_MAX_SIGNATURE_CHECKS on a host that can afford it — each check is an ' +
              'ECDSA recovery at roughly 36ms.',
          }
        : {}),
      unsignedEntries: unsigned,
      // Be explicit rather than let a reader infer from zeros — and say WHICH of the two
      // reasons applies. "not signed" was previously printed whenever no signer was
      // configured, which is false for a chain whose entries carry signatures this
      // server simply has no address to check. Set SOMNUS_PROOF_SIGNER to check them.
      signatureNote: expected
        ? undefined
        : slice.some((e) => typeof e.signature === 'string' && e.signature.length > 0)
          ? 'this chain IS signed, but no signer address is configured here to verify against — ' +
            'set SOMNUS_PROOF_SIGNER to the expected address (an address grants no authority)'
          : 'no signing key configured and no entry carries a signature — this chain is ' +
            'hash-linked only',
      malformedEntriesIgnored: rejected,
      anchor: result.anchor,
      reportedAnchor: reported,
      onChainAnchor: lastAnchorInfo(),
      checked: result.checked,
      total: count(),
    };
    // Cache only the default question, and only once it is fully answered.
    if (!isSlice) verifyCache = { anchor: reported, entries: count(), body: payload };
    res.json(payload);
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