/** Test preload: point the store at a throwaway data dir BEFORE any module
 *  reads DATA_DIR at import time.
 *
 *  Without this, `npm test` appends its fixtures to backend/data/proof-chain.jsonl
 *  — polluting the real audit trail with synthetic entries and making the demo
 *  chain fail verification. Loaded via `tsx --import`, so it runs before the
 *  test modules and therefore before config.ts is evaluated. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'somnus-test-'));
// Tests must never be able to send an order, whatever else they set up.
process.env.DRY_RUN = 'true';
process.env.AGENT_MODE = 'dry-run';
process.env.LOG_LEVEL = 'silent';
// Operator .env knobs that change WHICH windows are tradeable would break the
// horizon tests' expectations of the built-in fallback ladder. Deleting them
// is not enough — config.ts's dotenv load runs after this file and would set
// them right back — so pin the documented defaults explicitly.
process.env.AGENT_MAX_HORIZON_SEC = '86400';
process.env.AGENT_MIN_EXPIRY_SEC = '75';
process.env.AGENT_PROVISIONAL_SLOTS = '4';
// Same reasoning, one level out: `calibration.seed.json` is committed so a fresh DEPLOY
// starts from measured tiers instead of constants. That would also satisfy every test
// written to exercise the built-in fallback, quietly turning them into tests of the seed.
// Point it at a path that cannot exist, so "no study run" means what it says here.
// `calibration-seed.test.ts` reads the real file directly and is unaffected.
process.env.SOMNUS_CALIBRATION_SEED = join(tmpdir(), 'somnus-no-such-calibration-seed.json');
delete process.env.FAIR_OVERRIDE_BTC;
delete process.env.FAIR_OVERRIDE_ETH;
