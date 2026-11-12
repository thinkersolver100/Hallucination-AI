import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { ZodError } from 'zod';
import type { Role } from '../db/models.js';
import type { Store } from '../db/store.js';
import { HttpError, unauthorized } from '../errors.js';
import type { Logger } from '../logger.js';
import type { RateLimiter } from '../security/rateLimit.js';
import { SESSION_COOKIE, hashToken, readCookie } from '../security/session.js';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
}

export function getAuth(res: Response): AuthContext {
  const auth = res.locals['auth'] as AuthContext | undefined;
  if (!auth) throw unauthorized();
  return auth;
}

export const jsonBody = (limit: string): RequestHandler =>
  express.json({ limit, type: 'application/json', strict: true });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth, next to SameSite=Lax cookies. A browser always sends Origin on a
 * cross-site POST, so an Origin that is not on the list is refused. Requests without Origin
 * come from non-browser clients, which cannot be ridden through a victim's cookie.
 */
export const requireAllowedOrigin = (allowed: readonly string[]): RequestHandler =>
  (req, _res, next) => {
    const origin = req.get('origin');
    if (!SAFE_METHODS.has(req.method) && origin !== undefined && !allowed.includes(origin)) {
      next(new HttpError(403, 'origin_not_allowed', 'requests from this origin are not allowed'));
      return;
    }
    next();
  };

export const authenticate = (store: Store, now: () => Date): RequestHandler =>
  async (req, res, next) => {
    const token = readCookie(req.get('cookie'), SESSION_COOKIE);
    if (!token) throw unauthorized();
    const session = await store.findSession(hashToken(token));
    if (!session || session.expiresAt.getTime() <= now().getTime()) throw unauthorized();
    res.locals['auth'] = { userId: session.userId, orgId: session.orgId, role: session.role } satisfies AuthContext;
    next();
  };

export function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

export const limitBy = (
  limiter: RateLimiter,
  key: (req: Request) => string,
): RequestHandler =>
  (req, _res, next) => {
    const wait = limiter.consume(key(req));
    if (wait > 0) {
      next(
        new HttpError(429, 'rate_limited', 'too many requests, try again later', {
          'Retry-After': String(wait),
        }),
      );
      return;
    }
    next();
  };

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'not_found', 'route not found'));
};

export const errorHandler = (log: Logger): ErrorRequestHandler =>
  (err: unknown, req, res, _next) => {
    if (err instanceof HttpError) {
      for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'the request is not valid',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'payload_too_large', message: 'request body is too large' } });
      return;
    }
    if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || type === 'charset.unsupported') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'request body is not valid JSON' } });
      return;
    }
    log.error('unhandled error', { method: req.method, path: req.path, error: String(err) });
    res.status(500).json({ error: { code: 'internal_error', message: 'something went wrong' } });
  };
