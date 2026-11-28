// Runs in the background worker: one chain proof, one SDK and one read of each site for every tab.
import { loadManifest, readerConfig, readFile, resolveName, siteChunks, type Network, type PlatformReader } from '@dash-sites/core';
import { EvoReader } from '@dash-sites/core/evo';
import { deleteSite, getMeta, putSite, siteKey, touchSite } from './cache.js';
import { ChainKeeper } from './chain.js';
import { respondingNodes } from './nodes.js';
import type { OpenResult } from './protocol.js';
import type { SiteFile } from './render.js';

declare global {
  var dashSitesSdk: WebAssembly.Module | undefined;
}

const MAX_SITE_BYTES = 64 << 20;
const NODES = 16;

type Progress = (message: string) => void;

let verifier: Promise<WebAssembly.Module> | undefined;
function compileVerifier(): Promise<WebAssembly.Module> {
  verifier ??= WebAssembly.compileStreaming(fetch(chrome.runtime.getURL('verifier.wasm')));
  verifier.catch(() => {
    verifier = undefined;
  });
  return verifier;
}

class NetworkService {
  readonly keeper: ChainKeeper;
  /** Set once the user removed what was proven: work still running then writes nothing. */
  private disposed = false;
  private reader?: Promise<PlatformReader>;
  private readonly inflight = new Map<string, { result: Promise<OpenResult>; listeners: Set<Progress> }>();

  constructor(private readonly network: Network) {
    this.keeper = new ChainKeeper(network);
  }

  dispose(): void {
    this.disposed = true;
    this.keeper.dispose();
  }

  private connect(progress: Progress): Promise<PlatformReader> {
    this.reader ??= (async () => {
      progress('Loading the verifier and the proven chain state');
      const [snapshot, module] = await Promise.all([this.keeper.get(progress), compileVerifier()]);
      globalThis.dashSitesSdk = module;
      // The SDK asks for the keys once as it connects, then again only for a quorum it has none for.
      let connected = false;
      const quorums = () => {
        if (!connected) {
          connected = true;
          return this.keeper.get();
        }
        return this.keeper.refresh();
      };
      progress('Finding Dash Platform nodes that answer');
      const addresses = await respondingNodes(snapshot.nodes, NODES);
      return EvoReader.connect(readerConfig(this.network), { addresses, quorums });
    })();
    this.reader.catch(() => {
      this.reader = undefined;
    });
    return this.reader;
  }

  /** Resolves a name and makes sure the site it shows is in the cache. One run per name at a time. */
  open(label: string, progress: Progress): Promise<OpenResult> {
    const key = siteKey(this.network, label);
    let entry = this.inflight.get(key);
    if (!entry) {
      const listeners = new Set<Progress>();
      const fanOut: Progress = (message) => {
        for (const listener of listeners) listener(message);
      };
      const result = this.load(label, key, fanOut).finally(() => this.inflight.delete(key));
      entry = { result, listeners };
      this.inflight.set(key, entry);
    }
    entry.listeners.add(progress);
    return entry.result;
  }

  private async load(label: string, key: string, progress: Progress): Promise<OpenResult> {
    const reader = await this.connect(progress);
    try {
      return await this.read(reader, label, key, progress);
    } catch (error) {
      // Every node the SDK holds failed: probe again on the next open rather than keep them.
      if (/no available addresses/i.test((error as Error)?.message ?? '')) this.reader = undefined;
      throw error;
    }
  }

  private async read(reader: PlatformReader, label: string, key: string, progress: Progress): Promise<OpenResult> {
    progress('Reading the name and its site from Dash Platform, with proofs');
    const resolution = await resolveName(reader, label, { preload: true });
    // A name with no site here any more (taken down, moved, or changed hands) leaves nothing cached to show.
    if (resolution.status !== 'ok') {
      if (!this.disposed) await deleteSite(key);
      return { kind: 'unavailable', resolution };
    }
    if (resolution.content.scheme !== 'dash-manifest') {
      if (!this.disposed) await deleteSite(key);
      return { kind: 'external', content: resolution.site.content };
    }
    const now = Date.now();
    const cached = await getMeta(key);
    if (cached && cached.resolution.ownerId === resolution.ownerId && cached.resolution.site.content === resolution.site.content) {
      if (!this.disposed) await touchSite(key, resolution, now);
      return { kind: 'site', key, changed: false };
    }
    const source = siteChunks(reader, resolution);
    const manifest = await loadManifest(resolution.content, source);
    const files: SiteFile[] = [];
    const skipped: string[] = [];
    const paths = Object.keys(manifest.files);
    let total = 0;
    let done = 0;
    const queue = [...paths];
    let failed = false;
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path !== undefined && !failed; path = queue.shift()) {
        const entry = manifest.files[path];
        if (!entry || entry.ext || entry.src || entry.unread) {
          skipped.push(path);
          continue;
        }
        total += entry.size;
        if (total > MAX_SITE_BYTES) throw new Error(`${label}.dash is larger than this extension opens (${MAX_SITE_BYTES >> 20} MB)`);
        const { bytes } = await readFile(manifest, path, source);
        files.push({ path, type: entry.type, bytes });
        progress(`Checking files against their published hashes: ${++done} of ${paths.length}`);
      }
    };
    // One failed file fails the site; the other readers stop rather than read on into nothing.
    await Promise.all(Array.from({ length: 4 }, () => worker().catch((error: unknown) => {
      failed = true;
      throw error;
    })));
    if (this.disposed) throw new Error('The verified chain was just forgotten. Open the site again.');
    await putSite({ key, network: this.network, resolution, manifest, files, skipped, checkedAt: now, usedAt: now });
    return { kind: 'site', key, changed: Boolean(cached) };
  }
}

const services = new Map<Network, NetworkService>();
export const serviceFor = (network: Network): NetworkService => {
  let service = services.get(network);
  if (!service) {
    service = new NetworkService(network);
    services.set(network, service);
  }
  return service;
};

/** Forgets everything proven in memory, after the stored proof was removed. Work still running writes nothing. */
export const resetServices = (): void => {
  for (const service of services.values()) service.dispose();
  services.clear();
};
