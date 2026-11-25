import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliPlaces } from '../src/places.js';

const ORIGIN = 'https://alice.dash.site';
const bytes = new Uint8Array(2000).map((_, i) => i % 251);

type Answer = { status?: number; allow?: string; location?: string };

function serving(answers: Record<string, Answer>): Array<[string, string]> {
  const asked: Array<[string, string]> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push([url, (init?.headers as Record<string, string>).Origin ?? '']);
    expect(init?.redirect).toBe('manual');
    const answer = answers[url] ?? { status: 404 };
    const headers = new Headers();
    if (answer.allow) headers.set('access-control-allow-origin', answer.allow);
    if (answer.location) headers.set('location', answer.location);
    return new Response(answer.location ? null : bytes, { status: answer.status ?? (answer.location ? 302 : 200), headers });
  });
  return asked;
}

describe('an HTTPS place, asked the way a browser asks', () => {
  afterEach(() => vi.unstubAllGlobals());
  const read = (uri: string) => cliPlaces(ORIGIN).fetchers.https?.(uri, bytes.length);

  it('is read when it lets other sites read it', async () => {
    serving({ 'https://a.example/f': { allow: '*' }, 'https://b.example/f': { allow: ORIGIN } });
    expect(await read('https://a.example/f')).toEqual(bytes);
    expect(await read('https://b.example/f')).toEqual(bytes);
  });

  it('is refused when it does not say other sites may read it', async () => {
    serving({ 'https://a.example/f': {}, 'https://b.example/f': { allow: 'https://other.example' } });
    await expect(read('https://a.example/f')).rejects.toThrow(/a\.example must answer with Access-Control-Allow-Origin/);
    await expect(read('https://b.example/f')).rejects.toThrow(/does not let other sites read it/);
    await expect(read('https://a.example/missing')).rejects.toThrow(/it answered 404/);
  });

  it('follows a redirect only when every answer on the way allows the read', async () => {
    const asked = serving({
      'https://a.example/f': { allow: '*', location: 'https://cdn.example/f' },
      'https://cdn.example/f': { allow: '*' },
      'https://a.example/closed': { location: 'https://cdn.example/f' },
      'https://a.example/echo': { allow: ORIGIN, location: 'https://cdn.example/echo' },
      'https://cdn.example/echo': { allow: ORIGIN },
      'https://a.example/same': { allow: ORIGIN, location: '/same2' },
      'https://a.example/same2': { allow: ORIGIN },
      'https://a.example/down': { allow: '*', location: 'http://a.example/f' },
      'https://a.example/loop': { allow: '*', location: 'https://a.example/loop' },
    });
    expect(await read('https://a.example/f')).toEqual(bytes);
    expect(asked).toEqual([
      ['https://a.example/f', ORIGIN],
      ['https://cdn.example/f', 'null'],
    ]);
    await expect(read('https://a.example/closed')).rejects.toThrow(/a\.example must answer with Access-Control-Allow-Origin/);
    await expect(read('https://a.example/echo')).rejects.toThrow(/cdn\.example must answer with Access-Control-Allow-Origin/);
    expect(await read('https://a.example/same')).toEqual(bytes);
    await expect(read('https://a.example/down')).rejects.toThrow(/redirects to http:/);
    await expect(read('https://a.example/loop')).rejects.toThrow(/too many times/);
  });
});
