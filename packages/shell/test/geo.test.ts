import { describe, expect, it } from 'vitest';
import { distanceKm, nodeCoords, selectBiasedCandidates, visitorCoords, type NodeGeo } from '../src/geo.js';
import { NODE_GEO } from '../src/node-geo.js';

describe('visitorCoords', () => {
  it('reads CloudFront PoP IATA codes from x-amz-cf-pop', () => {
    expect(visitorCoords('ORD58-P3')).toEqual([42, -88]);
    expect(visitorCoords('fra60-p1')).toEqual([50, 9]);
    expect(visitorCoords('NRT57-P4')).toEqual([36, 140]);
  });

  it('falls back to IANA timezone and region when x-amz-cf-pop is missing or unknown', () => {
    expect(visitorCoords(null, 'America/Chicago')).toEqual([42, -88]);
    expect(visitorCoords('ZZZ99-P1', 'Europe/Berlin')).toEqual([52, 13]);
    expect(visitorCoords(undefined, 'Asia/UnknownCity')).toEqual([28, 105]);
  });
});

describe('nodeCoords and distanceKm', () => {
  const geo: NodeGeo = {
    p16: { '10.1': [42, -88], '10.2': [50, 9] },
    ip: { '10.2.0.5': [36, 140] },
  };

  it('prefers exact IP overrides over /16 prefixes and handles unknown hosts', () => {
    expect(nodeCoords('10.1.9.9:443', geo)).toEqual([42, -88]);
    expect(nodeCoords('10.2.0.5:443', geo)).toEqual([36, 140]);
    expect(nodeCoords('10.2.0.6:443', geo)).toEqual([50, 9]);
    expect(nodeCoords('192.0.2.1:443', geo)).toBeUndefined();
  });

  it('orders great-circle distances sensibly', () => {
    const chicago = [42, -88] as const;
    const nyc = [41, -74] as const;
    const frankfurt = [50, 9] as const;
    const tokyo = [36, 140] as const;
    expect(distanceKm(chicago, nyc)).toBeLessThan(distanceKm(chicago, frankfurt));
    expect(distanceKm(chicago, frankfurt)).toBeLessThan(distanceKm(chicago, tokyo));
  });
});

describe('selectBiasedCandidates', () => {
  const geo: NodeGeo = {
    p16: {
      '10.1': [42, -88], // Chicago (near)
      '10.2': [50, 9], // Frankfurt (far)
    },
    ip: {},
  };
  const nearHosts = Array.from({ length: 16 }, (_, i) => `10.1.0.${i + 1}:443`);
  const farHosts = Array.from({ length: 40 }, (_, i) => `10.2.0.${i + 1}:443`);
  const unknownHosts = ['198.51.100.1:443', '198.51.100.2:443'];
  const allHosts = [...farHosts, ...nearHosts, ...unknownHosts];

  it('biases the probe pool toward nearby nodes while keeping global randoms and no duplicates', () => {
    const picked = selectBiasedCandidates(allHosts, [42, -88], geo, { tries: 10, nearPool: 16, nearPick: 8 });
    expect(picked).toHaveLength(10);
    expect(new Set(picked).size).toBe(10);
    const nearCount = picked.slice(0, 8).filter((h) => h.startsWith('10.1.')).length;
    expect(nearCount).toBe(8);
    // Global tail slots come from the remaining pool (not duplicating the first 8)
    const tail = picked.slice(8);
    expect(tail).toHaveLength(2);
    expect(tail.every((h) => !picked.slice(0, 8).includes(h))).toBe(true);
  });

  it('shuffles within the near pool rather than hard-pinning the exact same top hosts', () => {
    const first = selectBiasedCandidates(allHosts, [42, -88], geo, { tries: 10, nearPool: 16, nearPick: 8, random: () => 0.1 });
    const second = selectBiasedCandidates(allHosts, [42, -88], geo, { tries: 10, nearPool: 16, nearPick: 8, random: () => 0.9 });
    expect(first.slice(0, 8)).not.toEqual(second.slice(0, 8));
  });

  it('falls back to uniform selection when visitor or geo data is absent', () => {
    expect(selectBiasedCandidates(allHosts, undefined, geo, { tries: 10 })).toHaveLength(10);
    expect(selectBiasedCandidates(allHosts, [42, -88], undefined, { tries: 10 })).toHaveLength(10);
  });

  it('bundles non-empty mainnet geo hints', () => {
    expect(Object.keys(NODE_GEO.mainnet?.p16 ?? {}).length).toBeGreaterThan(50);
  });
});
