/**
 * The Prax Event Bus - ephemeral realtime between connected clients.
 *
 * Live cursors, avatars, "user is typing", a multiplayer lobby: state that is *changing*, where
 * losing a message is fine because a newer one is 100ms behind it.
 *
 * **Nothing here is persisted.** There is no history, no retry, and no delivery to somebody who
 * was not connected. The test is one question: *if this is lost, does it matter?* Yes means it
 * belongs in a table via `prax.data`, or in an automation. No, because there is a newer one
 * coming, means it belongs here.
 *
 * **Payloads are hostile.** The bus relays opaque JSON between USERS and parses none of it, so
 * every server-side sanitizer is bypassed. Rendering a payload as HTML is a stored XSS delivered
 * peer to peer. Treat what arrives the way you would treat a URL query string.
 */

import { PraxError } from './errors.js';
import { log } from './log.js';
import type { PraxClient } from './client.js';
import {
  HANDSHAKE_FRAME, MSG, buildInvocation, busSocketUrl, describeBusError, frame,
  normalizeBusKey, parseBusResult, requireValidBusKey, splitFrames,
  type BusEvent, type BusPeerState, type BusResult,
} from './buswire.js';

export type { BusEvent, BusPeerState, BusResult };

/** Where the connection is. `reconnecting` is normal on a flaky network and resolves itself. */
export type BusState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** A subscription. Call it to unsubscribe. */
export type Unsubscribe = () => void;

export interface PraxBusOptions {
  /** Reconnect automatically and re-join every bus that was held. On by default. */
  autoReconnect?: boolean;
  /** First backoff step, doubling to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Override the WebSocket implementation (Node before 22, a test double, a proxy agent). */
  webSocket?: typeof WebSocket;
}

interface Pending {
  resolve: (r: BusResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A single bus - one topic, one instance. This is the object you actually work with.
 *
 * Handlers registered before `join()` are kept, so a channel can be wired up once at start-up and
 * joined later, and they survive a reconnect: the bus re-joins on your behalf and the same
 * handlers keep firing.
 */
export class PraxChannel {
  /** The normalised key, e.g. `office:hq`. */
  readonly key: string;

  private readonly bus: PraxBus;
  private readonly handlers = new Map<string, Set<(e: BusEvent) => void>>();
  private readonly anyHandlers = new Set<(e: BusEvent) => void>();
  private readonly joinedHandlers = new Set<(userId: string) => void>();
  private readonly leftHandlers = new Set<(userId: string) => void>();
  private readonly evictedHandlers = new Set<() => void>();

  /** @internal */
  ticket: string | null = null;
  /** @internal Whether the app wants to be in this bus. Drives re-join after a reconnect. */
  wanted = false;
  /** @internal */
  joined = false;

  private lastPeers: BusPeerState[] = [];

  /** @internal */
  constructor(bus: PraxBus, key: string) {
    this.bus = bus;
    this.key = key;
  }

  /** The topic segment - everything before the first colon. */
  get topic(): string {
    const i = this.key.indexOf(':');
    return i < 0 ? this.key : this.key.slice(0, i);
  }

  /** The instance segment - everything after the first colon. */
  get instance(): string {
    const i = this.key.indexOf(':');
    return i < 0 ? '' : this.key.slice(i + 1);
  }

  /**
   * Every peer's last retained message, as of the most recent join.
   *
   * This is what stops a late joiner staring at an empty room until somebody moves. It is a
   * snapshot, not a live view - the events that follow are delivered through `on()`.
   */
  get peers(): readonly BusPeerState[] {
    return this.lastPeers;
  }

  /**
   * Joins the bus, returning the peers already present.
   *
   * A refused join throws. That is deliberately louder than a refused publish: a publish that
   * does not land is one dropped frame, whereas a join that does not land means this client is
   * silently absent for the whole session.
   *
   * `ticket` is only consulted for topics whose access mode is Ticket, and is remembered so a
   * reconnect can re-join with it. Note that ticket topics are not usable yet - nothing in the
   * platform mints one - so leave it unset unless you were told otherwise.
   */
  async join(ticket?: string | null): Promise<readonly BusPeerState[]> {
    this.wanted = true;
    if (ticket !== undefined) this.ticket = ticket;

    const result = await this.bus.invoke('JoinBus', [this.key, this.ticket ?? null]);
    if (!result.ok) {
      this.wanted = false;
      throw new PraxError(
        result.isTransportError ? 'BUS_CALL_FAILED' : `BUS_${(result.error ?? 'DENIED').toUpperCase()}`,
        `Could not join "${this.key}": ${describeBusError(result.error)}`
      );
    }

    this.joined = true;
    this.lastPeers = result.peers;
    return result.peers;
  }

  /**
   * Sends an event to every OTHER peer in the bus.
   *
   * Returns the recipient count, and does NOT throw when the bus refuses it - dropping an
   * ephemeral frame is ordinary operation, and a game loop that throws on a rate limit is worse
   * than one that skips a frame. Inspect the result when you care:
   *
   * ```ts
   * const r = await room.publish('move', { x, y });
   * if (!r.ok) console.debug(r.error);   // e.g. 'rate_limited'
   * if (r.recipients === 0) console.debug('sent, and nobody was joined');
   * ```
   *
   * You will not receive your own event back. Apply your own change locally.
   */
  publish(event: string, payload?: unknown): Promise<BusResult> {
    return this.bus.invoke('Publish', [this.key, event, payload ?? {}]);
  }

  /** Leaves the bus. Idempotent, and it stops the reconnect logic re-joining. */
  async leave(): Promise<void> {
    this.wanted = false;
    this.joined = false;
    this.lastPeers = [];
    if (this.bus.state === 'connected') await this.bus.invoke('LeaveBus', [this.key]);
  }

  /** Subscribes to one event name. */
  on(event: string, handler: (e: BusEvent) => void): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Subscribes to every event on this bus, whatever its name. */
  onAny(handler: (e: BusEvent) => void): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  /** Fires only when the topic has presence enabled. */
  onPeerJoined(handler: (userId: string) => void): Unsubscribe {
    this.joinedHandlers.add(handler);
    return () => this.joinedHandlers.delete(handler);
  }

  onPeerLeft(handler: (userId: string) => void): Unsubscribe {
    this.leftHandlers.add(handler);
    return () => this.leftHandlers.delete(handler);
  }

  /**
   * The server removed this connection from the bus, because the topic was disabled or re-scoped
   * while the socket was open. The SDK does not re-join: that would be arguing with a decision the
   * server has just made.
   */
  onEvicted(handler: () => void): Unsubscribe {
    this.evictedHandlers.add(handler);
    return () => this.evictedHandlers.delete(handler);
  }

  /** @internal */
  dispatch(e: BusEvent): void {
    for (const h of this.handlers.get(e.event) ?? []) safely(h, e);
    for (const h of this.anyHandlers) safely(h, e);
  }

  /** @internal */
  dispatchPeer(kind: 'joined' | 'left', userId: string): void {
    for (const h of kind === 'joined' ? this.joinedHandlers : this.leftHandlers) safely(h, userId);
  }

  /** @internal */
  dispatchEvicted(): void {
    this.wanted = false;
    this.joined = false;
    for (const h of this.evictedHandlers) safely(h, undefined as never);
  }
}

/** A topic - a namespace of buses. `prax.bus.topic('office').channel('hq')` is `office:hq`. */
export class PraxTopic {
  constructor(private readonly bus: PraxBus, readonly key: string) {}

  /** The bus for one instance of this topic. */
  channel(instance: string): PraxChannel {
    return this.bus.channel(`${this.key}:${instance}`);
  }
}

/**
 * The bus connection. One socket carries every channel.
 *
 * Requires a signed-in end user: the hub authenticates with the session token, not with the
 * workspace's publishable key. Call `prax.auth.login(...)` (or complete an OIDC sign-in) first.
 */
export class PraxBus {
  private readonly client: PraxClient;
  private readonly options: Required<Omit<PraxBusOptions, 'webSocket'>> & { webSocket?: typeof WebSocket };
  private readonly channels = new Map<string, PraxChannel>();
  private readonly pending = new Map<string, Pending>();
  private readonly stateHandlers = new Set<(s: BusState) => void>();

  private socket: WebSocket | null = null;
  private buffer = '';
  private nextInvocation = 0;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 0;
  private closedByUs = false;
  private _state: BusState = 'disconnected';
  private warnedAboutRouting = false;

  constructor(client: PraxClient, options: PraxBusOptions = {}) {
    this.client = client;
    this.options = {
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? 1_000,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 30_000,
      webSocket: options.webSocket,
    };
  }

  get state(): BusState {
    return this._state;
  }

  /** Notified on every transition. `reconnecting` is a good moment to grey out a presence list. */
  onStateChange(handler: (s: BusState) => void): Unsubscribe {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** A topic by key. Nothing is sent until one of its channels is joined. */
  topic(key: string): PraxTopic {
    return new PraxTopic(this, normalizeBusKey(key));
  }

  /**
   * A channel by full key, `topic:instance`. Repeated calls return the SAME object, so handlers
   * registered anywhere in the app all fire.
   */
  channel(busKey: string): PraxChannel {
    const key = requireValidBusKey(busKey);
    let channel = this.channels.get(key);
    if (!channel) this.channels.set(key, (channel = new PraxChannel(this, key)));
    return channel;
  }

  /**
   * The caller's own private bus.
   *
   * Addressed as `user:self` and resolved server-side to your id - which is what makes it the one
   * bus needing no ticket, since it cannot name anybody else. Use it for messages aimed at one
   * user across their open tabs and devices.
   */
  get self(): PraxChannel {
    return this.channel('user:self');
  }

  /** Opens the socket. `join()` calls this for you; call it directly to fail fast at start-up. */
  connect(): Promise<void> {
    if (this._state === 'connected') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.closedByUs = false;
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  /** Closes the socket and stops reconnecting. Channels keep their handlers. */
  async disconnect(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const c of this.channels.values()) {
      c.wanted = false;
      c.joined = false;
    }
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* a socket that will not close politely is closing anyway */
    }
    this.setState('disconnected');
  }

  /** @internal Sends one invocation and waits for its completion. */
  async invoke(target: string, args: unknown[]): Promise<BusResult> {
    await this.connect();

    const socket = this.socket;
    if (!socket || socket.readyState !== 1 /* OPEN */) {
      throw new PraxError('BUS_NOT_CONNECTED', 'The Event Bus connection is not open.');
    }

    const invocationId = String(++this.nextInvocation);

    return new Promise<BusResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(invocationId);
        reject(new PraxError('BUS_TIMEOUT', `The hub did not answer ${target} within 30s.`));
      }, 30_000);

      this.pending.set(invocationId, { resolve, reject, timer });

      try {
        socket.send(frame(buildInvocation(invocationId, target, args)));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(invocationId);
        reject(new PraxError('BUS_SEND_FAILED', `Could not send ${target}: ${(err as Error).message}`));
      }
    });
  }

  // ──────────────────────────────────────────────────────────────── internals

  private async openSocket(): Promise<void> {
    const session = this.client.currentSession;
    if (!session?.accessToken) {
      throw new PraxError(
        'BUS_REQUIRES_SESSION',
        'The Event Bus needs a signed-in end user - it authenticates with the session token, not ' +
        'with the workspace key. Call auth.login() (or finish an OIDC sign-in) first.'
      );
    }

    const WS = this.options.webSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (typeof WS !== 'function') {
      throw new PraxError(
        'NO_WEBSOCKET',
        'No WebSocket implementation is available. Node 22+ has one built in; on an older ' +
        'runtime pass one via the `webSocket` bus option.'
      );
    }

    this.setState(this._state === 'disconnected' ? 'connecting' : 'reconnecting');

    // The token rides in the query string because a browser WebSocket cannot set headers, and
    // withCredentials is never used: the gateway answers Access-Control-Allow-Origin: *, which
    // the CORS spec forbids combining with credentialed requests.
    const socket = new WS(busSocketUrl(this.client.baseUrl, session.accessToken));
    this.socket = socket;
    this.buffer = '';

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new PraxError('BUS_CONNECT_FAILED', message));
      };

      socket.onopen = () => {
        socket.send(frame(HANDSHAKE_FRAME));
      };

      socket.onmessage = (ev: MessageEvent) => {
        // The handshake answer is the first frame. Anything before it is not ours.
        if (!settled) {
          const text = typeof ev.data === 'string' ? ev.data : '';
          const { frames } = splitFrames(this.buffer + text);
          const first = frames[0];
          if (first !== undefined) {
            let handshake: Record<string, unknown>;
            try {
              handshake = JSON.parse(first) as Record<string, unknown>;
            } catch {
              return fail('The hub sent a handshake response that is not JSON.');
            }
            if (typeof handshake['error'] === 'string') {
              return fail(`The hub rejected the handshake: ${handshake['error']}`);
            }
            settled = true;
            this.buffer = '';
            this.setState('connected');
            this.reconnectDelay = 0;
            resolve();
            // Frames that arrived in the same physical message still need handling.
            for (const f of frames.slice(1)) this.handleFrame(f);
          }
          return;
        }
        this.onData(typeof ev.data === 'string' ? ev.data : '');
      };

      socket.onerror = () => fail(`Could not open the Event Bus connection to ${this.client.baseUrl}.`);

      socket.onclose = (ev: CloseEvent) => {
        if (!settled) {
          return fail(
            ev.code === 1006
              ? 'The Event Bus connection closed during the handshake. The commonest cause is an ' +
                'expired or rejected session token.'
              : `The Event Bus connection closed during the handshake (code ${ev.code}).`
          );
        }
        this.onClosed(ev.code);
      };
    });

    await this.rejoinAll();
  }

  private onData(text: string): void {
    const { frames, remainder } = splitFrames(this.buffer + text);
    this.buffer = remainder;
    for (const f of frames) this.handleFrame(f);
  }

  private handleFrame(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log.warn('Discarded an Event Bus frame that is not JSON.');
      return;
    }

    switch (message['type']) {
      case MSG.ping:
        return; // keepalive - never surface it
      case MSG.completion: {
        const id = String(message['invocationId'] ?? '');
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.resolve(parseBusResult(message));
        return;
      }
      case MSG.invocation:
        this.handleServerEvent(message);
        return;
      case MSG.close: {
        const why = typeof message['error'] === 'string' ? message['error'] : 'no reason given';
        log.warn(`The hub closed the connection: ${why}`);
        return;
      }
      default:
        return;
    }
  }

  private handleServerEvent(message: Record<string, unknown>): void {
    const target = String(message['target'] ?? '');
    const args = Array.isArray(message['arguments']) ? (message['arguments'] as unknown[]) : [];
    const first = (args[0] ?? {}) as Record<string, unknown>;

    switch (target) {
      case 'bus-event': {
        const event: Omit<BusEvent, 'bus'> = {
          fromUserId: String(first['fromUserId'] ?? ''),
          event: String(first['event'] ?? ''),
          payload: first['payload'] ?? null,
        };
        for (const channel of this.route(first)) channel.dispatch({ bus: channel.key, ...event });
        return;
      }
      case 'peer-joined':
      case 'peer-left': {
        const userId = String(first['userId'] ?? '');
        const kind = target === 'peer-joined' ? 'joined' : 'left';
        for (const channel of this.route(first)) channel.dispatchPeer(kind, userId);
        return;
      }
      case 'bus-evicted': {
        const key = normalizeBusKey(String(first['bus'] ?? ''));
        this.channels.get(key)?.dispatchEvicted();
        return;
      }
      default:
        log.verbose(`Ignoring an unknown Event Bus message: ${target}`);
    }
  }

  /**
   * Decides which channels an inbound message belongs to.
   *
   * The message names its bus, and that is the whole answer. The fallback below exists because a
   * gateway older than 2026-09-07 does not send the field: one connection carries every joined
   * bus, and SignalR reports which invocation arrived but never which group it came from, so on
   * such a server a client holding two buses genuinely cannot tell their traffic apart.
   *
   * With one bus joined the fallback is exact. With several it fans out, which can deliver another
   * bus's event to the wrong handler - so it says so once, loudly, rather than looking correct.
   */
  private route(message: Record<string, unknown>): PraxChannel[] {
    const named = typeof message['bus'] === 'string' ? normalizeBusKey(message['bus']) : '';
    if (named) {
      const channel = this.channels.get(named);
      return channel ? [channel] : [];
    }

    const joined = [...this.channels.values()].filter((c) => c.joined);
    if (joined.length > 1 && !this.warnedAboutRouting) {
      this.warnedAboutRouting = true;
      log.warn(
        'This gateway sends bus messages without naming their bus, so events cannot be routed to ' +
        'the channel they came from. Handlers on every joined channel will see them. Update the ' +
        'gateway, or hold one bus per connection until you can.'
      );
    }
    return joined;
  }

  private onClosed(code: number): void {
    this.socket = null;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new PraxError('BUS_DISCONNECTED', `The connection closed before ${id} completed.`));
    }
    this.pending.clear();
    for (const c of this.channels.values()) c.joined = false;

    if (this.closedByUs || !this.options.autoReconnect) {
      this.setState('disconnected');
      return;
    }

    this.setState('reconnecting');
    this.reconnectDelay = this.reconnectDelay
      ? Math.min(this.reconnectDelay * 2, this.options.maxReconnectDelayMs)
      : this.options.reconnectDelayMs;

    log.info(`Event Bus connection closed (code ${code}); reconnecting in ${this.reconnectDelay}ms.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => log.warn(`Event Bus reconnect failed: ${(err as Error).message}`));
    }, this.reconnectDelay);
  }

  /**
   * Re-joins every bus the app still wants.
   *
   * This is not optional bookkeeping. SignalR group membership does not survive a reconnect, so a
   * client that reconnects and stops there is connected and in no groups - receiving nothing,
   * reporting no error, and looking for all the world like a broken server.
   *
   * Re-joining calls JoinBus again, which re-runs the topic's access rule. The SDK never replays
   * a membership list for the server to take on faith.
   */
  private async rejoinAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      if (!channel.wanted || channel.joined) continue;
      try {
        await channel.join();
        log.info(`Re-joined "${channel.key}" after reconnecting.`);
      } catch (err) {
        log.warn(`Could not re-join "${channel.key}": ${(err as Error).message}`);
      }
    }
  }

  private setState(state: BusState): void {
    if (this._state === state) return;
    this._state = state;
    for (const h of this.stateHandlers) safely(h, state);
  }
}

function safely<T>(handler: (v: T) => void, value: T): void {
  try {
    handler(value);
  } catch (e) {
    log.error(`An Event Bus handler threw: ${(e as Error).message}`);
  }
}
