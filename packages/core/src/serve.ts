import type { Manifest } from './manifest.js';

/**
 * Paths under every site that its host answers itself: `site.json` (the proved record),
 * `manifest.json`, and `resolve/<name>`. A site reads them the same way from the shell or a gateway.
 */
export const HOST_API = '/.well-known/dash/';

export type ServeDecision =
  | { kind: 'file'; path: string; status: 200 | 404 }
  | { kind: 'redirect'; location: string }
  | { kind: 'not-found' };

/** Decodes a URL pathname into a site path, or undefined when it cannot name a file. */
export function decodePathname(pathname: string): string | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const raw of pathname.slice(1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === '.' || segment === '..' || /[\u0000-\u001f\u007f\\/]/.test(segment)) return undefined;
    segments.push(segment);
  }
  if (segments.slice(0, -1).some((segment) => segment === '')) return undefined;
  return `/${segments.join('/')}`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Decides what a request path serves. `search` is the query string including `?`, kept on redirects.
 * Order: exact file, directory index, `.html` shorthand, redirect to a directory, then the SPA or 404 page.
 */
export function decide(manifest: Pick<Manifest, 'spa'> & { files: object }, pathname: string, search = ''): ServeDecision {
  const has = (path: string): boolean => Object.prototype.hasOwnProperty.call(manifest.files, path);
  const fallback = (): ServeDecision => {
    if (manifest.spa && has('/index.html')) return { kind: 'file', path: '/index.html', status: 200 };
    if (has('/404.html')) return { kind: 'file', path: '/404.html', status: 404 };
    return { kind: 'not-found' };
  };
  const path = decodePathname(pathname);
  if (path === undefined) return fallback();
  if (path.endsWith('/')) {
    const index = `${path}index.html`;
    return has(index) ? { kind: 'file', path: index, status: 200 } : fallback();
  }
  if (has(path)) return { kind: 'file', path, status: 200 };
  if (has(`${path}.html`)) return { kind: 'file', path: `${path}.html`, status: 200 };
  if (has(`${path}/index.html`)) return { kind: 'redirect', location: `${encodePath(path)}/${search}` };
  return fallback();
}
