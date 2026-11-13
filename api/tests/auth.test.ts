import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/security/rateLimit.js';
import { PASSWORD, buildTestApp, type TestApp } from './helpers/testApp.js';

let t: TestApp;
beforeAll(async () => {
  t = await buildTestApp();
});
afterAll(async () => {
  await t.close();
});

const register = (email: string, extra: Record<string, unknown> = {}) =>
  ({ email, password: PASSWORD, organizationName: 'Acme', ...extra });

describe('registration and login', () => {
  it('registers an organization and logs the user in with a hardened cookie', async () => {
    const agent = t.agent();
    const res = await agent.post('/auth/register').send(register('Founder@Example.com'));

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('founder@example.com');
    expect(res.body.user.role).toBe('admin');
    expect(res.body.organization.name).toBe('Acme');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('hd_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('founder@example.com');
  });

  it('stores only a hash of the session token and a hash of the password', async () => {
    const res = await t.agent().post('/auth/register').send(register('hashes@example.com'));
    const token = /hd_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1] ?? '';
    const sessions = await t.store.findSession(token);
    expect(sessions).toBeNull(); // the raw token is not a key anywhere
    const user = await t.store.findUserByEmail('hashes@example.com');
    expect(user?.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(user?.passwordHash).not.toContain(PASSWORD);
  });

  it('rejects a duplicate email', async () => {
    await t.agent().post('/auth/register').send(register('dup@example.com'));
    const again = await t.agent().post('/auth/register').send(register('DUP@example.com'));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('email_taken');
  });

  it('validates registration input', async () => {
    const bad = [
      register('not-an-email'),
      register('a@example.com', { password: 'short' }),
      register('a@example.com', { organizationName: '' }),
      register('a@example.com', { role: 'admin' }),
      register('a@example.com', { organizationName: 'two\nlines' }),
    ];
    for (const body of bad) {
      const res = await t.agent().post('/auth/register').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
  });

  it('logs in with the right password and refuses the wrong one identically', async () => {
    await t.agent().post('/auth/register').send(register('login@example.com'));

    const ok = await t.agent().post('/auth/login').send({ email: 'login@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);

    const wrongPassword = await t.agent().post('/auth/login').send({ email: 'login@example.com', password: 'wrong password here' });
    const unknownEmail = await t.agent().post('/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('logout ends the session on the server, not just in the browser', async () => {
    const agent = t.agent();
    const res = await agent.post('/auth/register').send(register('logout@example.com'));
    const token = /hd_session=([^;]+)/.exec(String(res.headers['set-cookie']))?.[1];
    expect(token).toBeDefined();
    expect((await agent.get('/auth/me')).status).toBe(200);

    expect((await agent.post('/auth/logout')).status).toBe(204);
    expect((await agent.get('/auth/me')).status).toBe(401);

    // Even a copy of the old cookie no longer works: the session is gone from the database.
    const replay = await request(t.app).get('/auth/me').set('Cookie', `hd_session=${token}`);
    expect(replay.status).toBe(401);
  });

  it('refuses requests without a session or with a forged one', async () => {
    expect((await request(t.app).get('/auth/me')).status).toBe(401);
    expect((await request(t.app).get('/datasets')).status).toBe(401);
    const forged = await request(t.app).get('/datasets').set('Cookie', 'hd_session=forged-token');
    expect(forged.status).toBe(401);
  });

  it('closes registration when configured', async () => {
    const closed = await buildTestApp({ REGISTRATION_OPEN: '0' });
    try {
      const res = await closed.agent().post('/auth/register').send(register('x@example.com'));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('registration_closed');
    } finally {
      await closed.close();
    }
  });
});

describe('request hardening', () => {
  it('sets security headers and hides the framework', async () => {
    const res = await request(t.app).get('/healthz');
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses state-changing requests from an origin that is not allowed', async () => {
    const res = await t
      .agent()
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('origin_not_allowed');

    const fromAllowed = await t
      .agent()
      .post('/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email: 'a@example.com', password: PASSWORD });
    expect(fromAllowed.status).toBe(401); // reached the login logic
  });

  it('rejects malformed JSON, non-JSON bodies and oversized bodies', async () => {
    const malformed = await t.agent().post('/auth/login').set('Content-Type', 'application/json').send('{not json');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('invalid_json');

    const notJson = await t.agent().post('/auth/login').set('Content-Type', 'text/plain').send('email=a');
    expect(notJson.status).toBe(400);

    const huge = await t.agent().post('/auth/login').send({ email: 'a@example.com', password: 'x'.repeat(40_000) });
    expect(huge.status).toBe(413);
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await request(t.app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('rate limiting', () => {
  it('blocks repeated login attempts for one account with Retry-After', async () => {
    const limited = await buildTestApp({}, { loginByAccount: new RateLimiter(3, 60_000) });
    try {
      const attempt = () =>
        limited.agent().post('/auth/login').send({ email: 'victim@example.com', password: 'guess guess guess' });
      expect([(await attempt()).status, (await attempt()).status, (await attempt()).status]).toEqual([401, 401, 401]);
      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('rate_limited');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it('blocks registration floods from one address', async () => {
    const limited = await buildTestApp({}, { register: new RateLimiter(2, 60_000) });
    try {
      const signUp = (n: number) => limited.agent().post('/auth/register').send(register(`flood${n}@example.com`));
      expect([(await signUp(1)).status, (await signUp(2)).status]).toEqual([201, 201]);
      expect((await signUp(3)).status).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
