// POST /asistente: the store's shopping assistant. The web chat (and
// later the app) sends the conversation; the Worker asks Claude, which
// may search the catalog (read-only, Admin API) before answering.
//
// Security and privacy: the Anthropic key never leaves the Worker; no
// conversation is stored; usage limits are counted under a hash of the
// day and the caller's IP (never the IP itself). Only the store's own
// sites may call this from a browser (CORS allow-list).

import { errorResponse, jsonResponse, readJsonBody, type Env } from '../env';
import { getProduct, searchProducts, type ProductCard } from './catalog';
import { systemPrompt, TOOLS } from './prompt';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-haiku-5-5';
// Room for 3-5 products with links: 900 cut answers in half (30/10/2026).
const MAX_TOKENS = 2000;
/** Tool rounds per question (each is one Claude call plus searches). */
const MAX_TOOL_ROUNDS = 4;
/** Only the latest turns are sent: enough context, bounded cost. */
const MAX_TURNS = 8;
const MAX_MESSAGE_CHARS = 1000;
export const DEFAULT_DAILY_PER_VISITOR = 30;
export const DEFAULT_DAILY_TOTAL = 600;

/** The store's own sites, from `ALLOWED_ORIGINS` in [vars]. */
export function allowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

type Role = 'user' | 'assistant';
interface ChatMessage {
  role: Role;
  content: string;
}

/** The CORS headers for a browser caller, or none for anyone else. The
 * Worker's own pages (the test page) are same-origin and need none. */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).has(origin)) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export async function handleAssistantPreflight(request: Request, env: Env): Promise<Response> {
  const headers = corsHeaders(request, env);
  return new Response(null, { status: Object.keys(headers).length > 0 ? 204 : 403, headers });
}

/** The conversation from the body, trimmed to the last turns, or `null`
 * when malformed. It must alternate and end with the customer. */
export function parseConversation(body: Record<string, unknown> | null): ChatMessage[] | null {
  const raw = body?.messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    const role = (item as { role?: unknown })?.role;
    const content = (item as { content?: unknown })?.content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return null;
    }
    const text = content.trim();
    if (text.length === 0 || (role === 'user' && text.length > MAX_MESSAGE_CHARS)) {
      return null;
    }
    messages.push({ role, content: role === 'assistant' ? text.slice(0, 4000) : text });
  }
  let recent = messages.slice(-MAX_TURNS);
  while (recent.length > 0 && recent[0].role !== 'user') {
    recent = recent.slice(1);
  }
  if (recent.length === 0 || recent[recent.length - 1].role !== 'user') {
    return null;
  }
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].role === recent[i - 1].role) {
      return null;
    }
  }
  return recent;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Counts this question against the visitor's and the store's daily
 * limits. `false` when either is already used up. */
async function takeQuota(env: Env, request: Request, now: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const keys = [
    { key: await sha256Hex(`asistente|${day}|ip|${ip}`), limit: positiveInt(env.ASSISTANT_DAILY_PER_VISITOR, DEFAULT_DAILY_PER_VISITOR) },
    { key: await sha256Hex(`asistente|${day}|total`), limit: positiveInt(env.ASSISTANT_DAILY_TOTAL, DEFAULT_DAILY_TOTAL) },
  ];
  const counts: number[] = [];
  for (const { key, limit } of keys) {
    const row = await env.DB.prepare('SELECT count FROM assistant_usage WHERE key = ?').bind(key).first<{ count: number }>();
    const count = row?.count ?? 0;
    if (count >= limit) {
      return false;
    }
    counts.push(count);
  }
  await env.DB.batch(
    keys.map(({ key }, index) =>
      env.DB.prepare('INSERT OR REPLACE INTO assistant_usage (key, count, updated_at) VALUES (?, ?, ?)').bind(key, counts[index] + 1, now),
    ),
  );
  return true;
}

/** Cron: forgets usage counters older than two days. */
export async function pruneAssistantUsage(env: Env, now: number): Promise<void> {
  await env.DB.prepare('DELETE FROM assistant_usage WHERE updated_at < ?')
    .bind(now - 2 * 24 * 60 * 60 * 1000)
    .run();
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

interface ClaudeReply {
  content?: ContentBlock[];
  stop_reason?: string;
}

async function callClaude(env: Env, messages: unknown[]): Promise<ClaudeReply> {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ASSISTANT_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt({ name: env.STORE_NAME, url: env.STORE_URL, email: env.STORE_EMAIL }),
      tools: TOOLS,
      messages,
    }),
  });
  if (!response.ok) {
    // Status and Anthropic's error type only: never the conversation.
    const detail = (await response.json().catch(() => null)) as { error?: { type?: string; message?: string } } | null;
    console.error('assistant: anthropic_failed', response.status, detail?.error?.type ?? '', detail?.error?.message ?? '');
    throw Object.assign(new Error('anthropic_failed'), { status: response.status });
  }
  return (await response.json()) as ClaudeReply;
}

/** Runs one tool call; returns its result for Claude and remembers every
 * product card shown, so the chat can display the recommended ones. */
async function runTool(
  env: Env,
  name: string,
  input: Record<string, unknown>,
  seen: Map<string, ProductCard>,
): Promise<string> {
  try {
    if (name === 'buscar_productos') {
      const query = typeof input.consulta === 'string' ? input.consulta : '';
      const number = (value: unknown) => (typeof value === 'number' ? value : undefined);
      const result = await searchProducts(env, query, {
        limit: number(input.cantidad),
        minPrice: number(input.precio_min),
        maxPrice: number(input.precio_max),
        exclude: Array.isArray(input.excluir) ? input.excluir.filter((handle): handle is string => typeof handle === 'string').slice(0, 40) : [],
      });
      result.products.forEach((card) => seen.set(card.url, card));
      if (result.products.length === 0) {
        return 'Sin resultados para esa búsqueda.';
      }
      return JSON.stringify({
        coincidencias: result.total,
        precios: result.priceRange,
        nota: 'Selección repartida de más barato a más caro. Para afinar por presupuesto, busca de nuevo con precio_min o precio_max.',
        productos: result.products.map(({ priceFrom, ...card }) => card),
      });
    }
    if (name === 'ver_producto') {
      const card = await getProduct(env, typeof input.handle === 'string' ? input.handle : '');
      if (card) {
        seen.set(card.url, card);
        return JSON.stringify(card);
      }
      return 'Ese producto no existe o no está a la venta.';
    }
    return 'Herramienta desconocida.';
  } catch {
    return `Error al consultar el catálogo. Pide disculpas y sugiere escribir a ${env.STORE_EMAIL}.`;
  }
}

/** The text of Claude's answer and the products it links to. */
export async function answer(env: Env, conversation: ChatMessage[]): Promise<{ reply: string; products: ProductCard[] }> {
  const messages: unknown[] = conversation.map((message) => ({ role: message.role, content: message.content }));
  const seen = new Map<string, ProductCard>();
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const reply = await callClaude(env, messages);
    const blocks = reply.content ?? [];
    const toolUses = blocks.filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use');
    if (reply.stop_reason !== 'tool_use' || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
      const text = blocks
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      // Cheapest first, like the answer (the owner's rule, 30/10/2026).
      const products = [...seen.values()].filter((card) => text.includes(card.url))
        .sort((a, b) => a.priceFrom - b.priceFrom)
        .slice(0, 6);
      return { reply: text || 'Perdona, no he podido preparar una respuesta. ¿Puedes repetirme la pregunta?', products };
    }
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const toolUse of toolUses) {
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: await runTool(env, toolUse.name, toolUse.input ?? {}, seen),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('unreachable');
}

export async function handleAssistant(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).has(origin) && origin !== new URL(request.url).origin) {
    return errorResponse('forbidden_origin', 403);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return withCors(errorResponse('assistant_not_configured', 503), request, env);
  }
  const conversation = parseConversation(await readJsonBody(request));
  if (!conversation) {
    return withCors(errorResponse('invalid_body', 400), request, env);
  }
  if (!(await takeQuota(env, request, Date.now()))) {
    return withCors(errorResponse('daily_limit', 429), request, env);
  }
  try {
    const result = await answer(env, conversation);
    return withCors(jsonResponse(result, 200), request, env);
  } catch {
    return withCors(errorResponse('assistant_unavailable', 502), request, env);
  }
}
