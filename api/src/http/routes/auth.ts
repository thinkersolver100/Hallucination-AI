import { randomUUID } from 'node:crypto';
import { Router, type Response } from 'express';
import type { Config } from '../../config.js';
import type { Store } from '../../db/store.js';
import { HttpError, forbidden, unauthorized } from '../../errors.js';
import type { PasswordHasher } from '../../security/password.js';
import type { RateLimiter } from '../../security/rateLimit.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  hashToken,
  newSessionToken,
  readCookie,
} from '../../security/session.js';
import { authenticate, clientIp, getAuth, jsonBody, limitBy } from '../middleware.js';
import { loginSchema, registerSchema } from '../schemas.js';

export interface AuthLimiters {
  register: RateLimiter;
  loginByIp: RateLimiter;
  loginByAccount: RateLimiter;
}

export function authRouter(deps: {
  config: Config;
  store: Store;
  hasher: PasswordHasher;
  limiters: AuthLimiters;
  now: () => Date;
}): Router {
  const { config, store, hasher, limiters, now } = deps;
  const router = Router();
  const body = jsonBody('16kb');

  async function openSession(res: Response, user: { _id: string; orgId: string; role: 'admin' | 'member' }) {
    const { token, hash } = newSessionToken();
    const createdAt = now();
    await store.createSession({
      _id: hash,
      userId: user._id,
      orgId: user.orgId,
      role: user.role,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS),
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
  }

  router.post('/register', limitBy(limiters.register, clientIp), body, async (req, res) => {
    if (!config.REGISTRATION_OPEN) throw forbidden('registration_closed', 'registration is closed');
    const input = registerSchema.parse(req.body);
    const created = await store.createOrganizationWithAdmin({
      orgId: randomUUID(),
      orgName: input.organizationName,
      userId: randomUUID(),
      email: input.email,
      passwordHash: await hasher.hash(input.password),
      now: now(),
    });
    if (!created) throw new HttpError(409, 'email_taken', 'that email is already registered');

    const user = await store.findUserByEmail(input.email);
    if (!user) throw new Error('user vanished after registration');
    await openSession(res, user);
    res.status(201).json({
      user: { id: user._id, email: user.email, role: user.role },
      organization: { id: user.orgId, name: input.organizationName },
    });
  });

  router.post(
    '/login',
    limitBy(limiters.loginByIp, clientIp),
    body,
    async (req, res, next) => {
      // Parse first so the per-account limiter can key on the (normalised) email.
      const input = loginSchema.parse(req.body);
      res.locals['login'] = input;
      limitBy(limiters.loginByAccount, () => `${clientIp(req)}|${input.email}`)(req, res, next);
    },
    async (_req, res) => {
      const input = res.locals['login'] as { email: string; password: string };
      const user = await store.findUserByEmail(input.email);
      if (!user) {
        await hasher.dummyVerify(input.password);
        throw unauthorized('invalid email or password');
      }
      if (!(await hasher.verify(input.password, user.passwordHash))) {
        throw unauthorized('invalid email or password');
      }
      const org = await store.findOrganization(user.orgId);
      await openSession(res, user);
      res.json({
        user: { id: user._id, email: user.email, role: user.role },
        organization: { id: user.orgId, name: org?.name ?? '' },
      });
    },
  );

  router.post('/logout', async (req, res) => {
    const token = readCookie(req.get('cookie'), SESSION_COOKIE);
    if (token) await store.deleteSession(hashToken(token));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/me', authenticate(store, now), async (_req, res) => {
    const auth = getAuth(res);
    const user = await store.findUserById(auth.userId);
    if (!user) throw unauthorized();
    const org = await store.findOrganization(user.orgId);
    res.json({
      user: { id: user._id, email: user.email, role: user.role },
      organization: { id: user.orgId, name: org?.name ?? '' },
    });
  });

  return router;
}
