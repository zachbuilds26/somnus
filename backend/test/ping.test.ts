import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pingRouter, healthRouter } from '../src/routes/health';

/** The liveness endpoint an uptime monitor hits forever.
 *
 *  A free-tier container spins down when idle and takes ~50s to wake, which for a judge
 *  opening the URL cold is indistinguishable from broken. An external monitor pinging
 *  every few minutes prevents that — but it means this route is called on a schedule for
 *  as long as the service exists, so it must do NO work.
 *
 *  `/api/health` is the wrong target and it is worth pinning why: it calls
 *  `fetchSpotMarkets()` for indexer state, cached only 10 seconds, which a five-minute
 *  monitor misses every single time. Pointing a monitor at it turns a keep-awake into a
 *  permanent external request against someone else's API. Measured: 0.56s cold for health
 *  against 0.02-0.06s for ping.
 *
 *  These tests assert the SHAPE rather than spinning a server — the route is three lines
 *  and the properties worth guarding are structural: it is on its own router (so mounting
 *  it at two paths does not duplicate `/health`), and it reaches nothing. */

describe('ping: liveness with no dependencies', () => {
  it('is a separate router from health', () => {
    // If these were the same router, mounting at `/` and `/api` to give the monitor a
    // guessable URL would also expose the expensive `/health` at a second path.
    assert.notEqual(pingRouter, healthRouter);
  });

  it('registers exactly one route, and it is GET /ping', () => {
    const layers = (pingRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
    const routes = layers.filter((l) => l.route).map((l) => l.route!);
    assert.equal(routes.length, 1, 'ping router should carry one route only');
    assert.equal(routes[0]!.path, '/ping');
    assert.equal(routes[0]!.methods.get, true);
  });

  it('answers without touching the chain, the RPC or any external API', () => {
    // Asserted by reading the handler source: a route that grows an `await` stops being a
    // liveness check and becomes a dependency on whatever it started awaiting. This is
    // crude on purpose — it fails loudly if somebody adds real work here later.
    const layers = (pingRouter as unknown as { stack: Array<{ route?: { stack: Array<{ handle: unknown }> } }> }).stack;
    const handler = layers.find((l) => l.route)?.route?.stack[0]?.handle;
    const src = String(handler);
    assert.ok(!/await|Promise|fetch|readFile|rpcCall/.test(src), `ping handler does work: ${src}`);
    assert.ok(src.includes('uptime'), 'ping should report uptime');
  });
});
