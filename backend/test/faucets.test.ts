import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config';
import { gasFaucetHelp, gasFaucetLinks, STT_FAUCETS, SOMNIA_DISCORD } from '../src/faucets';

/** Where to actually GET gas — the one onboarding step nobody can automate.
 *
 *  The SDK's faucet mints COLLATERAL only, so a new wallet cannot bootstrap itself: a
 *  human has to visit a faucet. For a while every gas check named the shortfall and
 *  then said "Somnia's public testnet faucet" with no link, for a chain most people
 *  have never used — which turns a one-minute step into a search.
 *
 *  Pinned here rather than left to prose because this text is emitted from six places
 *  (first-run wallet creation, the collateral funder, the per-user funder, the trade
 *  gate, the wallet summary, and the agent's own affordability check) and the whole
 *  point of one helper is that they cannot drift apart. */

describe('faucets: the guidance itself', () => {
  it('names every faucet with a working-looking https URL', () => {
    assert.ok(STT_FAUCETS.length >= 3, 'want more than one option — faucets go dry');
    for (const f of STT_FAUCETS) {
      assert.match(f.url, /^https:\/\//);
      assert.ok(f.name.length > 0);
      // A bare list of three links makes somebody pick at random. Each has to say what
      // distinguishes it, or the ordering is the only signal and that is not enough.
      assert.ok(f.note.length > 10, `${f.name} needs a reason to pick it`);
    }
  });

  it('leads with the Google Cloud faucet', () => {
    // Deliberate ordering: run by Google Cloud rather than a community volunteer, which
    // in practice is the difference between answering today and having been dry a month.
    assert.match(STT_FAUCETS[0]!.url, /cloud\.google\.com/);
  });

  it('offers a route for more than a faucet hands out', () => {
    // "Ask on Discord" with no channel and no person costs an hour.
    assert.match(SOMNIA_DISCORD.url, /^https:\/\/discord/);
    assert.equal(SOMNIA_DISCORD.channel, '#dev-chat');
    assert.match(SOMNIA_DISCORD.devrel, /^@/);
  });
});

describe('faucets: the prose a caller reads', () => {
  it('includes every link, so no option is buried in the structured field only', () => {
    const help = gasFaucetHelp('0xabc', 0.7, 'STT') ?? '';
    for (const f of STT_FAUCETS) assert.ok(help.includes(f.url), `missing ${f.url}`);
    assert.ok(help.includes(SOMNIA_DISCORD.url));
  });

  it('names the amount and the address to send it to', () => {
    // Funding the wrong wallet is the single most common way this goes wrong, so the
    // destination travels with the instruction rather than a paragraph away.
    const help = gasFaucetHelp('0xC2187C19', 0.7, 'STT') ?? '';
    assert.match(help, /0\.7 STT/);
    assert.match(help, /0xC2187C19/);
  });

  it('still reads as a sentence with no address or amount known', () => {
    // `somnus_my_wallet` prints the address itself, so repeating it would be noise.
    const help = gasFaucetHelp() ?? '';
    assert.match(help, /some STT/);
    assert.doesNotMatch(help, /undefined/);
    assert.doesNotMatch(help, /about undefined/);
  });

  it('warns that gas is not the trading token', () => {
    // Two assets, not interchangeable, and confusing them is why people report "I have
    // 10,000 tUSDC and it still will not trade".
    const help = gasFaucetHelp('0xabc', 0.7, 'STT') ?? '';
    assert.match(help, /GAS only/);
    assert.match(help, /tUSDC/);
  });

  it('uses the chain\'s own token symbol when one was read', () => {
    assert.match(gasFaucetHelp('0xabc', 1, 'SOMI') ?? '', /1 SOMI/);
  });
});

describe('faucets: never on a real network', () => {
  const saved = config.network;
  after(() => {
    config.network = saved;
  });

  it('says nothing at all on mainnet', () => {
    // Worse than silence: printing testnet faucet links next to a mainnet balance
    // invites somebody to go hunting for free money that does not exist.
    config.network = 'mainnet';
    assert.equal(gasFaucetHelp('0xabc', 0.7, 'SOMI'), undefined);
    assert.equal(gasFaucetLinks(), undefined);
  });

  it('returns to giving guidance on testnet', () => {
    config.network = 'testnet';
    assert.ok(gasFaucetHelp('0xabc', 0.7, 'STT'));
    assert.equal(gasFaucetLinks()?.faucets.length, STT_FAUCETS.length);
  });
});

describe('faucets: the structured form matches the prose', () => {
  it('exposes the same links a UI would need to render its own buttons', () => {
    const links = gasFaucetLinks();
    assert.ok(links);
    assert.deepEqual(
      links.faucets.map((f) => f.url),
      STT_FAUCETS.map((f) => f.url),
    );
    assert.equal(links.discord.url, SOMNIA_DISCORD.url);
  });

  it('hands back a copy, so a caller cannot mutate the shared list', () => {
    const links = gasFaucetLinks();
    links?.faucets.pop();
    assert.equal(gasFaucetLinks()?.faucets.length, STT_FAUCETS.length);
  });
});
