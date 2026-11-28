import type { Resolution } from '@dash-sites/core';
import type { SiteFile } from './render.js';

/** The viewer hands the sandbox one page to show. */
export interface PageMessage {
  type: 'page';
  origin: string;
  url: string;
  html: string;
  files: SiteFile[];
}

/** What the sandbox asks of the viewer. Every field is checked before use: the sandbox runs the site's code. */
export type FrameMessage =
  | { type: 'ready'; url: string }
  /** Show another address of this site, or another `.dash` site. */
  | { type: 'navigate'; url: string; replace?: boolean }
  /** The site changed its address without loading (history API). */
  | { type: 'location'; url: string }
  | { type: 'title'; title: string }
  /** Leave for a page outside Dash Platform. */
  | { type: 'leave'; url: string };

export function asFrameMessage(data: unknown): FrameMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const message = data as Record<string, unknown>;
  const url = typeof message.url === 'string' && message.url.length <= 4096 ? message.url : undefined;
  switch (message.type) {
    case 'ready':
    case 'location':
    case 'leave':
      return url === undefined ? undefined : { type: message.type, url };
    case 'navigate':
      return url === undefined ? undefined : { type: 'navigate', url, replace: message.replace === true };
    case 'title':
      return typeof message.title === 'string' ? { type: 'title', title: message.title.slice(0, 200) } : undefined;
    default:
      return undefined;
  }
}

/** What the background worker answers a viewer that asked to open a name. Plain data: it crosses a port. */
export type OpenResult =
  /** The site is in the cache under `key`; `changed` when it replaced an older revision there. */
  | { kind: 'site'; key: string; changed: boolean }
  | { kind: 'unavailable'; resolution: Exclude<Resolution, { status: 'ok' }> }
  | { kind: 'external'; content: string };

/** Messages on a viewer's port to the background worker. */
export type ViewerRequest = { type: 'open'; label: string };
export type WorkerReply = { type: 'progress'; message: string } | { type: 'result'; result: OpenResult } | { type: 'error'; message: string };
export const SITE_PORT = 'site';
