import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  RS, HANDSHAKE_FRAME, BUS_PATH,
  normalizeBusKey, requireValidBusKey, splitFrames, parseBusResult, describeBusError,
} from '../src/buswire.js';
import { createClient, PraxError } from '../src/index.js';
import type { PraxSession } from '../src/storage.js';

/**
 * Mirrors `cases/event-bus.json` from the SDK conformance contract. Every case here failed at
 * least once in a real SDK or was measured against the live hub on 2026-09-07.
 */

const WS = '00000000-0000-4000-8000-0000000000ff';
const KEY = 'pk_live_' + 'fedcba9876543210fedcba9876543210';
const USER = '729531eb-98ca-4cfd-bb79-452dbe177ca5';

describe('bus keys', () => {
  test('folds the topic segment and leaves the instance alone', () => {
    assert.equal(normalizeBusKey('Office:HQ'), 'office:HQ');
  });

  test('an already-lowercase key is unchanged', () => {
    assert.equal(normalizeBusKey('channel:9f1c0f2e'), 'channel:9f1c0f2e');
  });

  test('a key with no instance still folds', () => {
    assert.equal(normalizeBusKey('LOBBY'), 'lobby');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeBusKey('  office:hq  '), 'office:hq');
  });

  test('passes user:self through untouched', () => {
    assert.equal(normalizeBusKey('user:self'), 'user:self');
  });

  test('rejects an empty key before the round trip', () => {
    assert.throws(() => requireValidBusKey('   '), (e: PraxError) => e.code === 'INVALID_BUS_KEY');
  });

  test('rejects a key containing ws:', () => {
    assert.throws(() => requireValidBusKey('x:ws:something'), (e: PraxError) => e.code === 'INVALID_BUS_KEY');
  });
});

describe('frames', () => {
  test('the handshake is byte-exact', () => {
    assert.equal(HANDSHAKE_FRAME, '{"protocol":"json","version":1}');
  });

  test('a single frame splits to one message', () => {
    assert.deepEqual(splitFrames(`{"type":6}${RS}`), { frames: ['{"type":6}'], remainder: '' });
  });

  test('two coalesced frames split into two', () => {
    const buffer = `{"type":6}${RS}{"type":3,"invocationId":"1","result":null}${RS}`;
    assert.deepEqual(splitFrames(buffer).frames, ['{"type":6}', '{"type":3,"invocationId":"1","result":null}']);
  });

  test('a trailing partial frame is buffered, not parsed', () => {
    const { frames, remainder } = splitFrames(`{"type":6}${RS}{"type":3,"invoca`);
    assert.deepEqual(frames, ['{"type":6}']);
    assert.equal(remainder, '{"type":3,"invoca');
  });

  test('an empty segment is dropped', () => {
    assert.deepEqual(splitFrames(`${RS}{"type":6}${RS}`).frames, ['{"type":6}']);
  });
});

describe('completions', () => {
  test('a join carries retained peers', () => {
    const r = parseBusResult({
      type: 3, invocationId: '1',
      result: { ok: true, error: null, peers: [{ userId: USER, event: 'move', payload: { x: 1, y: 2 } }] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.peers.length, 1);
    assert.equal(r.peers[0]!.event, 'move');
  });

  test('a rejection arrives inside a SUCCESSFUL completion', () => {
    const r = parseBusResult({ type: 3, invocationId: '3', result: { ok: false, error: 'unknown_topic', peers: [] } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unknown_topic');
    assert.equal(r.isTransportError, false);
  });

  test('zero recipients is success, not failure', () => {
    const r = parseBusResult({ type: 3, invocationId: '2', result: { ok: true, error: null, recipients: 0 } });
    assert.equal(r.ok, true);
    assert.equal(r.recipients, 0);
  });

  test('a void result (LeaveBus) is ok, not a null dereference', () => {
    const r = parseBusResult({ type: 3, invocationId: '7', result: null });
    assert.equal(r.ok, true);
    assert.deepEqual(r.peers, []);
  });

  test('a hub error frame is kept apart from a policy rejection', () => {
    const r = parseBusResult({ type: 3, invocationId: '9', error: "An unexpected error occurred invoking 'JoinBus'." });
    assert.equal(r.ok, false);
    assert.equal(r.isTransportError, true);
  });

  test('every hub error code has a sentence worth reading', () => {
    for (const code of [
      'invalid_bus_key', 'unknown_topic', 'denied', 'invalid_ticket', 'bus_full_or_too_many_buses',
      'not_a_member', 'invalid_event_name', 'payload_too_large', 'rate_limited',
    ]) {
      assert.ok(describeBusError(code).length > 20, code);
    }
  });
});

/** A WebSocket double that speaks the hub's half of the protocol. */
class FakeSocket extends EventEmitter {
  static last: FakeSocket | null = null;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  /** Answers each invocation with this result, keyed by target. */
  results: Record<string, unknown> = {};

  constructor(readonly url: string) {
    super();
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
    for (const frame of splitFrames(data).frames) {
      if (frame === HANDSHAKE_FRAME) {
        this.deliver('{}');
        continue;
      }
      const msg = JSON.parse(frame) as { invocationId: string; target: string };
      const result = this.results[msg.target] ?? { ok: true, error: null, peers: [], recipients: 0 };
      this.deliver(JSON.stringify({ type: 3, invocationId: msg.invocationId, result }));
    }
  }

  /** Pushes a raw frame to the client, exactly as the hub would. */
  deliver(frame: string): void {
    queueMicrotask(() => this.onmessage?.({ data: frame + RS }));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

function signedInClient() {
  const prax = createClient({
    workspaceId: WS,
    publishableKey: KEY,
    baseUrl: 'https://gateway.example.test',
    bus: { webSocket: FakeSocket as unknown as typeof WebSocket, autoReconnect: false },
  });
  const session: PraxSession = {
    accessToken: 'test-token',
    accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
    userId: USER,
    roles: [],
  };
  prax.client.setSession(session);
  return prax;
}

describe('bus connection', () => {
  test('refuses to connect without a signed-in end user', async () => {
    const prax = createClient({
      workspaceId: WS,
      publishableKey: KEY,
      bus: { webSocket: FakeSocket as unknown as typeof WebSocket },
    });
    await assert.rejects(prax.bus.connect(), (e: PraxError) => e.code === 'BUS_REQUIRES_SESSION');
  });

  test('connects to /hubs/event-bus with the token in the query string', async () => {
    const prax = signedInClient();
    await prax.bus.connect();

    const url = FakeSocket.last!.url;
    assert.ok(url.startsWith('wss://gateway.example.test' + BUS_PATH), url);
    assert.ok(url.includes('access_token=test-token'), url);
    // No workspace segment: the workspace comes from the token.
    assert.ok(!url.includes(WS), url);
    assert.equal(prax.bus.state, 'connected');
  });

  test('sends the handshake before anything else', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    assert.equal(FakeSocket.last!.sent[0], HANDSHAKE_FRAME + RS);
  });
});

describe('channels', () => {
  test('topic().channel() composes the key, and the same key returns the same object', () => {
    const prax = signedInClient();
    const a = prax.bus.topic('Office').channel('hq');
    const b = prax.bus.channel('office:hq');
    assert.equal(a.key, 'office:hq');
    assert.equal(a, b);
    assert.equal(a.topic, 'office');
    assert.equal(a.instance, 'hq');
  });

  test('join sends an explicit null ticket and returns the retained peers', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    FakeSocket.last!.results['JoinBus'] = {
      ok: true, error: null,
      peers: [{ userId: USER, event: 'move', payload: { x: 1, y: 2 } }],
    };

    const peers = await prax.bus.channel('office:hq').join();
    assert.equal(peers.length, 1);
    assert.deepEqual(peers[0]!.payload, { x: 1, y: 2 });

    const sent = JSON.parse(FakeSocket.last!.sent.at(-1)!.replace(RS, '')) as Record<string, unknown>;
    assert.equal(sent['target'], 'JoinBus');
    assert.deepEqual(sent['arguments'], ['office:hq', null]);
    assert.equal(typeof sent['invocationId'], 'string');
  });

  test('a refused join throws, because a silently absent client is worse than a dropped frame', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    FakeSocket.last!.results['JoinBus'] = { ok: false, error: 'unknown_topic', peers: [] };

    await assert.rejects(
      prax.bus.channel('nosuch:x').join(),
      (e: PraxError) => e.code === 'BUS_UNKNOWN_TOPIC' && /not declared/i.test(e.message)
    );
  });

  test('a refused publish does NOT throw - dropping an ephemeral frame is normal', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    FakeSocket.last!.results['Publish'] = { ok: false, error: 'rate_limited', recipients: 0 };

    const result = await prax.bus.channel('office:hq').publish('move', { x: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'rate_limited');
  });

  test('publish sends key, event and payload in that order', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    await prax.bus.channel('office:hq').publish('move', { x: 1, y: 2 });

    const sent = JSON.parse(FakeSocket.last!.sent.at(-1)!.replace(RS, '')) as Record<string, unknown>;
    assert.equal(sent['target'], 'Publish');
    assert.deepEqual(sent['arguments'], ['office:hq', 'move', { x: 1, y: 2 }]);
  });

  test('user:self is addressable and needs no ticket', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    await prax.bus.self.join();

    const sent = JSON.parse(FakeSocket.last!.sent.at(-1)!.replace(RS, '')) as Record<string, unknown>;
    assert.deepEqual(sent['arguments'], ['user:self', null]);
  });
});

describe('inbound routing', () => {
  test('a bus-event reaches only the channel it names', async () => {
    const prax = signedInClient();
    await prax.bus.connect();

    const office = prax.bus.channel('office:hq');
    const cursor = prax.bus.channel('cursor:doc-42');
    await office.join();
    await cursor.join();

    const officeSeen: unknown[] = [];
    const cursorSeen: unknown[] = [];
    office.on('move', (e) => officeSeen.push(e.payload));
    cursor.on('move', (e) => cursorSeen.push(e.payload));

    FakeSocket.last!.deliver(JSON.stringify({
      type: 1, target: 'bus-event',
      arguments: [{ bus: 'office:hq', fromUserId: USER, event: 'move', payload: { x: 9 } }],
    }));
    await new Promise((r) => setTimeout(r, 5));

    assert.deepEqual(officeSeen, [{ x: 9 }]);
    assert.deepEqual(cursorSeen, []);
  });

  test('a ping is never surfaced as an event', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    const office = prax.bus.channel('office:hq');
    await office.join();

    let fired = 0;
    office.onAny(() => fired++);
    FakeSocket.last!.deliver('{"type":6}');
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(fired, 0);
  });

  test('peer-joined and peer-left reach the named channel', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    const office = prax.bus.channel('office:hq');
    await office.join();

    const joined: string[] = [];
    const left: string[] = [];
    office.onPeerJoined((id) => joined.push(id));
    office.onPeerLeft((id) => left.push(id));

    FakeSocket.last!.deliver(JSON.stringify({ type: 1, target: 'peer-joined', arguments: [{ bus: 'office:hq', userId: USER }] }));
    FakeSocket.last!.deliver(JSON.stringify({ type: 1, target: 'peer-left', arguments: [{ bus: 'office:hq', userId: USER }] }));
    await new Promise((r) => setTimeout(r, 5));

    assert.deepEqual(joined, [USER]);
    assert.deepEqual(left, [USER]);
  });

  test('an eviction drops membership and does not re-join', async () => {
    const prax = signedInClient();
    await prax.bus.connect();
    const channel = prax.bus.channel('channel:abc');
    await channel.join();

    let evicted = 0;
    channel.onEvicted(() => evicted++);
    FakeSocket.last!.deliver(JSON.stringify({ type: 1, target: 'bus-evicted', arguments: [{ bus: 'channel:abc' }] }));
    await new Promise((r) => setTimeout(r, 5));

    assert.equal(evicted, 1);

    // Nothing further is sent: the server has just decided this client may not be here.
    const before = FakeSocket.last!.sent.length;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(FakeSocket.last!.sent.length, before);
  });
});

describe('oidc', () => {
  function stubFetch(body: unknown, status = 200) {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test('startOidcLogin returns the state, not just the url', async () => {
    const { impl, calls } = stubFetch({
      isSuccess: true,
      data: { authorizationUrl: 'https://idp.example/authorize?state=abc', state: 'abc' },
    });
    const prax = createClient({ workspaceId: WS, publishableKey: KEY, baseUrl: 'https://gw.test', fetch: impl });

    const start = await prax.auth.startOidcLogin('tesseract');
    assert.equal(start.state, 'abc');
    assert.equal(start.authorizationUrl, 'https://idp.example/authorize?state=abc');
    assert.equal(calls[0]!.url, `https://gw.test/${WS}/auth/oidc/tesseract`);
  });

  test('the callback carries providerSlug and redirectUri, which the gateway requires', async () => {
    const { impl, calls } = stubFetch({
      accessToken: 'jwt', refreshToken: 'r', tokenType: 'Bearer',
      user: { id: USER, email: 'a@b.c', roles: [] },
    });
    const prax = createClient({ workspaceId: WS, publishableKey: KEY, baseUrl: 'https://gw.test', fetch: impl });

    await prax.auth.completeOidcLogin('tesseract', 'CODE', 'abc', 'https://app.example/callback');

    const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.deepEqual(sent, {
      providerSlug: 'tesseract',
      code: 'CODE',
      state: 'abc',
      redirectUri: 'https://app.example/callback',
    });
  });

  test('an OIDC login lands in the same session store as a password login', async () => {
    const { impl } = stubFetch({
      accessToken: 'jwt', refreshToken: 'r', tokenType: 'Bearer',
      user: { id: USER, email: 'a@b.c', roles: [] },
    });
    const prax = createClient({ workspaceId: WS, publishableKey: KEY, baseUrl: 'https://gw.test', fetch: impl });

    await prax.auth.completeOidcLogin('tesseract', 'CODE', 'abc', 'https://app.example/callback');

    assert.equal(prax.auth.isSignedIn, true);
    assert.equal(prax.auth.currentUserId, USER);
  });

  test('providers carry the label, and come from oidcProviders not enabledSocialProviders', async () => {
    const { impl } = stubFetch({
      success: true,
      publicKey: KEY,
      authPageConfig: { enabledSocialProviders: ['google', 'facebook'] },
      oidcProviders: [{ slug: 'tesseract', displayName: 'Tesseract SSO' }],
    });
    const prax = createClient({ workspaceId: WS, publishableKey: KEY, baseUrl: 'https://gw.test', fetch: impl });

    const config = await prax.auth.getWorkspaceConfig();
    assert.deepEqual(config.providers, [{ slug: 'tesseract', displayName: 'Tesseract SSO' }]);
    assert.deepEqual(config.oidcProviders, ['tesseract']);
  });

  test('every field of the callback is required', async () => {
    const { impl } = stubFetch({});
    const prax = createClient({ workspaceId: WS, publishableKey: KEY, baseUrl: 'https://gw.test', fetch: impl });

    await assert.rejects(() => prax.auth.completeOidcLogin('', 'c', 's', 'u'), TypeError);
    await assert.rejects(() => prax.auth.completeOidcLogin('p', '', 's', 'u'), TypeError);
    await assert.rejects(() => prax.auth.completeOidcLogin('p', 'c', '', 'u'), TypeError);
    await assert.rejects(() => prax.auth.completeOidcLogin('p', 'c', 's', ''), TypeError);
  });
});
