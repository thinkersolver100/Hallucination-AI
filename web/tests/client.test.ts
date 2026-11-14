import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, request, setUnauthorizedHandler } from '../src/api/client';

function reply(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('request', () => {
  it('returns data validated by the schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { n: 3 })));
    expect(await request('GET', '/x', { schema: z.object({ n: z.number() }) })).toEqual({ n: 3 });
  });

  it('sends JSON bodies with same-origin credentials, through the /api prefix', async () => {
    const fetchMock = vi.fn(async () => reply(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await request('POST', '/auth/login', { body: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('turns an API error body into an ApiError with its issues', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(400, { error: { code: 'invalid_request', message: 'bad input', issues: [{ path: 'name', message: 'required' }] } }),
      ),
    );
    const err = (await request('POST', '/datasets', { body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code, err.message]).toEqual([400, 'invalid_request', 'bad input']);
    expect(err.issues).toEqual([{ path: 'name', message: 'required' }]);
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 500 })));
    const err = (await request('GET', '/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(500);
    expect(err.message).toContain('HTTP 500');
    expect(err.message).not.toContain('oops');
  });

  it('calls the unauthorized handler on 401 unless a 401 is expected', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: { code: 'unauthorized', message: 'no' } })));

    await request('GET', '/datasets').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);

    await request('POST', '/auth/login', { body: {}, expect401: true }).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(null);
  });

  it('reports network failures in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const err = (await request('GET', '/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('network');
    expect(err.message).toContain('Cannot reach the server');
  });

  it('rejects responses that do not match the schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { unexpected: true })));
    const err = (await request('GET', '/x', { schema: z.object({ n: z.number() }) }).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('bad_response');
  });

  it('returns undefined for 204', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await request('DELETE', '/datasets/1')).toBeUndefined();
  });
});
