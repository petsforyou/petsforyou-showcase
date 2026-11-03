// The web chat: GET /asistente/widget.js is one self-contained script
// the store's theme loads (a single <script> tag before </body>); it
// draws a chat bubble and talks to POST /asistente on the same Worker.
// GET /asistente/prueba is a private-looking test page with the same
// widget, to try it before it goes on the store. The store's name,
// e-mail and host come from the Worker's [vars].

import type { Env } from '../env';

const widgetJs = (config: string) => String.raw`(function () {
  var CFG = ${config};
  if (window.__pfyAsistente) return;
  window.__pfyAsistente = true;
  var script = document.currentScript;
  var API = new URL('/asistente', script ? script.src : location.href).href;
  var KEY = 'pfy-asistente-v1';
  var GREETING = '¡Hola! Soy el asistente de ' + CFG.name + ', una inteligencia artificial. Cuéntame qué mascota tienes y qué buscas, y te ayudo a elegir.';
  var history = [];
  try { history = JSON.parse(sessionStorage.getItem(KEY) || '[]') || []; } catch (e) { history = []; }

  var css = '#pfy-bot-btn{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;background:#7b4fd6;color:#fff;font-size:28px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}' +
    '#pfy-bot{position:fixed;right:16px;bottom:88px;z-index:2147483000;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 120px));background:#fff;color:#222;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '#pfy-bot.open{display:flex}#pfy-bot header{background:#7b4fd6;color:#fff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}' +
    '#pfy-bot header b{font-size:16px}#pfy-bot header small{display:block;opacity:.85;font-size:12px}#pfy-bot header button{background:none;border:0;color:#fff;font-size:22px;cursor:pointer}' +
    '#pfy-log{flex:1;overflow-y:auto;padding:12px;background:#f7f5fb}.pfy-m{margin:0 0 10px;padding:9px 12px;border-radius:12px;max-width:88%;white-space:pre-wrap;word-wrap:break-word}' +
    '.pfy-u{background:#7b4fd6;color:#fff;margin-left:auto}.pfy-a{background:#fff;border:1px solid #e6e0f3}.pfy-a a{color:#5b2fb6;font-weight:600}' +
    '.pfy-cards{display:flex;gap:8px;overflow-x:auto;margin:-2px 0 10px}.pfy-card{flex:0 0 132px;background:#fff;border:1px solid #e6e0f3;border-radius:10px;text-decoration:none;color:#222;font-size:12px;overflow:hidden}' +
    '.pfy-card img{width:100%;height:100px;object-fit:cover;display:block}.pfy-card span{display:block;padding:6px}.pfy-card em{font-style:normal;font-weight:700;color:#5b2fb6}' +
    '#pfy-form{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff}#pfy-in{flex:1;border:1px solid #ccc;border-radius:20px;padding:9px 14px;font:inherit;min-width:0}' +
    '#pfy-form button{border:0;border-radius:20px;background:#7b4fd6;color:#fff;padding:0 16px;font:inherit;cursor:pointer}#pfy-form button:disabled{opacity:.5}' +
    '#pfy-note{font-size:11px;color:#777;text-align:center;padding:0 10px 8px;background:#fff}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  var btn = document.createElement('button'); btn.id = 'pfy-bot-btn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Abrir el asistente de compras'); btn.textContent = '🐾';
  var box = document.createElement('div'); box.id = 'pfy-bot'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Asistente de compras de ' + CFG.name);
  box.innerHTML = '<header><div><b>Asistente de compras</b><small>Asistente de IA · puede equivocarse</small></div><button type="button" aria-label="Cerrar">×</button></header>' +
    '<div id="pfy-log" aria-live="polite"></div><form id="pfy-form"><input id="pfy-in" maxlength="1000" autocomplete="off" placeholder="Escribe tu pregunta…" aria-label="Tu pregunta"><button type="submit">Enviar</button></form>' +
    '<div id="pfy-note">Respuestas generadas por IA. Comprueba tallas y detalles en la ficha antes de comprar.</div>';
  document.body.appendChild(btn); document.body.appendChild(box);
  var log = box.querySelector('#pfy-log'), form = box.querySelector('#pfy-form'), input = box.querySelector('#pfy-in'), send = form.querySelector('button');

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { try { var x = new URL(u); return (x.protocol === 'https:' && (x.hostname === CFG.host || x.hostname.slice(-CFG.host.length - 1) === '.' + CFG.host)) ? x.href : null; } catch (e) { return null; } }
  function rich(text) {
    var out = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    return out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var u = safeUrl(url.replace(/&amp;/g, '&'));
      return u ? '<a href="' + esc(u) + '" target="_top">' + label + '</a>' : label;
    });
  }
  function bubble(role, text) {
    var d = document.createElement('div'); d.className = 'pfy-m ' + (role === 'user' ? 'pfy-u' : 'pfy-a');
    if (role === 'user') d.textContent = text; else d.innerHTML = rich(text);
    log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
  }
  function cards(products) {
    if (!products || !products.length) return;
    var row = document.createElement('div'); row.className = 'pfy-cards';
    products.forEach(function (p) {
      var u = safeUrl(p.url); if (!u) return;
      var a = document.createElement('a'); a.className = 'pfy-card'; a.href = u; a.target = '_top';
      a.innerHTML = (p.image ? '<img alt="" loading="lazy" src="' + esc(p.image) + '">' : '') + '<span>' + esc(p.title) + '<br><em>' + esc(p.price) + '</em></span>';
      row.appendChild(a);
    });
    log.appendChild(row); log.scrollTop = log.scrollHeight;
  }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-16))); } catch (e) {} }
  function render() {
    log.innerHTML = ''; bubble('assistant', GREETING);
    history.forEach(function (m) { bubble(m.role, m.content); if (m.products) cards(m.products); });
  }
  btn.addEventListener('click', function () { box.classList.toggle('open'); if (box.classList.contains('open')) input.focus(); });
  box.querySelector('header button').addEventListener('click', function () { box.classList.remove('open'); });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = input.value.trim(); if (!q || send.disabled) return;
    input.value = ''; history.push({ role: 'user', content: q }); bubble('user', q); save();
    var wait = bubble('assistant', 'Buscando en la tienda…'); send.disabled = true;
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.map(function (m) { return { role: m.role, content: m.content }; }) }) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function (res) {
        wait.remove();
        if (!res.ok) {
          var msg = res.status === 429 ? 'Hoy ya he respondido muchas preguntas. Vuelve mañana o escríbenos a ' + CFG.email + '.' : 'Ahora mismo no puedo responder. Inténtalo en un rato o escríbenos a ' + CFG.email + '.';
          history.pop(); save(); bubble('assistant', msg); return;
        }
        history.push({ role: 'assistant', content: res.body.reply, products: res.body.products }); save();
        bubble('assistant', res.body.reply); cards(res.body.products);
      })
      .catch(function () { wait.remove(); history.pop(); save(); bubble('assistant', 'No hay conexión. Inténtalo de nuevo en un momento.'); })
      .then(function () { send.disabled = false; input.focus(); });
  });
  render();
})();`;

const TEST_PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Prueba del asistente</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#faf8ff;color:#222}main{max-width:640px;margin:auto}h1{font-size:22px}</style></head>
<body><main><h1>Prueba del asistente de compras</h1>
<p>Página de pruebas, solo para la tienda. Pulsa la huella de abajo a la derecha y hazle preguntas como las de un cliente.</p>
<p>Ideas: «Busco un arnés resistente para una perra de agua de 12 kg», «¿Cuánto tarda el envío?», «¿Tenéis camas para gatos mayores?», «Mi perro vomita, ¿qué le doy?».</p></main>
<script src="/asistente/widget.js" defer></script></body></html>`;

/** The store's details for the widget, as a JS object literal that is
 * safe inside a script (no `<` to close it). Links are only shown to
 * the store's host and its subdomains (`www.` dropped). */
function widgetConfig(env: Env): string {
  const host = new URL(env.STORE_URL).hostname.replace(/^www\./, '');
  return JSON.stringify({ name: env.STORE_NAME, email: env.STORE_EMAIL, host }).replace(/</g, '\\u003c');
}

export async function handleWidgetScript(env: Env): Promise<Response> {
  return new Response(widgetJs(widgetConfig(env)), {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

export async function handleTestPage(): Promise<Response> {
  return new Response(TEST_PAGE, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
