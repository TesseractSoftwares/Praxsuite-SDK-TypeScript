import { PraxAuth } from './auth.js';
import { PraxClient, type PraxOptions } from './client.js';
import { PraxData } from './data.js';
import { PraxEndpoints } from './endpoints.js';
import { PraxSchema } from './schema.js';

export { PraxError, PraxSecurityError } from './errors.js';
export { f, type PraxFilter } from './filter.js';
export { classify, redact, PUBLISHABLE_PREFIX, SECRET_PREFIX, type KeyKind } from './keyguard.js';
export { scrub, setLogLevel, type LogLevel } from './log.js';
export { CLOUD_HOST, normalizeBaseUrl, isInsecureRemote, routes } from './routes.js';
export {
  parsePage, parseMutation, parseError, unwrapEnvelope,
  type PraxRow, type PraxPage, type PraxMutationResult,
} from './rows.js';
export {
  MemoryTokenStore, LocalStorageTokenStore,
  type PraxSession, type PraxTokenStore,
} from './storage.js';
export { PraxClient, type PraxOptions } from './client.js';
export { PraxQuery, PraxData } from './data.js';
export { PraxAuth, type PraxUser, type PraxAuthResult, type PraxWorkspaceConfig } from './auth.js';
export { PraxEndpoints } from './endpoints.js';
export { PraxSchema, type PraxTableInfo, type PraxColumnInfo } from './schema.js';

/**
 * A configured Praxsuite client.
 *
 * ```ts
 * const prax = createClient({ workspaceId: 'your-workspace-guid' });
 *
 * await prax.auth.login(email, password);
 *
 * // No user id anywhere - the server's row filter scopes this to the caller.
 * const save = await prax.data.from('Saves').first();
 *
 * // Anything valuable goes through the server.
 * const reward = await prax.endpoints.call('claim-daily-reward');
 * ```
 */
export interface Praxsuite {
  /** User accounts: register, sign in, sessions, password flows, OIDC. */
  auth: PraxAuth;
  /** Table reads and writes. */
  data: PraxData;
  /** Gateway endpoints - the server-authoritative path. */
  endpoints: PraxEndpoints;
  /** Table name to id mapping. */
  schema: PraxSchema;
  /** The underlying client - configuration, session, and the raw request method. */
  client: PraxClient;
}

/**
 * Creates a Praxsuite client.
 *
 * Setup is one field: your workspace id. The publishable key is fetched from the workspace's
 * public config endpoint on first use, so there is no second value to keep in sync and rotating
 * the key in the portal does not require a redeploy.
 *
 * A note on what is safe to ship: the publishable key is an identifier, not a credential. It can
 * be read out of any bundle, and `/auth/config` serves it unauthenticated, so **every table scope
 * granted to it is granted to anyone holding your workspace id**. Give it no table scopes at all
 * where you can - auth still works without them - and let signed-in users get their access from a
 * role instead. See SECURITY.md.
 */
export function createClient(options: PraxOptions): Praxsuite {
  const client = new PraxClient(options);
  const schema = new PraxSchema(client);
  return {
    client,
    schema,
    auth: new PraxAuth(client),
    data: new PraxData(client, schema),
    endpoints: new PraxEndpoints(client),
  };
}
