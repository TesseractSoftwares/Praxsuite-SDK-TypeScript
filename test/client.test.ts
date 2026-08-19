import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createClient, PraxError, f } from '../src/index.js';

const WS = '1eb92f32-d628-4656-8c64-cd0d43c9869d';
const KEY = 'pk_live_' + 'fedcba9876543210fedcba9876543210';

/** A fetch stub that records calls and replays scripted responses. */
function stubFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  let i = 0;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json', ...(next.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function client(responses: Parameters<typeof stubFetch>[0], opts: Record<string, unknown> = {}) {
  const { impl, calls } = stubFetch(responses);
  return {
    prax: createClient({ workspaceId: WS, publishableKey: KEY, fetch: impl, maxRetries: 0, ...opts }),
    calls,
  };
}

describe('mutation guardrails throw synchronously', () => {
  // This is the failure mode that shipped in another SDK: validation inside an async function
  // becomes a rejected promise, so a caller who does not await gets no write AND no error.
  // These assertions would fail if the throw were deferred.

  test('update without a filter throws at the call site', () => {
    const { prax } = client([{ status: 200, body: {} }]);
    assert.throws(() => prax.data.update('T', { Level: 1 }, []), /requires at least one filter/);
  });

  test('delete without a filter throws at the call site', () => {
    const { prax } = client([{ status: 200, body: {} }]);
    assert.throws(() => prax.data.delete('T', []), /requires at least one filter/);
  });

  test('insert with no values throws at the call site', () => {
    const { prax } = client([{ status: 200, body: {} }]);
    assert.throws(() => prax.data.insert('T', {}), /At least one column value/);
  });

  test('a fire-and-forget call still surfaces the refusal', () => {
    const { prax, calls } = client([{ status: 200, body: {} }]);
    // Deliberately not awaited - the whole point is that this cannot pass silently.
    assert.throws(() => { void prax.data.delete('T', []); });
    assert.equal(calls.length, 0, 'nothing should reach the network');
  });
});

describe('query building', () => {
  test('a query sends the PraxQL shape the gateway expects', async () => {
    const { prax, calls } = client([
      { status: 200, body: { data: [{ ID: 'a', Score: 10 }], meta: { limit: 5, offset: 0, count: 1, total: 42, durationMs: 3 } } },
    ]);
    prax.schema.register('Scores', '2192d04c-4361-4a82-aaec-6e3f2c6172af');

    const page = await prax.data.from('Scores')
      .select('Score')
      .where(f.gte('Score', 10))
      .orderByDescending('Score')
      .limit(5)
      .withTotalCount()
      .page();

    assert.equal(page.total, 42);
    assert.equal(page.rows.length, 1);

    const sent = JSON.parse(calls[0]!.body!);
    assert.deepEqual(sent.refs, { t: '2192d04c-4361-4a82-aaec-6e3f2c6172af' });
    assert.equal(sent.query.from, 't');
    assert.deepEqual(sent.query.select, ['Score']);
    assert.deepEqual(sent.query.where, [{ field: 'Score', op: 'gte', value: 10 }]);
    assert.deepEqual(sent.query.orderBy, [{ field: 'Score', dir: 'desc' }]);
    assert.equal(sent.query.limit, 5);
    assert.equal(sent.includeTotalCount, true);
  });

  test('a GUID passes through without a schema lookup', async () => {
    const { prax, calls } = client([{ status: 200, body: { data: [], meta: {} } }]);
    await prax.data.from('2192d04c-4361-4a82-aaec-6e3f2c6172af').all();
    assert.equal(calls.length, 1, 'no schema request should be made');
  });

  test('count uses includeTotalCount with a one-row fetch', async () => {
    // The gateway clamps limit up to a minimum of 1, so a zero-row count is impossible.
    const { prax, calls } = client([
      { status: 200, body: { data: [{ ID: 'a' }], meta: { limit: 1, offset: 0, count: 1, total: 137 } } },
    ]);
    prax.schema.register('Scores', '2192d04c-4361-4a82-aaec-6e3f2c6172af');

    assert.equal(await prax.data.from('Scores').count(), 137);
    const sent = JSON.parse(calls[0]!.body!);
    assert.equal(sent.query.limit, 1);
    assert.equal(sent.includeTotalCount, true);
  });
});

describe('transport', () => {
  test('the publishable key goes in x-api-key, never the URL', async () => {
    const { prax, calls } = client([{ status: 200, body: { data: [], meta: {} } }]);
    await prax.data.from('2192d04c-4361-4a82-aaec-6e3f2c6172af').all();

    assert.equal(calls[0]!.headers.get('x-api-key'), KEY);
    assert.ok(!calls[0]!.url.includes(KEY), 'a credential must never appear in a URL');
  });

  test('a 403 surfaces as a typed, non-retryable error', async () => {
    const { prax, calls } = client([
      { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Read access denied.' } } },
    ]);

    await assert.rejects(
      prax.data.from('2192d04c-4361-4a82-aaec-6e3f2c6172af').all(),
      (err: PraxError) => err.code === 'FORBIDDEN' && err.isForbidden && !err.isTransient
    );
    assert.equal(calls.length, 1, 'a 403 must not be retried');
  });

  test('a rate limit is retried, a quota error is not', async () => {
    const rateLimited = client(
      [
        { status: 429, body: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' } }, headers: { 'Retry-After': '0' } },
        { status: 200, body: { data: [], meta: {} } },
      ],
      { maxRetries: 1 }
    );
    await rateLimited.prax.data.from('2192d04c-4361-4a82-aaec-6e3f2c6172af').all();
    assert.equal(rateLimited.calls.length, 2, 'a rate limit should be retried');

    const quota = client(
      [{ status: 429, body: { error: { code: 'QUOTA_EXCEEDED', message: 'out of calls' } } }],
      { maxRetries: 3 }
    );
    await assert.rejects(
      quota.prax.data.from('2192d04c-4361-4a82-aaec-6e3f2c6172af').all(),
      (err: PraxError) => err.isQuotaExceeded && !err.isTransient
    );
    assert.equal(quota.calls.length, 1, 'retrying an exhausted quota only burns calls');
  });

  test('a secret key is refused at construction', () => {
    assert.throws(
      () => createClient({ workspaceId: WS, publishableKey: 'sk_live_' + '0123456789abcdef0123456789abcdef' }),
      /secret key/i
    );
  });

  test('a plaintext remote gateway is refused, loopback is allowed', () => {
    assert.throws(
      () => createClient({ workspaceId: WS, publishableKey: KEY, baseUrl: 'http://gateway.example.com' }),
      /plaintext/i
    );
    assert.doesNotThrow(() =>
      createClient({ workspaceId: WS, publishableKey: KEY, baseUrl: 'http://localhost:5049' })
    );
  });
});

describe('auth', () => {
  const LOGIN_OK = {
    status: 200,
    body: {
      isSuccess: true,
      data: {
        accessToken: 'header.payload.sig',
        refreshToken: 'rt-1',
        accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        user: { id: 'u1', email: 'a@b.c', username: 'aria', roles: ['Player'] },
      },
    },
  };

  test('login stores the session and exposes the user', async () => {
    const { prax } = client([LOGIN_OK]);
    const result = await prax.auth.login('a@b.c', 'password');

    assert.equal(result.isSignedIn, true);
    assert.equal(prax.auth.isSignedIn, true);
    assert.equal(prax.auth.currentUserId, 'u1');
    assert.equal(prax.auth.currentUser?.displayName, 'aria');
    assert.deepEqual(prax.auth.currentUser?.roles, ['Player']);
  });

  test('after login the session token is used, not the api key', async () => {
    const { prax, calls } = client([LOGIN_OK, { status: 200, body: { data: [], meta: {} } }]);
    await prax.auth.login('a@b.c', 'password');
    await prax.data.from('2192d04c-4361-4a82-aaec-6e3f2c6172af').all();

    assert.equal(calls[1]!.headers.get('Authorization'), 'Bearer header.payload.sig');
    assert.equal(calls[1]!.headers.get('x-api-key'), null);
  });

  test('registration requiring confirmation is not a silent failure', async () => {
    const { prax } = client([
      { status: 200, body: { isSuccess: true, data: { requiresEmailConfirmation: true, email: 'a@b.c' } } },
    ]);
    const result = await prax.auth.register({ email: 'a@b.c', password: 'password1' });

    assert.equal(result.isSignedIn, false);
    assert.equal(result.requiresEmailConfirmation, true, 'callers must be able to tell this from a bad password');
  });

  test('logout clears local state even when the revoke call fails', async () => {
    const { prax } = client([LOGIN_OK, { status: 500, body: { error: { code: 'X', message: 'boom' } } }]);
    await prax.auth.login('a@b.c', 'password');
    await prax.auth.logout();
    assert.equal(prax.auth.isSignedIn, false, 'a failed revoke must not leave the user looking signed in');
  });
});
