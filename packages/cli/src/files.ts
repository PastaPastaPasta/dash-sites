import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SiteFile } from '@dash-sites/core';

const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);

/** Reads a directory into site files. Dotfiles are skipped, except `.well-known`. */
export async function readSiteDirectory(root: string): Promise<SiteFile[]> {
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${root} is not a directory`);
  const out: SiteFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.well-known')) continue;
      const full = join(dir, entry.name);
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(full, path);
      else if (entry.isFile()) out.push({ path, bytes: new Uint8Array(await readFile(full)) });
    }
  };
  await walk(root, '');
  return out;
}
