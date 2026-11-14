import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppRoutes } from '../../src/App';
import { AuthProvider } from '../../src/auth/AuthContext';

export interface Call {
  method: string;
  /** Path with the query string, without the /api prefix. */
  path: string;
  body: unknown;
}
export interface Reply {
  status: number;
  body?: unknown;
}
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

/** Replaces fetch with a route table keyed "METHOD /path" (query strings are ignored for matching). */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '');
    const path = full.split('?')[0] ?? full;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { method, path: full, body };
    calls.push(call);

    const handler = routes[`${method} ${path}`];
    if (!handler) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: `unmocked ${method} ${path}` } }), {
        status: 404,
      });
    }
    const reply = typeof handler === 'function' ? await handler(call) : handler;
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}
