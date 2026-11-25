import type { SiteBundle } from './pack.js';

export const CREDITS_PER_DASH = 100_000_000_000n;

/**
 * Measured on testnet, protocol 14: a chunk of 100 bytes cost 26.5 M credits and one of 14,700
 * bytes 427 to 431 M; creating a site record cost about 59 M. The constants round those up.
 */
const CREDITS_PER_BYTE = 27_500n;
const CREDITS_PER_CHUNK = 28_000_000n;
const CREDITS_PER_SITE_RECORD = 60_000_000n;

/** Upper estimate, in credits, of publishing `hashes` (the chunks not stored yet) and the site record. */
export function estimateCredits(bundle: SiteBundle, missing: Iterable<string> = bundle.chunks.keys()): bigint {
  let total = CREDITS_PER_SITE_RECORD;
  for (const hash of missing) {
    const chunk = bundle.chunks.get(hash);
    if (chunk) total += CREDITS_PER_CHUNK + CREDITS_PER_BYTE * BigInt(chunk.length);
  }
  return total;
}

export function formatDash(credits: bigint): string {
  const negative = credits < 0n;
  const abs = negative ? -credits : credits;
  const whole = abs / CREDITS_PER_DASH;
  const fraction = (abs % CREDITS_PER_DASH).toString().padStart(11, '0').slice(0, 5);
  return `${negative ? '-' : ''}${whole}.${fraction} DASH`;
}

/** Platform's storage price (protocol 14). A delete returns it, less what was already paid out. */
export const STORAGE_CREDITS_PER_BYTE = 27_000n;

/**
 * Platform pays a storage fee out to masternodes over 50 eras of 40 epochs, each era's share split
 * evenly over its epochs (rs-dpp `FEE_DISTRIBUTION_TABLE`), in units of 1/100,000.
 */
const ERA_SHARES = [
  5000, 4800, 4600, 4400, 4200, 4000, 3850, 3700, 3550, 3400, 3250, 3100, 2950, 2850, 2750, 2650, 2550, 2450, 2350, 2250,
  2150, 2050, 1950, 1875, 1800, 1725, 1650, 1575, 1500, 1425, 1350, 1275, 1200, 1125, 1050, 975, 900, 825, 750, 675,
  600, 525, 475, 425, 375, 325, 275, 225, 175, 125,
];
const EPOCHS_PER_ERA = 40;

/**
 * Credits a delete returns for `bytes` stored `epochs` epochs earlier: the storage fee less the
 * shares of the epochs from the one it was stored in to the current one, inclusive. An epoch is
 * 9.125 days on mainnet (40 a year) and one hour on testnet. Overhead bytes Platform adds per
 * document are not counted, so this is a lower bound.
 */
export function refundCredits(bytes: number, epochs = 0): bigint {
  let paidOut = 0n;
  for (let epoch = 0; epoch <= epochs && epoch < ERA_SHARES.length * EPOCHS_PER_ERA; epoch++) {
    paidOut += BigInt(ERA_SHARES[Math.floor(epoch / EPOCHS_PER_ERA)] as number);
  }
  const total = 100_000n * BigInt(EPOCHS_PER_ERA);
  return (STORAGE_CREDITS_PER_BYTE * BigInt(bytes) * (total - paidOut)) / total;
}
