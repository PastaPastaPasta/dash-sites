import type { SiteBundle } from './pack.js';

export const CREDITS_PER_DASH = 100_000_000_000n;

/** Measured on protocol 14: storage and processing per stored byte, and the fixed part of one chunk document. */
const CREDITS_PER_BYTE = 27_700n;
const CREDITS_PER_CHUNK = 140_000_000n;
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
