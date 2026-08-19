/**
 * Builds gateway URLs.
 *
 * The Praxsuite FrontDoor accepts a short form, `/{workspaceId}/query`, which it rewrites to the
 * backend's `/api/v1/gateway/{workspaceId}/query`. The SDK uses the short form: it is the
 * documented public shape, and going through the FrontDoor applies the edge rate limit and cache.
 *
 * Host matters. Praxsuite runs several independent tiers and a workspace exists on exactly one -
 * a workspace on another tier returns 404, not an error you can diagnose from the message.
 */
export const CLOUD_HOST = 'https://gateway.praxsuite.com';

/** Trims trailing slashes and defaults to https. */
export function normalizeBaseUrl(baseUrl?: string | null): string {
  if (!baseUrl || !baseUrl.trim()) return CLOUD_HOST;
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/** True for a plaintext URL that is not a loopback address. */
export function isInsecureRemote(baseUrl: string): boolean {
  if (!baseUrl.toLowerCase().startsWith('http://')) return false;
  const host = baseUrl.slice('http://'.length).split('/')[0]!.split(':')[0]!;
  return !['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host.toLowerCase());
}

export function workspaceBase(baseUrl: string, workspaceId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${workspaceId}`;
}

export const routes = {
  query: (b: string, w: string) => `${workspaceBase(b, w)}/query`,
  schema: (b: string, w: string) => `${workspaceBase(b, w)}/schema`,
  auth: (b: string, w: string, action: string) => `${workspaceBase(b, w)}/auth/${action}`,
  endpoint: (b: string, w: string, slug: string) =>
    `${workspaceBase(b, w)}/endpoint/${encodeURIComponent(slug)}`,
  files: (b: string, w: string, suffix?: string) =>
    suffix ? `${workspaceBase(b, w)}/files/${suffix}` : `${workspaceBase(b, w)}/files`,
  players: (b: string, w: string, suffix: string) => `${workspaceBase(b, w)}/players/${suffix}`,
};
