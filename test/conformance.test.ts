import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { f } from '../src/filter.js';
import { classify, redact, requireClientSafe } from '../src/keyguard.js';
import { scrub } from '../src/log.js';
import { PraxError } from '../src/errors.js';
import { parsePage, parseMutation, parseError, unwrapEnvelope } from '../src/rows.js';
import { routes, normalizeBaseUrl, isInsecureRemote } from '../src/routes.js';

/**
 * These mirror Praxsuite-SDK-Conformance/cases/wire-shapes.json.
 *
 * Every case exists because getting it wrong produces silently wrong data rather than an error,
 * and at least one shipped SDK got it wrong. They run offline - no network, no workspace.
 */

describe('filters build the gateway wire shape', () => {
  test('eq', () => {
    assert.deepEqual(f.eq('Score', 100), { field: 'Score', op: 'eq', value: 100 });
  });

  test('isNull compiles to the is operator', () => {
    // There is no isNull operator server-side; "is" only tests for null.
    assert.deepEqual(f.isNull('DeletedAt'), { field: 'DeletedAt', op: 'is', value: null });
  });

  test('isNotNull compiles to neq null', () => {
    assert.deepEqual(f.isNotNull('DeletedAt'), { field: 'DeletedAt', op: 'neq', value: null });
  });

  test('startsWith and endsWith compile to like with the wildcard applied', () => {
    assert.deepEqual(f.startsWith('Name', 'Sword'), { field: 'Name', op: 'like', value: 'Sword%' });
    assert.deepEqual(f.endsWith('Name', 'blade'), { field: 'Name', op: 'like', value: '%blade' });
  });

  test('in carries an array', () => {
    assert.deepEqual(f.in('Level', [1, 2, 3]), { field: 'Level', op: 'in', value: [1, 2, 3] });
  });

  test('between carries exactly two values', () => {
    assert.deepEqual(f.between('Score', 10, 20), { field: 'Score', op: 'between', value: [10, 20] });
  });

  test('or and and groups nest under their keys', () => {
    assert.deepEqual(
      f.any(f.eq('Rarity', 'legendary'), f.eq('Rarity', 'epic')),
      { or: [{ field: 'Rarity', op: 'eq', value: 'legendary' }, { field: 'Rarity', op: 'eq', value: 'epic' }] }
    );
    assert.deepEqual(
      f.all(f.gte('Level', 5), f.lte('Level', 10)),
      { and: [{ field: 'Level', op: 'gte', value: 5 }, { field: 'Level', op: 'lte', value: 10 }] }
    );
  });

  test('an empty IN list is rejected rather than matching nothing', () => {
    assert.throws(() => f.in('Id', []), TypeError);
  });
});

describe('result parsing', () => {
  test('page metadata reads total, not totalCount', () => {
    // Reading totalCount yields undefined and reports 0 forever. This exact mistake shipped.
    const page = parsePage({
      data: [{ ID: 'a' }, { ID: 'b' }],
      meta: { limit: 50, offset: 0, count: 2, total: 137, durationMs: 12 },
    });

    assert.equal(page.rows.length, 2);
    assert.equal(page.count, 2);
    assert.equal(page.limit, 50);
    assert.equal(page.total, 137);
    assert.equal(page.durationMs, 12);
    assert.equal(page.hasMore, true);
  });

  test('an absent total is null, not zero', () => {
    // Otherwise "no rows" is indistinguishable from "not counted".
    const page = parsePage({ data: [], meta: { limit: 50, offset: 0, count: 0, durationMs: 3 } });
    assert.equal(page.total, null);
    assert.equal(page.rows.length, 0);
  });

  test('mutation results read affectedRows and returned rows', () => {
    const result = parseMutation({
      affectedRows: 1,
      data: [{ ID: 'new-row' }],
      meta: { type: 'insert', durationMs: 8 },
    });
    assert.equal(result.affectedRows, 1);
    assert.deepEqual(result.row, { ID: 'new-row' });
    assert.equal(result.durationMs, 8);
  });

  test('the platform envelope is unwrapped, but a query body is not', () => {
    // /auth/* nests the payload under .data; /query does not. An SDK that unwraps both, or
    // neither, breaks one of them.
    assert.deepEqual(
      unwrapEnvelope({ isSuccess: true, errors: [], data: { accessToken: 'a.b.c' } }),
      { accessToken: 'a.b.c' }
    );
    const queryBody = { data: [{ ID: 'x' }], meta: { count: 1 } };
    assert.equal(unwrapEnvelope(queryBody), queryBody, 'an array .data must not be unwrapped');
  });
});

describe('error shapes and classification', () => {
  test('the query error shape is unwrapped from .error', () => {
    const err = parseError(403, JSON.stringify({
      error: { code: 'FORBIDDEN', message: "Read access denied for table 't'.", details: ['scope'] },
    }));
    assert.equal(err.code, 'FORBIDDEN');
    assert.equal(err.status, 403);
    assert.equal(err.details.length, 1);
    assert.equal(err.isForbidden, true);
  });

  test('the files error shape is a bare string under .error', () => {
    const err = parseError(400, JSON.stringify({ error: "File type '.exe' is not allowed." }));
    assert.equal(err.message, "File type '.exe' is not allowed.");
  });

  test('a non-JSON body does not crash the parser', () => {
    const err = parseError(502, '<html>Bad Gateway</html>');
    assert.equal(err.status, 502);
    assert.ok(err.message.includes('Bad Gateway'));
  });

  test('quota and rate limit share HTTP 429 but classify oppositely', () => {
    // Retrying an exhausted quota cannot succeed; retrying a rate limit will.
    assert.equal(new PraxError('RATE_LIMIT_EXCEEDED', '', 429).isTransient, true);
    assert.equal(new PraxError('QUOTA_EXCEEDED', '', 429).isTransient, false);
    assert.equal(new PraxError('QUOTA_EXCEEDED', '', 429).isQuotaExceeded, true);
    assert.equal(new PraxError('EGRESS_LIMIT_EXCEEDED', '', 429).isQuotaExceeded, true);
  });

  test('network, timeout and 5xx are transient; 4xx is not', () => {
    assert.equal(new PraxError('NETWORK_ERROR', '').isTransient, true);
    assert.equal(new PraxError('TIMEOUT', '').isTransient, true);
    assert.equal(new PraxError('HTTP_503', '', 503).isTransient, true);
    assert.equal(new PraxError('FORBIDDEN', '', 403).isTransient, false);
    assert.equal(new PraxError('UNAUTHORIZED', '', 401).isAuthFailure, true);
  });

  test('instanceof survives subclassing', () => {
    assert.ok(new PraxError('X', 'y') instanceof PraxError);
    assert.ok(new PraxError('X', 'y') instanceof Error);
  });
});

describe('credential handling', () => {
  // Shape-accurate fakes, assembled from fragments so a secret scanner does not flag this file.
  const FAKE_SECRET = 'sk_live_' + '0123456789abcdef0123456789abcdef';
  const FAKE_PUBLISHABLE = 'pk_live_' + 'fedcba9876543210fedcba9876543210';
  const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.signaturehere';

  test('each credential kind is classified', () => {
    assert.equal(classify(FAKE_SECRET), 'secret');
    assert.equal(classify(FAKE_PUBLISHABLE), 'publishable');
    assert.equal(classify(FAKE_JWT), 'jwt');
    assert.equal(classify(''), 'unknown');
    assert.equal(classify('not a key'), 'unknown');
  });

  test('client code refuses a secret key, with no opt-out', () => {
    assert.throws(() => requireClientSafe(FAKE_SECRET, 'a test'), /secret key/i);
  });

  test('publishable keys and session tokens are accepted', () => {
    assert.doesNotThrow(() => requireClientSafe(FAKE_PUBLISHABLE, 'a test'));
    assert.doesNotThrow(() => requireClientSafe(FAKE_JWT, 'a test'));
    assert.doesNotThrow(() => requireClientSafe(null, 'a test'));
  });

  test('redaction never reveals key material', () => {
    const masked = redact(FAKE_SECRET);
    assert.ok(masked.startsWith('sk_live_'));
    assert.ok(!masked.includes('0123456789abcdef'));
  });

  test('log scrubbing removes keys, jwts and secret fields', () => {
    const scrubbed = scrub(
      `key=${FAKE_SECRET} jwt=${FAKE_JWT} ` +
      '{"refreshToken":"rt-secret-value","password":"hunter2"}'
    );
    assert.ok(!scrubbed.includes('0123456789abcdef'), 'the secret key survived');
    assert.ok(!scrubbed.includes('signaturehere'), 'the jwt survived');
    assert.ok(!scrubbed.includes('rt-secret-value'), 'the refresh token survived');
    assert.ok(!scrubbed.includes('hunter2'), 'the password survived');
  });
});

describe('routes', () => {
  const WS = '1eb92f32-d628-4656-8c64-cd0d43c9869d';

  test('the FrontDoor short form is used', () => {
    assert.equal(routes.query('https://gateway.praxsuite.com', WS),
      `https://gateway.praxsuite.com/${WS}/query`);
    assert.equal(routes.auth('https://gateway.praxsuite.com', WS, 'login'),
      `https://gateway.praxsuite.com/${WS}/auth/login`);
  });

  test('trailing slashes and a missing scheme are normalised', () => {
    assert.equal(normalizeBaseUrl('gateway.praxsuite.com/'), 'https://gateway.praxsuite.com');
    assert.equal(routes.schema('gateway.praxsuite.com/', WS), `https://gateway.praxsuite.com/${WS}/schema`);
  });

  test('plaintext remote hosts are flagged but loopback is allowed', () => {
    assert.equal(isInsecureRemote('http://gateway.example.com'), true);
    assert.equal(isInsecureRemote('https://gateway.example.com'), false);
    assert.equal(isInsecureRemote('http://localhost:5049'), false);
    assert.equal(isInsecureRemote('http://127.0.0.1:5049'), false);
  });
});

describe('encoding', () => {
  test('astral emoji survive a round trip', () => {
    // Display names contain emoji constantly; a codec that mangles surrogate pairs corrupts them.
    const name = 'Aria \u{1F680}\u{1F1E8}\u{1F1F1}';
    assert.equal(JSON.parse(JSON.stringify({ name })).name, name);
  });

  test('escaped surrogate pairs decode to one character', () => {
    assert.equal(JSON.parse('{"name":"\\ud83d\\ude80"}').name, '\u{1F680}');
  });

  test('a map serialises as a JSON object, not an array of pairs', () => {
    assert.equal(JSON.stringify({ Score: 10 }), '{"Score":10}');
  });
});
