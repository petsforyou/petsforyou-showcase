// Access to the store's Admin GraphQL API.
//
// The token comes from one of two places:
// - `SHOPIFY_ADMIN_TOKEN`: a long-lived `shpat_…` token, which only a
//   legacy custom app (created in the Shopify admin before 2026-01-01)
//   can still give;
// - otherwise the client credentials grant of a Dev Dashboard app
//   (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`): Shopify answers with
//   a token valid for 24 hours, which is cached in the isolate and
//   requested again shortly before it expires. See
//   https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
//
// Security: no token or secret is ever logged or echoed; failures carry
// only a fixed code.

import type { Env } from './env';

export const ADMIN_API_VERSION = '2026-07';

/** A token this close to its expiry is requested again. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cached: { clientId: string; token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

/** Test-only: forgets the cached client credentials token. */
export function __resetAdminTokenForTests(): void {
  cached = null;
  inFlight = null;
}

/** Whether the Worker has some way to call the Admin API. */
export function hasAdminCredentials(env: Env): boolean {
  return Boolean(env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET));
}

/** An Admin error carrying Shopify's HTTP status (never a body or a
 * secret), so a caller can tell which step failed. */
function adminError(code: string, status: number, detail?: string): Error & { status: number; detail?: string } {
  return Object.assign(new Error(code), { status, detail });
}

async function requestClientCredentialsToken(env: Env, clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) {
    // Shopify's OAuth error text (e.g. "Missing or invalid client
    // secret") never contains a secret; shown to the owner to diagnose.
    const detail = await response
      .json()
      .then((body) => (body as { error_description?: unknown }).error_description)
      .catch(() => undefined);
    throw adminError('admin_token_failed', response.status, typeof detail === 'string' ? detail.slice(0, 160) : undefined);
  }
  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('admin_token_failed');
  }
  const lifetimeSeconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 86399;
  cached = { clientId, token: body.access_token, expiresAt: Date.now() + lifetimeSeconds * 1000 };
  return body.access_token;
}

/** An Admin API access token: `SHOPIFY_ADMIN_TOKEN` when set, otherwise
 * a (cached) client credentials token. Throws `admin_not_configured`
 * without either, `admin_token_failed` when Shopify refuses the grant.
 * Concurrent callers share one token request. */
export async function getAdminAccessToken(env: Env): Promise<string> {
  if (env.SHOPIFY_ADMIN_TOKEN) {
    return env.SHOPIFY_ADMIN_TOKEN;
  }
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('admin_not_configured');
  }
  if (cached && cached.clientId === clientId && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  if (!inFlight) {
    inFlight = requestClientCredentialsToken(env, clientId, clientSecret).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

function postAdminGraphql(env: Env, token: string, query: string, variables: Record<string, unknown>): Promise<Response> {
  return fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
}

/** Runs one Admin GraphQL operation and returns its `data`. Throws
 * `admin_api_failed` on a non-2xx answer or any GraphQL error (and the
 * token errors of `getAdminAccessToken`). A 401 on a cached client
 * credentials token (never on the legacy `SHOPIFY_ADMIN_TOKEN` override)
 * drops it and retries once with a freshly requested token. */
export async function adminGraphql<T>(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = await getAdminAccessToken(env);
  let response = await postAdminGraphql(env, token, query, variables);
  if (response.status === 401 && !env.SHOPIFY_ADMIN_TOKEN) {
    cached = null;
    const freshToken = await getAdminAccessToken(env);
    response = await postAdminGraphql(env, freshToken, query, variables);
  }
  if (!response.ok) {
    throw adminError('admin_api_failed', response.status);
  }
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error('admin_api_failed');
  }
  return (body.data ?? {}) as T;
}
