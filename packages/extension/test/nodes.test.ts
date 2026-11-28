import { describe, expect, it } from 'vitest';
import { respondingNodes } from '../src/nodes.js';

const nodes = Array.from({ length: 10 }, (_, i) => `https://10.0.0.${i}:443`);
/** Nodes 0–3 answer at once, 4–5 answer UNAVAILABLE, the rest never answer until cancelled. */
const fake: typeof fetch = (input, init) => {
  const index = Number(/10\.0\.0\.(\d+)/.exec(String(input))?.[1]);
  if (index <= 3) return Promise.resolve(new Response(null, { status: 200, headers: { 'grpc-status': '3' } }));
  if (index <= 5) return Promise.resolve(new Response(null, { status: 200, headers: { 'grpc-status': '14' } }));
  return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
};

describe('picking nodes that answer', () => {
  it('uses the nodes that answered, not ones that are down or unavailable', async () => {
    const started = Date.now();
    const picked = await respondingNodes(nodes, 16, { fetch: fake, deadlineMs: 300 });
    expect(new Set(picked)).toEqual(new Set(nodes.slice(0, 4)));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stops as soon as enough nodes answered', async () => {
    const started = Date.now();
    const picked = await respondingNodes(nodes, 16, { fetch: fake, keep: 2, deadlineMs: 5000 });
    expect(picked).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('falls back to a random pick when too few answer', async () => {
    const picked = await respondingNodes(nodes.slice(6), 3, { fetch: fake, deadlineMs: 100 });
    expect(picked).toHaveLength(3);
  });
});
