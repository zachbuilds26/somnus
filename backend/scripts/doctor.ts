#!/usr/bin/env tsx
/** Somnus doctor — read-only environment + connectivity probe.
 *  No transactions, no keys required for REST checks.                        */
import { config } from '../src/config';
import { effectiveDryRun, loadAgentConfig } from '../src/agent-config';
import { fetchSpotMarkets } from '../src/services/markets';
import { listEventMarkets, eventBook, getExchange, closeAndExit } from '../src/services/sdk';
import { calibrationSummary } from '../src/services/horizon';
import { currentAnchor, count } from '../src/services/store';

const tick = (ok: boolean, label: string, extra = ''): void => {
  console.log(`${ok ? '✔' : '✖'} ${label}${extra ? ` — ${extra}` : ''}`);
};

/** Config echo, not a probe: nothing on this line was contacted. Ticking these
 *  green implied connectivity that was never checked — a wrong RPC URL passed
 *  the doctor right up until a real read failed. */
const unprobed = (label: string): void => {
  console.log(`○ ${label} (configured, not probed)`);
};

async function main(): Promise<void> {
  console.log('\n== Somnus doctor ==');
  unprobed(`network ${config.network} (chain ${config.chainId})`);
  unprobed(`rpc ${config.rpcUrl}`);
  unprobed(`rest ${config.restUrl}`);
  unprobed(`indexer (graphql) ${config.indexerUrl}`);
  tick(dryRun, `DRY_RUN ${dryRun}`, dryRun ? '(safe: no real orders)' : '⚠ real orders possible — keep tiny!');
  tick(Boolean(config.venueId), `VENUE_ID configured`, config.venueId ? '' : '(optional: unset reads every venue)');
  tick(key, `trade key present`, key ? '' : '(not needed for reads)');
  tick(true, `proof anchor ${currentAnchor().slice(0, 12)}… entries ${count()}`);
  console.log(`   rules: maxTradeSize=${rules.maxTradeSize} minEdge=${rules.minEdge} ` +
    `maxOpen=${rules.maxOpenPositions} symbols=${rules.symbols.join(',') || '(all)'} mode=${rules.mode}`);

  console.log('\n== REST market check ==');
  try {
    const spot = await fetchSpotMarkets();
    tick(spot.length > 0, `spot markets ${spot.length}`);
    for (const m of spot.slice(0, 3)) {
      console.log(`   • ${m.symbol}  lot=${m.lotSize} tick=${m.tickSize} contract=${m.contract.slice(0, 12)}…`);
    }
  } catch (err) {
    tick(false, 'spot markets', (err as Error).message);
  }

  console.log('\n== SDK / Event Contracts (keyless reads) ==');
  try {
    const ex = getExchange();
    tick(true, 'SDK exchange constructed (read-only, no key)');
    const markets = await listEventMarkets();
    tick(markets.length > 0, `event markets ${markets.length}`);
    if (markets[0]) {
      const b = await eventBook(markets[0].symbol, 5);
      console.log(`   first: ${markets[0].symbol}`);
      console.log(`   book: bid=${b.bid ?? '-'} ask=${b.ask ?? '-'} mid=${b.mid?.toFixed(4) ?? '-'}`);
    }
    void ex;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    tick(false, 'SDK / Event Contracts', msg);
  }

  console.log('\n== horizon calibration (which window classes it will trade) ==');
  try {
    const cal = calibrationSummary();
    // Three genuinely different claims: this deployment's own measurements,
    // a committed seeded study (real numbers, but not this venue's own), or
    // constants with no measurement behind them. Collapsing them misreports
    // the evidence in both directions.
    const when = cal.generatedAt?.slice(0, 10) ?? 'unknown date';
    if (cal.source === 'measured') {
      tick(true, `verdicts measured on ${cal.windowsScored} settled windows (${when}) — this deployment's own study`);
    } else if (cal.source === 'seeded') {
      tick(
        true,
        `verdicts from the committed seeded study (${cal.windowsScored} windows, ${when}) — real measurements, not this deployment's`,
        'run `npm run horizon-study` to measure this venue',
      );
    } else {
      tick(
        false,
        'no study run yet — using built-in defaults',
        'run `npm run horizon-study` to measure this venue and widen the ladder',
      );
    }
    for (const c of cal.classes) {
      const mark = c.tier === 'validated' ? 'x' : c.tier === 'provisional' ? '~' : ' ';
      console.log(`   [${mark}] ${c.class.padStart(4)}  ${c.tier.padEnd(11)} ${c.note}`);
    }
    console.log(
      `   provisional classes trade at ${cal.provisionalEdgeMultiplier}x edge / ` +
        `${cal.provisionalSizeMultiplier}x size, ${cal.provisionalSlotsPerCycle} slot(s) per cycle`,
    );
  } catch (err) {
    tick(false, 'horizon calibration', (err as Error).message ?? String(err));
  }

  console.log(
    '\nDone. Reads need no key. If event markets are empty, check NETWORK and that\n' +
      'INDEXER_URL points at the GraphQL endpoint (not the REST base).\n',
  );
}

const key = Boolean(config.privateKey || config.tradeKey || config.operatorKey);
const rules = loadAgentConfig();
const dryRun = effectiveDryRun(rules);


void main()
  .then(() => closeAndExit(0))
  .catch(async (err) => {
    console.error(`\ndoctor failed: ${(err as Error).message ?? err}\n`);
    await closeAndExit(1);
  });
