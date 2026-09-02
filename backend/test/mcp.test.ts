import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, say, fail, guard } from '../src/mcp/shared';

/** The MCP surface handles two things worth pinning: a private key, and the
 *  read/write boundary that lets the hosted endpoint be published without one. */

describe('mcp.shared: tool results', () => {
  it('pretty-prints data so a human reading the transcript can follow it', () => {
    const r = ok({ a: 1, b: 'two' });
    assert.equal(r.content[0]?.type, 'text');
    assert.match(r.content[0]?.text ?? '', /\n/); // indented, not minified
    assert.equal(r.isError, undefined);
  });

  it('passes prose through unchanged', () => {
    assert.equal(say('hello').content[0]?.text, 'hello');
  });

  // A stringified error without isError reads to the model as a successful call that
  // happened to return the word "Error", and it carries on as though the tool worked.
  it('marks failures as errors rather than returning them as prose', () => {
    const r = fail('indexer unreachable');
    assert.equal(r.isError, true);
    assert.match(r.content[0]?.text ?? '', /indexer unreachable/);
  });

  it('turns a thrown tool body into a visible error instead of killing the transport', async () => {
    const r = await guard(async () => {
      throw new Error('book read failed');
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0]?.text ?? '', /book read failed/);
  });

  it('returns a successful body untouched', async () => {
    const r = await guard(async () => ok({ fine: true }));
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]?.text ?? '', /fine/);
  });
});

describe('mcp.setup: wallet creation', () => {
  // createLocalWallet reads config at import time, so each case runs in its own
  // process with its own SOMNUS_ENV_PATH — never the real backend/.env.
  const runProbe = (env: Record<string, string>): { created: boolean; address: string; envPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'somnus-mcp-'));
    const envPath = join(dir, 'probe.env');
    const script = join(dir, 'probe.ts');
    writeFileSync(
      script,
      `import { createLocalWallet } from ${JSON.stringify(join(process.cwd(), 'src/mcp/setup.ts'))};\n` +
        'const r = createLocalWallet();\n' +
        'process.stdout.write("RESULT" + JSON.stringify({created:r.created,address:r.address,envPath:r.envPath}));\n',
      'utf8',
    );
    // Run under node with tsx as an import hook — the probe is TypeScript, and this
    // avoids depending on how npx resolves a shim binary per platform.
    const out = execFileSync(process.execPath, ['--import', 'tsx', script], {
      env: { ...process.env, SOMNUS_ENV_PATH: envPath, LOG_LEVEL: 'silent', ...env },
      encoding: 'utf8',
      timeout: 90_000,
    });
    const marker = out.indexOf('RESULT');
    assert.notEqual(marker, -1, `probe produced no result:\n${out}`);
    return JSON.parse(out.slice(marker + 'RESULT'.length).trim());
  };

  it('generates a wallet when none is configured, and writes safe defaults', () => {
    const r = runProbe({ TRADE_KEY: '', PRIVATE_KEY: '', OPERATOR_KEY: '' });
    assert.equal(r.created, true);
    assert.match(r.address, /^0x[0-9a-fA-F]{40}$/);

    const written = readFileSync(r.envPath, 'utf8');
    assert.match(written, /^TRADE_KEY=0x[0-9a-f]{64}$/m);
    // A freshly minted wallet must never come up armed for live trading.
    assert.match(written, /^DRY_RUN=true$/m);
    assert.match(written, /^AGENT_MODE=dry-run$/m);
  });

  it('never overwrites an existing key', () => {
    // Replacing a funded wallet's key orphans its balance and open positions with no
    // way back, so an existing key always wins.
    const key = `0x${'11'.repeat(32)}`;
    const r = runProbe({ TRADE_KEY: key, PRIVATE_KEY: '', OPERATOR_KEY: '' });
    assert.equal(r.created, false);
    // Derived from the supplied key, not invented.
    assert.match(r.address, /^0x[0-9a-fA-F]{40}$/);
    // And nothing was written at all — not an empty file, no file.
    assert.equal(existsSync(r.envPath), false, 'must not create an env file when a key exists');
  });
});
