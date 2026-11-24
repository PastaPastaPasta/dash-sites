import { isValidLabel, normalizeLabel } from './names.js';
import type { Resolution } from './resolve.js';

/** Names, owners and site contents a hosted gateway has stopped serving. Names are DPNS-normalized. */
export interface Denylist {
  names: Set<string>;
  owners: Set<string>;
  content: Set<string>;
}

export function emptyDenylist(): Denylist {
  return { names: new Set(), owners: new Set(), content: new Set() };
}

const bareName = (value: string): string => value.trim().replace(/\.dash\.?$/i, '');
const denyName = (value: string): string => normalizeLabel(bareName(value));

/** One entry per line: `name alice`, `owner <identity id>`, `content <content URI>`. `#` starts a comment. */
export function parseDenylist(text: string): Denylist {
  const list = emptyDenylist();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [kind, value] = line.split(/\s+/, 2);
    if (!value) throw new Error(`denylist: missing value in "${raw}"`);
    if (kind === 'name') {
      if (!isValidLabel(bareName(value))) throw new Error(`denylist: "${value}" is not a DPNS label`);
      list.names.add(denyName(value));
    } else if (kind === 'owner') list.owners.add(value);
    else if (kind === 'content') list.content.add(value);
    else throw new Error(`denylist: unknown kind "${kind}"`);
  }
  return list;
}

/** The published form, `{ names, owners, content }` of string arrays. Anything else is an empty list. */
export function denylistFromJson(value: unknown): Denylist {
  const list = emptyDenylist();
  if (typeof value !== 'object' || value === null) return list;
  const strings = (key: string): string[] => {
    const field = (value as Record<string, unknown>)[key];
    return Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : [];
  };
  for (const name of strings('names')) if (isValidLabel(bareName(name))) list.names.add(denyName(name));
  for (const owner of strings('owners')) list.owners.add(owner);
  for (const content of strings('content')) list.content.add(content);
  return list;
}

export function isDenied(list: Denylist, resolution: Resolution): boolean {
  if (!('normalized' in resolution)) return false;
  if (list.names.has(resolution.normalized)) return true;
  if (!('ownerId' in resolution)) return false;
  return list.owners.has(resolution.ownerId) || ('site' in resolution && list.content.has(resolution.site.content));
}

export const DENIED_TITLE = 'Unavailable on this gateway';
export const deniedDetail = (dashName: string): string =>
  `The operator of this gateway does not serve <code>${dashName}</code>. The site itself is on Dash Platform and other gateways may serve it.`;
