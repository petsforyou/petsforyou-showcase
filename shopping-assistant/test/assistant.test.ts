import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/env';
import { deliveryFor, spreadByPrice, type ProductCard } from '../src/assistant/catalog';
import { parseConversation, pruneAssistantUsage } from '../src/assistant/handler';
import { createFakeD1, dumpTable } from './support/fakeD1';

const ORIGIN = 'https://shopping-assistant.example.workers.dev';
const ADMIN_URL = 'https://example-store.myshopify.com/admin/api/2026-07/graphql.json';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const STORE = 'https://www.example-petshop.com';
const EMAIL = 'hola@example-petshop.com';

const MAXIMUS = {
  title: 'Arnés de cuero artesanal para perros medianos',
  handle: 'arnes-de-cuero-para-perros-medianos',
  vendor: 'Example',
  productType: 'Harnesses',
  tags: ['bajo-pedido', 'perros'],
  onlineStoreUrl: `${STORE}/products/arnes-de-cuero-para-perros-medianos`,
  description: 'Cuero genuino de 4 mm. La talla M, a pechos de 50 a 75 cm.',
  priceRangeV2: { minVariantPrice: { amount: '128.99' }, maxVariantPrice: { amount: '189.99' } },
  options: [{ name: 'Talla', values: ['S', 'M'] }],
  featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/arnes-cuero.jpg' } } },
  variants: { nodes: [{ title: 'S / Solo arnés', availableForSale: false, price: '128.99' }, { title: 'M / Solo arnés', availableForSale: false, price: '140.99' }] },
};

const TACTICO = {
  ...MAXIMUS,
  title: 'Arnés táctico con asa',
  handle: 'arnes-tactico-con-asa',
  vendor: 'Example',
  tags: ['plazo-5-10'],
  onlineStoreUrl: `${STORE}/products/arnes-tactico-con-asa`,
  variants: { nodes: [{ title: 'M', availableForSale: true, price: '27.99' }] },
  priceRangeV2: { minVariantPrice: { amount: '27.99' }, maxVariantPrice: { amount: '27.99' } },
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHOPIFY_STORE_DOMAIN: 'example-store.myshopify.com',
    STORE_NAME: 'Example Petshop',
    STORE_URL: STORE,
    STORE_EMAIL: EMAIL,
    ALLOWED_ORIGINS: `${STORE}, https://example-petshop.com`,
    SHOPIFY_ADMIN_TOKEN: 'shpat_test_admin_token',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    DB: createFakeD1(),
    ...overrides,
  };
}

function ask(messages: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/asistente`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
    body: JSON.stringify({ messages }),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Scripted Anthropic replies, in order, plus a fixed catalog. Records
 * every request body sent to each API. */
function mockApis(claudeReplies: unknown[], catalog: unknown[] = [MAXIMUS, TACTICO]) {
  const claudeBodies: any[] = [];
  const adminBodies: any[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url === ANTHROPIC_URL) {
      claudeBodies.push({ body, headers: init?.headers });
      const next = claudeReplies.shift();
      return next instanceof Response ? next : json(next);
    }
    if (url === ADMIN_URL) {
      adminBodies.push(body);
      const q: string = body.variables.q;
      const handle = /handle:([a-z0-9-]+)/.exec(q)?.[1];
      const nodes = handle ? catalog.filter((p: any) => p.handle === handle) : catalog;
      return json({ data: { products: { nodes } } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { claudeBodies, adminBodies, fetchMock };
}

const toolUse = (name: string, input: unknown, id = 'tu_1') => ({
  stop_reason: 'tool_use',
  content: [{ type: 'text', text: 'Miro el catálogo.' }, { type: 'tool_use', id, name, input }],
});
const finalText = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseConversation', () => {
  it('keeps a well-formed conversation that ends with the customer', () => {
    const conv = parseConversation({ messages: [{ role: 'user', content: ' hola ' }] });
    expect(conv).toEqual([{ role: 'user', content: 'hola' }]);
  });

  it('rejects malformed bodies', () => {
    expect(parseConversation(null)).toBeNull();
    expect(parseConversation({ messages: [] })).toBeNull();
    expect(parseConversation({ messages: [{ role: 'system', content: 'x' }] })).toBeNull();
    expect(parseConversation({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] })).toBeNull();
    expect(parseConversation({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).toBeNull();
    expect(parseConversation({ messages: [{ role: 'user', content: 'x'.repeat(1001) }] })).toBeNull();
  });

  it('sends only the last turns, starting with the customer', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
    const conv = parseConversation({ messages: many })!;
    expect(conv[0]).toEqual({ role: 'user', content: 'm6' });
    expect(conv.at(-1)).toEqual({ role: 'user', content: 'm12' });
    expect(conv.length).toBe(7);
  });
});

describe('POST /asistente', () => {
  it('answers 503 while the Anthropic key is not set', async () => {
    const res = await worker.fetch(ask([{ role: 'user', content: 'hola' }]), makeEnv({ ANTHROPIC_API_KEY: undefined }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'assistant_not_configured' });
  });

  it('answers 400 on a malformed conversation', async () => {
    mockApis([]);
    const res = await worker.fetch(ask([{ role: 'assistant', content: 'hola' }]), makeEnv());
    expect(res.status).toBe(400);
  });

  it('searches the catalog, then returns the reply and the linked products', async () => {
    const { claudeBodies, adminBodies } = mockApis([
      toolUse('buscar_productos', { consulta: 'arnés cuero', cantidad: 50 }),
      finalText(`Te recomiendo el [Arnés de cuero artesanal](${MAXIMUS.onlineStoreUrl}), de cuero de 4 mm.`),
    ]);
    const res = await worker.fetch(ask([{ role: 'user', content: 'Busco un arnés resistente a mordiscos' }]), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.reply).toContain('Arnés de cuero artesanal');
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({ handle: MAXIMUS.handle, price: '128,99 € - 189,99 €', image: 'https://cdn.shopify.com/arnes-cuero.jpg' });

    // Only active, published products, read as a wide pool to choose from.
    expect(adminBodies[0].variables.q).toBe('status:active AND published_status:published AND arnés cuero');
    expect(adminBodies[0].variables.n).toBe(40);

    // The key goes in the header, never in the body; the tool result is
    // sent back to Claude with its tool_use id.
    expect(claudeBodies[0].headers['x-api-key']).toBe('sk-ant-test');
    expect(JSON.stringify(claudeBodies[0].body)).not.toContain('sk-ant-test');
    expect(claudeBodies[0].body.model).toBe('claude-haiku-5-5');
    // The store's own name and e-mail, from [vars].
    expect(claudeBodies[0].body.system).toContain('Example Petshop');
    expect(claudeBodies[0].body.system).toContain(EMAIL);
    const toolResult = claudeBodies[1].body.messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(toolResult.content).toContain('bajo pedido');
  });

  it('marks made-to-order products as such, never as sold out', async () => {
    const { claudeBodies } = mockApis([toolUse('buscar_productos', { consulta: 'arnés' }), finalText('Hecho.')]);
    await worker.fetch(ask([{ role: 'user', content: 'arnés' }]), makeEnv());
    const cards = JSON.parse(claudeBodies[1].body.messages.at(-1).content[0].content).productos;
    const maximus = cards.find((c: any) => c.handle === MAXIMUS.handle);
    const tactico = cards.find((c: any) => c.handle === TACTICO.handle);
    expect(maximus.availability).toMatch(/^bajo pedido/);
    expect(tactico.availability).toBe('disponible');
  });

  it('tells the model how many matches and prices there are, and filters by budget', async () => {
    const { claudeBodies } = mockApis([
      toolUse('buscar_productos', { consulta: 'arnés' }),
      toolUse('buscar_productos', { consulta: 'arnés', precio_max: 50 }, 'tu_2'),
      finalText('Hecho.'),
    ]);
    await worker.fetch(ask([{ role: 'user', content: 'arnés barato' }]), makeEnv());
    const first = JSON.parse(claudeBodies[1].body.messages.at(-1).content[0].content);
    expect(first).toMatchObject({ coincidencias: 2, precios: '27,99 € - 128,99 €' });
    // Cheapest first, and the internal price number is not sent.
    expect(first.productos.map((c: any) => c.handle)).toEqual([TACTICO.handle, MAXIMUS.handle]);
    expect(first.productos[0].priceFrom).toBeUndefined();
    const budget = JSON.parse(claudeBodies[2].body.messages.at(-1).content[0].content);
    expect(budget.productos.map((c: any) => c.handle)).toEqual([TACTICO.handle]);
  });

  it('brings new products when asked for more, leaving out the ones shown', async () => {
    const { claudeBodies } = mockApis([toolUse('buscar_productos', { consulta: 'arnés', excluir: [TACTICO.handle] }), finalText('Hecho.')]);
    await worker.fetch(ask([{ role: 'user', content: 'enséñame más' }]), makeEnv());
    const result = JSON.parse(claudeBodies[1].body.messages.at(-1).content[0].content);
    expect(result.productos.map((c: any) => c.handle)).toEqual([MAXIMUS.handle]);
  });

  it('prefers products named after the search over ones that only mention it', async () => {
    const BOMBILLA = { ...TACTICO, title: 'Bombilla UVB para reptiles', handle: 'bombilla-uvb', onlineStoreUrl: `${STORE}/products/bombilla-uvb`, priceRangeV2: { minVariantPrice: { amount: '9.99' }, maxVariantPrice: { amount: '9.99' } } };
    const { claudeBodies } = mockApis([toolUse('buscar_productos', { consulta: 'arneses', cantidad: 2 }), finalText('Ok.')], [MAXIMUS, BOMBILLA, TACTICO]);
    await worker.fetch(ask([{ role: 'user', content: 'arneses' }]), makeEnv());
    const result = JSON.parse(claudeBodies[1].body.messages.at(-1).content[0].content);
    expect(result.coincidencias).toBe(3);
    expect(result.productos.map((c: any) => c.handle)).toEqual([TACTICO.handle, MAXIMUS.handle]);
  });

  it('fills a short exact search with matches of any word', async () => {
    const { adminBodies } = mockApis([toolUse('buscar_productos', { consulta: 'cama lifestyle', cantidad: 6 }), finalText('Ok.')]);
    await worker.fetch(ask([{ role: 'user', content: 'cama lifestyle' }]), makeEnv());
    expect(adminBodies.map((b) => b.variables.q)).toEqual([
      'status:active AND published_status:published AND cama lifestyle',
      'status:active AND published_status:published AND (cama OR lifestyle)',
    ]);
  });

  it('reads one product by handle and refuses handles with search syntax', async () => {
    const { adminBodies, claudeBodies } = mockApis([
      toolUse('ver_producto', { handle: MAXIMUS.handle }),
      toolUse('ver_producto', { handle: 'x OR status:draft' }, 'tu_2'),
      finalText('Listo.'),
    ]);
    await worker.fetch(ask([{ role: 'user', content: 'tallas del arnés de cuero' }]), makeEnv());
    expect(adminBodies).toHaveLength(1);
    expect(adminBodies[0].variables.q).toBe(`status:active AND published_status:published AND handle:${MAXIMUS.handle}`);
    expect(claudeBodies[2].body.messages.at(-1).content[0].content).toBe('Ese producto no existe o no está a la venta.');
  });

  it('strips search operators from the customer words', async () => {
    const { adminBodies } = mockApis([toolUse('buscar_productos', { consulta: 'cama OR status:draft (gato)' }), finalText('Ok.')]);
    await worker.fetch(ask([{ role: 'user', content: 'cama' }]), makeEnv());
    expect(adminBodies[0].variables.q).toBe('status:active AND published_status:published AND cama status draft gato');
  });

  it('answers 502 when Anthropic fails, and stores nothing but the counters', async () => {
    mockApis([json({ error: 'overloaded' }, 529)]);
    const env = makeEnv();
    const res = await worker.fetch(ask([{ role: 'user', content: 'hola' }]), env);
    expect(res.status).toBe(502);
    const rows = dumpTable(env.DB, 'assistant_usage');
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('203.0.113.7');
  });

  it('enforces the per-visitor daily limit', async () => {
    const env = makeEnv({ ASSISTANT_DAILY_PER_VISITOR: '2' });
    mockApis([finalText('uno'), finalText('dos'), finalText('tres')]);
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await worker.fetch(ask([{ role: 'user', content: 'hola' }]), env)).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    // Another visitor still gets answers.
    const other = await worker.fetch(ask([{ role: 'user', content: 'hola' }], { 'CF-Connecting-IP': '198.51.100.1' }), env);
    expect(other.status).toBe(200);
  });

  it('enforces the store-wide daily limit', async () => {
    const env = makeEnv({ ASSISTANT_DAILY_TOTAL: '1' });
    mockApis([finalText('uno'), finalText('dos')]);
    expect((await worker.fetch(ask([{ role: 'user', content: 'a' }]), env)).status).toBe(200);
    expect((await worker.fetch(ask([{ role: 'user', content: 'b' }], { 'CF-Connecting-IP': '198.51.100.1' }), env)).status).toBe(429);
  });

  it('stops after four tool rounds', async () => {
    const replies = Array.from({ length: 6 }, (_, i) => toolUse('buscar_productos', { consulta: 'arnés' }, `tu_${i}`));
    const { claudeBodies } = mockApis(replies);
    const res = await worker.fetch(ask([{ role: 'user', content: 'arnés' }]), makeEnv());
    expect(res.status).toBe(200);
    expect(claudeBodies).toHaveLength(5);
    expect(((await res.json()) as any).reply).toBe('Miro el catálogo.');
  });
});

describe('CORS', () => {
  it('allows the store origin, with a preflight', async () => {
    mockApis([finalText('hola')]);
    const pre = await worker.fetch(
      new Request(`${ORIGIN}/asistente`, { method: 'OPTIONS', headers: { Origin: STORE } }),
      makeEnv(),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(STORE);
    const res = await worker.fetch(ask([{ role: 'user', content: 'hola' }], { Origin: STORE }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(STORE);
  });

  it('refuses other sites', async () => {
    const fetchMock = mockApis([]).fetchMock;
    const pre = await worker.fetch(
      new Request(`${ORIGIN}/asistente`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
      makeEnv(),
    );
    expect(pre.status).toBe(403);
    const res = await worker.fetch(ask([{ role: 'user', content: 'hola' }], { Origin: 'https://evil.example' }), makeEnv());
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('widget and test page', () => {
  it('serves the chat script and the test page', async () => {
    const js = await worker.fetch(new Request(`${ORIGIN}/asistente/widget.js`), makeEnv());
    expect(js.headers.get('Content-Type')).toContain('javascript');
    const code = await js.text();
    expect(code).toContain('Asistente de IA');
    expect(() => new Function(code)).not.toThrow();
    // Links only to the store's own host, and its contact address.
    expect(code).toContain('"host":"example-petshop.com"');
    expect(code).toContain(EMAIL);
    const page = await worker.fetch(new Request(`${ORIGIN}/asistente/prueba`), makeEnv());
    expect(await page.text()).toContain('/asistente/widget.js');
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});

describe('pruneAssistantUsage', () => {
  it('forgets counters older than two days', async () => {
    const env = makeEnv();
    const now = Date.parse('2026-10-27T10:00:00Z');
    await env.DB.prepare('INSERT INTO assistant_usage (key, count, updated_at) VALUES (?, ?, ?)').bind('old', 3, now - 3 * 86400000).run();
    await env.DB.prepare('INSERT INTO assistant_usage (key, count, updated_at) VALUES (?, ?, ?)').bind('new', 1, now - 3600000).run();
    await pruneAssistantUsage(env, now);
    expect(dumpTable(env.DB, 'assistant_usage').map((r: any) => r.key)).toEqual(['new']);
  });
});

describe('spreadByPrice', () => {
  const card = (price: number) => ({ handle: `p${price}`, priceFrom: price }) as ProductCard;
  it('picks cheap, middle and premium options instead of the first ones', () => {
    const cards = [200, 30, 150, 25, 60, 90, 45, 300, 35].map(card);
    // Leaning to the cheap end, but from the cheapest to the dearest.
    expect(spreadByPrice(cards, 3).map((c) => c.priceFrom)).toEqual([25, 45, 300]);
    expect(spreadByPrice(cards, 5).map((c) => c.priceFrom)).toEqual([25, 30, 45, 90, 300]);
    expect(spreadByPrice(cards.slice(0, 2), 6)).toHaveLength(2);
  });
});

describe('deliveryFor', () => {
  it('gives the shipping-box time per tag, never a guess', () => {
    expect(deliveryFor({ tags: ['plazo-3-5'] })).toBe('entre 3 y 5 días');
    expect(deliveryFor({ tags: ['plazo-5-10'] })).toBe('entre 5 y 10 días');
    expect(deliveryFor({ tags: ['plazo-5-10', 'plazo-7-15'] })).toBe('entre 7 y 15 días');
    expect(deliveryFor({ tags: ['Bajo-Pedido'] })).toBe('bajo pedido: 1-2 semanas');
    expect(deliveryFor({ tags: ['otra-etiqueta'] })).toMatch(/^sin dato aquí/);
  });
});
