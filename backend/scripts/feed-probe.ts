import { closeAndExit, spotPrice } from '../src/services/sdk';

/** Smallest possible "can this process see prices at all" check.
 *
 *  Reads one spot price per asset and prints it, so a feed problem can be separated
 *  from a strategy problem without starting the agent. Read-only: no key, no orders. */
async function main(): Promise<void> {
  for (const asset of ['BTC', 'ETH']) {
    try {
      console.log(asset, await spotPrice(asset));
    } catch (e: unknown) {
      console.log(asset, 'ERROR:', (e as Error).message ?? String(e));
    }
  }
}

void main()
  .then(() => closeAndExit(0))
  .catch((e: unknown) => {
    console.error('fatal:', (e as Error).message ?? String(e));
    process.exit(1);
  });
