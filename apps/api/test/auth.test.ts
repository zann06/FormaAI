import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpUser, TestClient, type TestApp } from './helpers.js';

let context: TestApp;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

describe('auth', () => {
  it('signs up, issues an HttpOnly session cookie and returns the session', async () => {
    const client = new TestClient(context.app);
    const signup = await client.post('/api/auth/signup', {
      email: `cookie-${Date.now()}@example.test`,
      password: 'CorrectHorseBattery9!',
      displayName: 'Cookie Tester',
    });
    expect(signup.status).toBe(201);
    expect(signup.body.user.email).toContain('@example.test');

    const setCookie = String(signup.headers['set-cookie']);
    expect(setCookie).toContain('formaai_session=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    // The raw session token must never appear in the response body.
    expect(JSON.stringify(signup.body)).not.toContain('token');

    const session = await client.get('/api/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.user.id).toBe(signup.body.user.id);
  });

  it('rejects duplicate email addresses with 409', async () => {
    const email = `dupe-${Date.now()}@example.test`;
    const client = new TestClient(context.app);
    const first = await client.post('/api/auth/signup', { email, password: 'CorrectHorseBattery9!' });
    expect(first.status).toBe(201);
    const second = await new TestClient(context.app).post('/api/auth/signup', {
      email,
      password: 'AnotherPassword1!',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('rejects weak passwords with a validation error', async () => {
    const result = await new TestClient(context.app).post('/api/auth/signup', {
      email: `weak-${Date.now()}@example.test`,
      password: 'short',
    });
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 401 for unauthenticated access to protected routes', async () => {
    const anonymous = new TestClient(context.app);
    const projects = await anonymous.get('/api/projects');
    expect(projects.status).toBe(401);
    expect(projects.body.error.code).toBe('UNAUTHORIZED');
  });

  it('signs in with correct credentials and rejects wrong ones', async () => {
    const { email } = await signUpUser(context.app, 'signin');
    const client = new TestClient(context.app);

    const wrong = await client.post('/api/auth/signin', { email, password: 'WrongPassword123!' });
    expect(wrong.status).toBe(401);

    const right = await client.post('/api/auth/signin', { email, password: 'CorrectHorseBattery9!' });
    expect(right.status).toBe(200);
    expect(right.body.user.email).toBe(email);
  });

  it('signs out and invalidates the session server-side', async () => {
    const { client } = await signUpUser(context.app, 'signout');
    const cookieBeforeSignOut = client.sessionCookie;
    expect((await client.get('/api/auth/session')).status).toBe(200);

    await client.post('/api/auth/signout');

    // Replaying the old cookie must not authenticate.
    const replay = new TestClient(context.app);
    replay.sessionCookie = cookieBeforeSignOut;
    expect((await replay.get('/api/auth/session')).status).toBe(401);
  });

  it('rejects a forged session token', async () => {
    const forged = new TestClient(context.app);
    forged.sessionCookie = `formaai_session=${'a'.repeat(43)}`;
    expect((await forged.get('/api/auth/session')).status).toBe(401);
  });

  it('blocks cross-origin state-changing requests (CSRF guard)', async () => {
    const { client } = await signUpUser(context.app, 'csrf');
    const blocked = await client.request('POST', '/api/projects', {
      body: { title: 'Should not be created' },
      headers: { origin: 'https://evil.example' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('FORBIDDEN');

    const allowed = await client.request('POST', '/api/projects', {
      body: { title: 'Allowed origin' },
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.status).toBe(201);
  });
});
