// Read-only catalog lookups for the shopping assistant, through the
// Admin API the Worker already uses (scope `read_products`). Only active,
// published products are ever shown, and only the fields a customer
// would see on the product page.

import type { Env } from '../env';
import { adminGraphql } from '../shopifyAdmin';

/** Hard cap on products per search, whatever the model asks for. */
export const MAX_SEARCH_RESULTS = 8;

/** How many matches are read from Shopify before choosing which ones to
 * show: a word like «cama» matches over a hundred products, and the
 * first few by relevance are not the whole range of prices. */
const SEARCH_POOL = 40;

const productFields = (variants: number) => `
  title
  handle
  vendor
  productType
  tags
  onlineStoreUrl
  priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
  options { name values }
  featuredMedia { preview { image { url(transform: { maxWidth: 400 }) } } }
  variants(first: ${variants}) { nodes { title availableForSale price } }
`;

const SEARCH_QUERY = `query AssistantSearch($q: String!, $n: Int!) {
  products(first: $n, query: $q, sortKey: RELEVANCE) {
    nodes { ${productFields(10)} description(truncateAt: 300) }
  }
}`;

const PRODUCT_QUERY = `query AssistantProduct($q: String!) {
  products(first: 1, query: $q) {
    nodes { ${productFields(40)} description(truncateAt: 4000) }
  }
}`;

interface RawProduct {
  title?: string;
  handle?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  onlineStoreUrl?: string | null;
  description?: string;
  priceRangeV2?: { minVariantPrice?: { amount?: string }; maxVariantPrice?: { amount?: string } };
  options?: { name?: string; values?: string[] }[];
  featuredMedia?: { preview?: { image?: { url?: string } | null } | null } | null;
  variants?: { nodes?: { title?: string; availableForSale?: boolean; price?: string }[] };
}

/** What the model sees about one product (and what the widget shows). */
export interface ProductCard {
  title: string;
  handle: string;
  url: string;
  image: string | null;
  price: string;
  vendor: string;
  type: string;
  availability: string;
  /** Delivery time to Spain, as the product page's shipping box shows it. */
  delivery: string;
  options: string[];
  variants: { title: string; price: string; available: boolean }[];
  description: string;
  /** Lowest variant price in euros, to filter and spread by price. */
  priceFrom: number;
}

function euros(amount: string | undefined): string {
  const value = Number(amount);
  return Number.isFinite(value) ? `${value.toFixed(2).replace('.', ',')} €` : '';
}

/** Products tagged `bajo-pedido` are made when ordered: never «sold
 * out», whatever their stock says. */
function isMadeToOrder(product: RawProduct): boolean {
  return (product.tags ?? []).some((tag) => tag.toLowerCase() === 'bajo-pedido');
}

/** Delivery times by product tag, as the product page's shipping box
 * shows them. The first matching tag wins. */
const DELIVERY_BY_TAG: [tag: string, delivery: string][] = [
  ['plazo-7-15', 'entre 7 y 15 días'],
  ['plazo-3-5', 'entre 3 y 5 días'],
  ['plazo-5-10', 'entre 5 y 10 días'],
];

/** The delivery time the theme's «Envío y plazo de entrega» box shows,
 * from the product's tags. Products without a known tag have their own
 * text in the theme, which the model can't see: it must not guess it. */
export function deliveryFor(product: RawProduct): string {
  const tags = (product.tags ?? []).map((tag) => tag.toLowerCase());
  if (isMadeToOrder(product)) {
    return 'bajo pedido: 1-2 semanas';
  }
  const known = DELIVERY_BY_TAG.find(([tag]) => tags.includes(tag));
  return known ? known[1] : 'sin dato aquí: está en el recuadro «Envío y plazo de entrega» de la ficha';
}

function toCard(product: RawProduct, storeUrl: string): ProductCard | null {
  if (!product.title || !product.handle) {
    return null;
  }
  const variants = (product.variants?.nodes ?? []).map((variant) => ({
    title: variant.title ?? '',
    price: euros(variant.price),
    available: variant.availableForSale === true,
  }));
  const min = euros(product.priceRangeV2?.minVariantPrice?.amount);
  const max = euros(product.priceRangeV2?.maxVariantPrice?.amount);
  let availability: string;
  if (isMadeToOrder(product)) {
    availability = 'bajo pedido: se fabrica al recibir el pedido (1-2 semanas); NO está agotado';
  } else if (variants.some((variant) => variant.available)) {
    availability = 'disponible';
  } else {
    availability = 'agotado ahora mismo';
  }
  return {
    title: product.title,
    handle: product.handle,
    url: product.onlineStoreUrl || `${storeUrl.replace(/\/+$/, '')}/products/${product.handle}`,
    image: product.featuredMedia?.preview?.image?.url ?? null,
    price: min === max ? min : `${min} - ${max}`,
    vendor: product.vendor ?? '',
    type: product.productType ?? '',
    availability,
    delivery: deliveryFor(product),
    options: (product.options ?? [])
      .filter((option) => option.name && option.name !== 'Title')
      .map((option) => `${option.name}: ${(option.values ?? []).join(' / ')}`),
    variants: variants.length > 1 ? variants : [],
    description: (product.description ?? '').replace(/\s+/g, ' ').trim(),
    priceFrom: Number(product.priceRangeV2?.minVariantPrice?.amount) || 0,
  };
}

/** Shopify search syntax characters a free-text query must not inject. */
function cleanTerms(text: string): string {
  return text
    .replace(/[():"'\\*]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const BASE_FILTER = 'status:active AND published_status:published';

export interface SearchOptions {
  limit?: number;
  /** Price bounds in euros (on the cheapest variant), when the customer
   * gave a budget. */
  minPrice?: number;
  maxPrice?: number;
  /** Handles already shown, so «more options» brings new ones. */
  exclude?: string[];
}

export interface SearchResult {
  /** How many matches were read (up to the pool size), after the price
   * filter. */
  total: number;
  /** Cheapest and dearest of those matches, e.g. «22,99 € - 292,99 €». */
  priceRange: string;
  products: ProductCard[];
}

/** `count` cards spread from the cheapest to the dearest, so the
 * customer sees affordable, middle and premium options, not only the
 * ones that happen to come first. The spread leans to the cheap end (a
 * first look at only dear products sends customers away: the owner's
 * rule, 30/10/2026), always starts at the cheapest and ends at the dearest.
 * Cheapest first. */
export function spreadByPrice(cards: ProductCard[], count: number): ProductCard[] {
  const sorted = [...cards].sort((a, b) => a.priceFrom - b.priceFrom);
  if (sorted.length <= count) {
    return sorted;
  }
  const picked = new Set<number>();
  for (let i = 0; i < count; i++) {
    picked.add(Math.round(Math.pow(i / (count - 1 || 1), 1.5) * (sorted.length - 1)));
  }
  return [...picked].map((index) => sorted[index]);
}

/** Lower case without accents, for comparing a title with the search. */
function plain(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Whether every searched word (or its singular) is in the title: a
 * «cama» search also matches a bulb that mentions beds in its text. */
function titleHas(card: ProductCard, words: string[]): boolean {
  const title = plain(card.title);
  return words.every((word) => title.includes(word.replace(/e?s$/, '')));
}

function bound(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Products matching a customer's words, within a budget if given, as a
 * spread of prices. Matches with every word come first; if they are
 * fewer than asked for, matches with any word fill the rest. */
export async function searchProducts(env: Env, text: string, options: SearchOptions = {}): Promise<SearchResult> {
  const empty: SearchResult = { total: 0, priceRange: '', products: [] };
  const terms = cleanTerms(text);
  if (!terms) {
    return empty;
  }
  const n = Math.min(Math.max(1, Math.floor(options.limit ?? 6) || 6), MAX_SEARCH_RESULTS);
  const min = bound(options.minPrice);
  const max = bound(options.maxPrice);
  type Data = { products?: { nodes?: RawProduct[] } };
  const shown = new Set((options.exclude ?? []).map((handle) => handle.trim().toLowerCase()));
  const inBudget = (card: ProductCard) =>
    !shown.has(card.handle) && (min === null || card.priceFrom >= min) && (max === null || card.priceFrom <= max);
  const fetchCards = async (q: string) => {
    const data = await adminGraphql<Data>(env, SEARCH_QUERY, { q: `${BASE_FILTER} AND ${q}`, n: SEARCH_POOL });
    return (data.products?.nodes ?? []).map((node) => toCard(node, env.STORE_URL)).filter((card): card is ProductCard => card !== null && inBudget(card));
  };
  let cards = await fetchCards(terms);
  const words = terms.split(' ').filter((word) => word.length > 2);
  if (cards.length < n && words.length > 1) {
    const known = new Set(cards.map((card) => card.handle));
    cards = cards.concat((await fetchCards(`(${words.join(' OR ')})`)).filter((card) => !known.has(card.handle)));
  }
  if (cards.length === 0) {
    return empty;
  }
  const prices = cards.map((card) => card.priceFrom);
  // Products named after the search come first; others only fill in.
  const named = words.length > 0 ? cards.filter((card) => titleHas(card, words.map(plain))) : [];
  const chosen = spreadByPrice(named, n);
  const rest = spreadByPrice(cards.filter((card) => !named.includes(card)), n - chosen.length);
  return {
    total: cards.length,
    priceRange: `${euros(String(Math.min(...prices)))} - ${euros(String(Math.max(...prices)))}`,
    products: spreadByPrice([...chosen, ...rest], n),
  };
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

/** One product by its handle, with its full description (sizes,
 * materials, delivery time). `null` when unknown or not on sale. */
export async function getProduct(env: Env, handle: string): Promise<ProductCard | null> {
  const clean = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(clean)) {
    return null;
  }
  type Data = { products?: { nodes?: RawProduct[] } };
  const data = await adminGraphql<Data>(env, PRODUCT_QUERY, { q: `${BASE_FILTER} AND handle:${clean}` });
  const node = data.products?.nodes?.[0];
  return node && node.handle === clean ? toCard(node, env.STORE_URL) : null;
}
