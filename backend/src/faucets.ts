import { config } from './config';

/** Where to actually GET the native gas token, said everywhere it is needed.
 *
 *  This is the one step in onboarding that cannot be automated, and for a while it was
 *  also the one step with no instructions. Every gas check told the caller the number
 *  they were short and then left them to find a faucet themselves — "Somnia's public
 *  testnet faucet" with no link, for a chain most people have never used. The SDK
 *  mints COLLATERAL only, so no amount of server-side cleverness fixes it: somebody
 *  has to visit a faucet.
 *
 *  Written once, here, because the same guidance is owed from at least five places
 *  (first-time wallet creation, the collateral faucet, the per-user funder, the trade
 *  gate, and the wallet summary) and five copies drift. If a faucet dies, it dies in
 *  one file.                                                                      */

/** One place to claim STT, described by what a caller needs to know to choose. */
export interface Faucet {
  name: string;
  url: string;
  /** The distinguishing property, not marketing — what makes this one the right pick. */
  note: string;
}

/** Ordered best-first. Google leads because it is operated by Google Cloud rather than
 *  by a community volunteer, which in practice is the difference between a faucet that
 *  answers today and one that has quietly been dry for a month. Stakely is last of the
 *  three but the only one needing no account, which is exactly what somebody who does
 *  not want to sign in wants to hear. */
export const STT_FAUCETS: readonly Faucet[] = [
  {
    name: 'Google Cloud Web3 Faucet',
    url: 'https://cloud.google.com/application/web3/faucet/somnia/shannon',
    note: 'the one to try first — run by Google Cloud, sends STT straight to any EVM address',
  },
  {
    name: 'thirdweb Somnia Shannon',
    url: 'https://thirdweb.com/somnia-shannon-testnet',
    note: 'ecosystem partner, claims through the Somnia Shannon network page',
  },
  {
    name: 'Stakely multi-faucet',
    url: 'https://stakely.io/faucet/somnia-testnet-stt',
    note: 'no sign-in and no Google account — just a captcha',
  },
] as const;

/** For a bulk request the faucets will not cover. Named because "ask on Discord" with
 *  no channel and no person is advice that costs an hour. */
export const SOMNIA_DISCORD = {
  url: 'https://discord.com/invite/somnia',
  channel: '#dev-chat',
  devrel: '@emreyeth',
  note: 'for large amounts (stress testing), ask in #dev-chat and tag DevRel @emreyeth',
} as const;

/** Faucet instructions as prose, for an MCP tool result or an HTTP `message`.
 *
 *  Returns undefined on anything but testnet. There is no faucet for a real network,
 *  and printing testnet links beside a mainnet balance is worse than silence — it
 *  invites somebody to go looking for free money that does not exist.
 *
 *  @param address  Where the gas should land. Included because the single most common
 *                  way this goes wrong is funding the wrong wallet.
 *  @param needed   How much to ask for, in native units.
 *  @param code     Native token symbol, when the caller has read it from the chain. */
export function gasFaucetHelp(
  address?: string,
  needed?: number,
  code?: string,
): string | undefined {
  if (config.network !== 'testnet') return undefined;
  const token = code ?? 'STT';
  const amount = needed === undefined ? `some ${token}` : `about ${needed} ${token}`;
  const lines = [
    `HOW TO GET IT: claim ${amount} from any of these Somnia Shannon testnet faucets` +
      `${address ? `, sending it to ${address}` : ''} — they are free and take about a minute:`,
    '',
    ...STT_FAUCETS.map((f, i) => `  ${i + 1}. ${f.name} — ${f.note}\n     ${f.url}`),
    '',
    `  Need more than a faucet hands out? Ask in ${SOMNIA_DISCORD.channel} on the Somnia Discord ` +
      `and tag DevRel ${SOMNIA_DISCORD.devrel}: ${SOMNIA_DISCORD.url}`,
    '',
    `Any one of them is enough. Claim, wait for it to land, then try this again. STT pays ` +
      `GAS only — it is not the tUSDC you trade with, and the two are never interchangeable.`,
  ];
  return lines.join('\n');
}

/** Same content as structured data, for a JSON response or a UI that wants to render
 *  its own list rather than parse prose out of a message. */
export function gasFaucetLinks():
  | { faucets: Faucet[]; discord: typeof SOMNIA_DISCORD }
  | undefined {
  if (config.network !== 'testnet') return undefined;
  return { faucets: [...STT_FAUCETS], discord: SOMNIA_DISCORD };
}
