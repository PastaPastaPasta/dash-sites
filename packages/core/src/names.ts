export const DASH_TLD = 'dash';

const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]$/;

/**
 * A DPNS label this project serves. DPNS itself also allows labels with `--` in the third and
 * fourth position (`xn--…`); browsers render those as Unicode, so they are refused here.
 */
export function isValidLabel(label: string): boolean {
  return label.length >= 3 && label.length <= 63 && LABEL.test(label) && label.slice(2, 4) !== '--';
}

/** DPNS homograph-safe form: lowercase, then o to 0 and i, l to 1. */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/o/g, '0').replace(/[il]/g, '1');
}

export interface ParsedName {
  /** The label as typed, lowercased. */
  label: string;
  /** The DPNS normalizedLabel. */
  normalized: string;
}

/** Parses a name taken from a URL path segment, which may be percent-encoded. */
export function nameFromPath(raw: string): ParsedName | undefined {
  try {
    return parseName(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

/** Accepts `alice`, `alice.dash` or `Alice.DASH.`; rejects subdomains and other TLDs. */
export function parseName(input: string): ParsedName | undefined {
  let name = input.trim().toLowerCase();
  if (name.endsWith('.')) name = name.slice(0, -1);
  const parts = name.split('.');
  if (parts.length === 2 && parts[1] !== DASH_TLD) return undefined;
  if (parts.length > 2) return undefined;
  const label = parts[0] ?? '';
  if (!isValidLabel(label)) return undefined;
  return { label, normalized: normalizeLabel(label) };
}

export type HostMatch =
  | { kind: 'apex'; domain: string }
  | { kind: 'site'; domain: string; label: string; normalized: string }
  | { kind: 'invalid'; domain: string }
  | { kind: 'unknown' };

/** Maps a Host header to a gateway domain and site label. `domains` are lowercase, without ports. */
export function matchHost(hostHeader: string | undefined, domains: readonly string[]): HostMatch {
  if (!hostHeader) return { kind: 'unknown' };
  let host = hostHeader.trim().toLowerCase();
  const port = /:\d+$/.exec(host);
  if (port) host = host.slice(0, -port[0].length);
  if (host.endsWith('.')) host = host.slice(0, -1);
  const sorted = [...domains].sort((a, b) => b.length - a.length);
  for (const domain of sorted) {
    if (host === domain) return { kind: 'apex', domain };
    if (!host.endsWith(`.${domain}`)) continue;
    const label = host.slice(0, -domain.length - 1);
    if (!isValidLabel(label)) return { kind: 'invalid', domain };
    return { kind: 'site', domain, label, normalized: normalizeLabel(label) };
  }
  return { kind: 'unknown' };
}
