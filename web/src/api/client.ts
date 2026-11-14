import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

const BASE = '/api';

let onUnauthorized: (() => void) | null = null;

/** Called when any request (other than a login attempt) comes back 401: the session ended. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

interface Options<T> {
  body?: unknown;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** A 401 is an expected answer here (login, "who am I"), not a session expiry. */
  expect401?: boolean;
}

function errorFrom(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown; issues?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : 'http_error';
  const message = typeof error?.message === 'string' ? error.message : `The server answered with HTTP ${status}`;
  const issues = Array.isArray(error?.issues)
    ? (error.issues as { path?: unknown; message?: unknown }[]).map((i) => ({
        path: String(i.path ?? ''),
        message: String(i.message ?? ''),
      }))
    : [];
  return new ApiError(status, code, message, issues);
}

export async function request<T = undefined>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: Options<T> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      ...(options.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check that the API is running.');
  }

  if (response.status === 204) return undefined as T;

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    if (response.status === 401 && !options.expect401) onUnauthorized?.();
    throw errorFrom(response.status, json);
  }
  if (!options.schema) return json as T;

  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(0, 'bad_response', 'The server sent a response this page does not understand.');
  }
  return parsed.data;
}
