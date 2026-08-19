import type { PraxClient } from './client.js';
import { PraxError } from './errors.js';
import { log } from './log.js';
import { routes } from './routes.js';

export interface PraxColumnInfo {
  id: string;
  name: string;
  /** Praxsuite column type: ShortText, Number, Bool, Date, Enduser, File, Table, Status, ... */
  type: string;
  isKey: boolean;
  /** System-managed column. Never send these in an insert or update. */
  isNative: boolean;
  isRequired: boolean;
  pointsTo?: string;
  entityId?: string;
}

export interface PraxTableInfo {
  id: string;
  name: string;
  columns: PraxColumnInfo[];
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Maps table names to the GUIDs the query API needs.
 *
 * PraxQL addresses tables by GUID, which would otherwise mean pasting GUIDs through app code.
 * The schema endpoint returns only what the calling credential may see, so a missing table is
 * usually a scope that was never granted rather than a typo.
 */
export class PraxSchema {
  private readonly idsByName = new Map<string, string>();
  private readonly tablesByName = new Map<string, PraxTableInfo>();
  private fetchInFlight: Promise<void> | null = null;
  private fetched = false;

  constructor(private readonly client: PraxClient, private readonly autoFetch = true) {}

  get tables(): PraxTableInfo[] { return [...this.tablesByName.values()]; }
  get isLoaded(): boolean { return this.fetched; }

  /** Registers a name-to-GUID mapping by hand, skipping the schema request entirely. */
  register(name: string, id: string): void {
    if (!name?.trim()) throw new TypeError('A table name is required.');
    if (!GUID.test((id ?? '').trim())) throw new TypeError(`tableId must be a GUID, got: ${id}`);
    this.idsByName.set(name.trim().toLowerCase(), id.trim());
  }

  registerMany(tables: Record<string, string>): void {
    for (const [name, id] of Object.entries(tables ?? {})) this.register(name, id);
  }

  has(name: string): boolean {
    return !!name && this.idsByName.has(name.trim().toLowerCase());
  }

  describe(name: string): PraxTableInfo | undefined {
    return name ? this.tablesByName.get(name.trim().toLowerCase()) : undefined;
  }

  /** Fetches the schema. Concurrent callers share one request; it will not refetch unless asked. */
  fetch(force = false): Promise<void> {
    if (this.fetched && !force) return Promise.resolve();
    if (this.fetchInFlight) return this.fetchInFlight;

    this.fetchInFlight = (async () => {
      try {
        const body = await this.client.request(
          'GET', routes.schema(this.client.baseUrl, this.client.workspaceId), null, 'preferSession'
        );
        const list = Array.isArray(body['tables']) ? (body['tables'] as Record<string, unknown>[]) : [];

        for (const entry of list) {
          const name = typeof entry['name'] === 'string' ? entry['name'] : '';
          const id = typeof entry['id'] === 'string' ? entry['id'] : '';
          if (!name || !id) continue;

          const columns: PraxColumnInfo[] = Array.isArray(entry['columns'])
            ? (entry['columns'] as Record<string, unknown>[]).map((c) => ({
                id: String(c['id'] ?? ''),
                name: String(c['name'] ?? ''),
                type: String(c['type'] ?? ''),
                isKey: c['isKey'] === true,
                isNative: c['isNative'] === true,
                isRequired: c['isRequired'] === true,
                pointsTo: typeof c['pointsTo'] === 'string' ? c['pointsTo'] : undefined,
                entityId: typeof c['entityId'] === 'string' ? c['entityId'] : undefined,
              }))
            : [];

          const key = name.toLowerCase();
          // A manual register() wins: it was an explicit choice by the developer.
          if (!this.idsByName.has(key)) this.idsByName.set(key, id);
          this.tablesByName.set(key, { id, name, columns });
        }

        this.fetched = true;
        log.info(`Schema loaded: ${list.length} table(s) visible to this credential.`);
      } finally {
        this.fetchInFlight = null;
      }
    })();

    return this.fetchInFlight;
  }

  /**
   * Resolves a table name or GUID to a GUID. A GUID passes straight through, so an app never has
   * to depend on the schema request at all.
   */
  async resolve(nameOrId: string): Promise<string> {
    if (!nameOrId?.trim()) throw new TypeError('A table name or id is required.');
    const key = nameOrId.trim();
    if (GUID.test(key)) return key;

    const known = this.idsByName.get(key.toLowerCase());
    if (known) return known;

    if (this.autoFetch) {
      await this.fetch();
      const found = this.idsByName.get(key.toLowerCase());
      if (found) return found;
    }

    const visible = [...this.idsByName.keys()].sort();
    throw new PraxError(
      'UNKNOWN_TABLE',
      `Table "${key}" is not available to this credential.\n\n` +
      (visible.length === 0
        ? 'The schema endpoint returned no tables, which means this credential has no table ' +
          "scopes with introspection enabled. Grant one in API Gateway settings, or call " +
          'schema.register(name, id) and skip the lookup.'
        : `Visible tables: ${visible.join(', ')}\n\nNames are case-insensitive but must ` +
          'otherwise match. If the table exists but is missing here, its scope has not been ' +
          'granted to this credential or role.')
    );
  }
}
