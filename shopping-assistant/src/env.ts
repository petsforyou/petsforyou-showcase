// The Worker's environment and the small JSON helpers every route uses.

export interface Env {
  /** `[vars]` in wrangler.toml: the store's myshopify.com domain. */
  SHOPIFY_STORE_DOMAIN: string;
  /** Optional secret (`wrangler secret put`): a long-lived Admin API
   * token (`shpat_…`, only from a legacy custom app). When unset, Admin
   * tokens come from the client credentials grant of a Dev Dashboard
   * app (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`, see
   * `shopifyAdmin.ts`). Scope needed here: `read_products`. */
  SHOPIFY_ADMIN_TOKEN?: string;
  /** Secret: the Dev Dashboard app's Client ID. */
  SHOPIFY_CLIENT_ID?: string;
  /** Secret: the Dev Dashboard app's Client secret. */
  SHOPIFY_CLIENT_SECRET?: string;
  /** Secret: Anthropic API key for the shopping assistant
   * (`/asistente`). While unset, the assistant answers 503. */
  ANTHROPIC_API_KEY?: string;
  /** `[vars]`: Claude model for the assistant. Default `claude-haiku-5-5`. */
  ASSISTANT_MODEL?: string;
  /** `[vars]`: assistant questions per visitor (IP) and day. Default 30. */
  ASSISTANT_DAILY_PER_VISITOR?: string;
  /** `[vars]`: assistant questions per day for the whole store, a cap on
   * the Anthropic bill. Default 600. */
  ASSISTANT_DAILY_TOTAL?: string;
  /** `[vars]`: the store's name, as the assistant introduces itself. */
  STORE_NAME: string;
  /** `[vars]`: the public store URL, e.g. `https://www.example.com`.
   * Product links outside it are never shown in the chat. */
  STORE_URL: string;
  /** `[vars]`: the customer service address the assistant refers to. */
  STORE_EMAIL: string;
  /** `[vars]`: comma-separated origins allowed to call `/asistente`
   * from a browser (the store's own sites). */
  ALLOWED_ORIGINS: string;
  /** `[[d1_databases]]` binding in wrangler.toml. */
  DB: D1Database;
}

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function errorResponse(error: string, status: number): Response {
  return jsonResponse({ error }, status);
}

/** The request's JSON object body, or `null` when it is not one. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
