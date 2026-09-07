/**
 * The Event Bus wire format: SignalR's JSON hub protocol, version 1.
 *
 * Everything in this file is pure and synchronous so it can be tested with no socket, which is
 * how the conformance cases in `cases/event-bus.json` are run.
 *
 * We speak the protocol directly rather than depending on `@microsoft/signalr`. The surface we
 * use is four message types wide, the SDK ships with zero dependencies, and the official client
 * defaults `withCredentials` to true - which is precisely the setting that makes the handshake
 * fail against our gateway (see `busSocketUrl` below).
 */

import { PraxError } from './errors.js';
import { normalizeBaseUrl } from './routes.js';

/** ASCII record separator. SignalR terminates every frame with it. */
export const RS = '\x1e';

/**
 * The handshake, byte for byte. SignalR compares it literally - a trailing newline or a space
 * after a colon fails it, with an error that does not say so.
 */
export const HANDSHAKE_FRAME = '{"protocol":"json","version":1}';

/** The hub's path. There is no workspace segment: the workspace comes from the token. */
export const BUS_PATH = '/hubs/event-bus';

/** Message types we act on. The rest of SignalR's set never reaches this hub. */
export const MSG = {
  invocation: 1,
  completion: 3,
  ping: 6,
  close: 7,
} as const;

/**
 * Splits a received buffer into whole frames, returning whatever trailing fragment is left.
 *
 * Two things go wrong without this. A single physical message can carry SEVERAL frames, so
 * JSON-parsing the whole buffer throws exactly when traffic picks up - the load the bus exists
 * for. And a transport may split one frame across two reads, so the tail has to be kept rather
 * than parsed or dropped.
 */
export function splitFrames(buffer: string): { frames: string[]; remainder: string } {
  const parts = buffer.split(RS);
  const remainder = parts.pop() ?? '';
  return { frames: parts.filter((p) => p.length > 0), remainder };
}

/** Wraps a frame for sending. */
export function frame(payload: unknown): string {
  return (typeof payload === 'string' ? payload : JSON.stringify(payload)) + RS;
}

/**
 * Normalises a bus key the way the server does: the TOPIC segment folds to lowercase and the
 * instance is left exactly as given.
 *
 * Doing this client-side matters more than it looks. `BusAddress.ForCaller` folds the topic when
 * it resolves the topic AND when it builds the group name, so `Office:hq` and `office:hq` are one
 * bus. If the SDK sent the key unfolded the server would still admit both peers - and put them in
 * the same group - but an SDK that folded the WHOLE key would merge `office:HQ` and `office:hq`,
 * which are two genuinely different buses. Fold the same half the server folds, and neither
 * failure is possible.
 */
export function normalizeBusKey(busKey: string): string {
  const key = (busKey ?? '').trim();
  const sep = key.indexOf(':');
  if (sep <= 0) return key.toLowerCase();
  return key.slice(0, sep).toLowerCase() + key.slice(sep);
}

/**
 * Rejects keys the server would reject anyway, before spending a round trip on it.
 *
 * `ws:` is refused because the SignalR group name is built by concatenation - a key carrying the
 * separator could climb out of its own segment and name another workspace's group.
 */
export function requireValidBusKey(busKey: string): string {
  const key = normalizeBusKey(busKey);

  if (!key) {
    throw new PraxError('INVALID_BUS_KEY', 'A bus key is required. It looks like "topic:instance", e.g. "office:hq".');
  }
  if (key.includes('ws:')) {
    throw new PraxError('INVALID_BUS_KEY', `A bus key may not contain "ws:" (got "${busKey}"). The server refuses it.`);
  }
  if (key.length > 200) {
    throw new PraxError('INVALID_BUS_KEY', `Bus key is too long (${key.length} characters).`);
  }
  return key;
}

/** Builds an invocation frame. `invocationId` is a STRING - completions are matched on it by value. */
export function buildInvocation(invocationId: string, target: string, args: unknown[]): Record<string, unknown> {
  return { type: MSG.invocation, invocationId, target, arguments: args };
}

/** What the hub returns from JoinBus, Publish and LeaveBus, in one shape. */
export interface BusResult {
  /** False for a policy rejection. Rejections arrive INSIDE a successful completion. */
  ok: boolean;
  /** One of the hub's error codes, or null. */
  error: string | null;
  /** JoinBus: every peer's last retained message. Empty when the topic does not retain. */
  peers: BusPeerState[];
  /** Publish: how many OTHER connections it reached. Zero is success, not failure. */
  recipients: number;
  /**
   * True when SignalR itself failed the call - a server fault, not a policy decision. Kept apart
   * because the two want different handling and `error` would otherwise conflate them.
   */
  isTransportError: boolean;
}

/** One peer's last known state within a bus. */
export interface BusPeerState {
  userId: string;
  event: string;
  payload: unknown;
}

/**
 * Reads a completion frame.
 *
 * The trap this exists for: the hub answers a REJECTED call with a SUCCESSFUL completion whose
 * result carries `ok:false`. An SDK that only inspects SignalR's `error` field reports every
 * denied join as a success. And `LeaveBus` is void, so its result is literally `null` - reading
 * `result.ok` on it is a null dereference or, worse, a silent false.
 */
export function parseBusResult(message: Record<string, unknown>): BusResult {
  const base: BusResult = { ok: true, error: null, peers: [], recipients: 0, isTransportError: false };

  if (typeof message['error'] === 'string' && message['error']) {
    return { ...base, ok: false, error: message['error'], isTransportError: true };
  }

  const result = message['result'];
  if (result === null || result === undefined) return base; // void, e.g. LeaveBus

  const r = result as Record<string, unknown>;
  const peers = Array.isArray(r['peers'])
    ? (r['peers'] as Record<string, unknown>[]).map((p) => ({
        userId: String(p['userId'] ?? ''),
        event: String(p['event'] ?? ''),
        payload: p['payload'] ?? null,
      }))
    : [];

  return {
    ok: r['ok'] !== false,
    error: typeof r['error'] === 'string' ? r['error'] : null,
    peers,
    recipients: typeof r['recipients'] === 'number' ? r['recipients'] : 0,
    isTransportError: false,
  };
}

/** An event relayed from another peer. `fromUserId` is stamped by the server, never by the sender. */
export interface BusEvent {
  bus: string;
  fromUserId: string;
  event: string;
  payload: unknown;
}

/**
 * The negotiate URL. A zero-length POST with the end-user JWT as a bearer token; the response
 * names the transports this deployment offers.
 */
export function busNegotiateUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}${BUS_PATH}/negotiate?negotiateVersion=1`;
}

/**
 * The WebSocket URL, with the session token in the query string.
 *
 * The token goes in the query because a browser `WebSocket` cannot set an `Authorization` header,
 * and the hub accepts `access_token` for exactly that reason. It is not laziness: the alternative
 * is a transport that works in Node and not in a browser.
 *
 * This is also why the SDK does not use the official SignalR client. That client defaults
 * `withCredentials` to true, which makes the browser send the negotiate with credentials mode
 * `include`; the CORS spec forbids answering that with a wildcard `Access-Control-Allow-Origin`,
 * and the gateway front door replies `*`. The handshake is refused before it starts, with a
 * message that reads like a server misconfiguration.
 */
export function busSocketUrl(baseUrl: string, accessToken: string): string {
  const http = normalizeBaseUrl(baseUrl);
  const ws = http.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${ws}${BUS_PATH}?access_token=${encodeURIComponent(accessToken)}`;
}

/**
 * Turns a hub error code into a sentence worth reading. The codes themselves are stable and are
 * what callers should branch on; these strings are not.
 */
export function describeBusError(code: string | null): string {
  switch (code) {
    case 'unknown_topic':
      return 'That topic is not declared in this workspace. Buses are never auto-created - declare the topic under API Gateway / Event Bus first.';
    case 'denied':
      return 'The topic refused this user. Check the topic\'s access mode: Workspace, Roles (which reads the roles in your JWT), or Grants (which needs a grant on this exact bus instance).';
    case 'invalid_ticket':
      return 'The ticket was missing, expired or minted for a different user, workspace or bus.';
    case 'not_a_member':
      return 'Publish to a bus this connection has not joined. Call join() first - membership is the authorization check on the publish path.';
    case 'invalid_bus_key':
      return 'The key is malformed, or it named another user\'s "user:" bus. Only "user:self" is addressable.';
    case 'invalid_event_name':
      return 'The event name was empty or too long.';
    case 'payload_too_large':
      return 'The payload is over this topic\'s byte limit.';
    case 'bus_full_or_too_many_buses':
      return 'The bus is at its peer limit, or this connection already holds as many buses as it may.';
    case 'rate_limited':
      return 'Too many publishes. The limit is priced by RECIPIENTS, so a large bus exhausts it faster than a small one.';
    default:
      return code ?? 'The bus refused the call.';
  }
}
