import { EmailMessage } from "cloudflare:email";
import R from "./routes.json";

const ORIGINS = ["https://fdgmaker.com", "https://www.fdgmaker.com"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const b64 = (s) => { const u = new TextEncoder().encode(s); let bin = ""; for (const c of u) bin += String.fromCharCode(c); return btoa(bin).replace(/.{1,76}/g, "$&\r\n"); };
const hdr = (s) => "=?UTF-8?B?" + btoa(String.fromCharCode(...new TextEncoder().encode(s))) + "?=";
const clean = (s, n) => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);
const recent = new Map();
const MAX_BODY = 20000;
/* lê o corpo com limite real de bytes, mesmo sem Content-Length (envio em partes) */
async function readLimited(req, max) {
  if (!req.body) return "";
  const reader = req.body.getReader(), parts = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch {} return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size); let o = 0; for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

async function contact(req, env) {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const origin = req.headers.get("origin") || "";
  if (!ORIGINS.includes(origin)) return json({ ok: false, error: "origin" }, 403);
  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json({ ok: false, error: "type" }, 415);
  if ((+req.headers.get("content-length") || 0) > MAX_BODY) return json({ ok: false, error: "size" }, 413);
  const text = await readLimited(req, MAX_BODY);
  if (text === null) return json({ ok: false, error: "size" }, 413);
  let d; try { d = JSON.parse(text); } catch { return json({ ok: false, error: "json" }, 400); }
  if (!d || typeof d !== "object" || Array.isArray(d)) return json({ ok: false, error: "json" }, 400);
  const nome = clean(d.nome, 80), email = clean(d.email, 120), assunto = clean(d.assunto, 60) || "Contato", msg = String(d.msg || "").slice(0, 4000).trim();
  if (d.site || (+d.t || 0) < 3000) return json({ ok: true }); // robô: finge sucesso
  if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || msg.length < 5) return json({ ok: false, error: "invalid" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "?", now = Date.now(), last = recent.get(ip) || 0;
  if (now - last < 60000) return json({ ok: false, error: "rate" }, 429);
  recent.set(ip, now); if (recent.size > 5000) recent.clear();
  const tos = String(env.CONTACT_TO || "contact@fdgmaker.com").split(",").map(x => x.trim()).filter(Boolean), from = "site@envio.fdgmaker.com";
  if (!env.MAIL) return json({ ok: false, error: "config" }, 500);
  const body = `Nome: ${nome}\nE-mail: ${email}\nAssunto: ${assunto}\nPaís: ${req.headers.get("cf-ipcountry") || "?"}\n\n${msg}\n`;
  const raw = [
    `From: FDG Maker <${from}>`, `To: ${tos.map(t => "<" + t + ">").join(", ")}`, `Reply-To: ${hdr(nome)} <${email}>`,
    `Subject: ${hdr("[FDG Maker] " + assunto + " — " + nome)}`,
    `Message-ID: <${crypto.randomUUID()}@fdgmaker.com>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(body),
  ].join("\r\n");
  let sent = 0;
  for (const to of tos) { try { await env.MAIL.send(new EmailMessage(from, to, raw)); sent++; } catch (e) {} }
  return sent ? json({ ok: true }) : json({ ok: false, error: "send" }, 502);
}

const SEGS = {pt:"pt-br",en:"en",es:"es",de:"de",zh:"zh-cn",fr:"fr",ja:"ja",it:"it",ko:"ko",pl:"pl",ru:"ru",cs:"cs",nl:"nl",tr:"tr",zt:"zh-tw"};
const B = "https://fdgmaker.com";
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
async function page(req, env, url) {
  let p = url.pathname;
  if (!p.endsWith("/")) return Response.redirect(B + p + "/" + url.search, 301);
  const r = R.routes[p];
  const res = await env.ASSETS.fetch(new Request(new URL("/", url), req));
  if (!r) return new Response(res.body, { status: 404, headers: res.headers });
  const [l, v, t, d, g] = r, alts = R.groups[g] || {};
  const links = Object.entries(alts).map(([k, u]) => `<link rel="alternate" hreflang="${R.href[k]}" href="${B}${u}">`).join("") +
    (alts.en ? `<link rel="alternate" hreflang="x-default" href="${B}${alts.en}">` : "");
  const paths = {}; for (const [k, u] of Object.entries(alts)) paths[k] = u;
  const boot = `<script>window.__ROUTE=${JSON.stringify({ l, v })};window.__PATHS=${JSON.stringify(paths)};</script>`;
  const out = new HTMLRewriter()
    .on("html", { element(e) { e.setAttribute("lang", R.href[l]); } })
    .on("head", { element(e) { e.prepend(boot, { html: true }); e.append(links, { html: true }); } })
    .on("title", { element(e) { e.setInnerContent(t); } })
    .on('meta[name="description"]', { element(e) { e.setAttribute("content", d); } })
    .on('meta[property="og:title"]', { element(e) { e.setAttribute("content", t); } })
    .on('meta[property="og:description"]', { element(e) { e.setAttribute("content", d); } })
    .on('meta[property="og:url"]', { element(e) { e.setAttribute("content", B + p); } })
    .on('link[rel="canonical"]', { element(e) { e.setAttribute("href", B + p); } })
    .transform(res);
  const h = new Headers(out.headers); h.set("content-language", R.href[l]); h.set("cache-control", "public, max-age=300");
  return new Response(out.body, { status: 200, headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/contact") return contact(req, env);
    const seg = url.pathname.split("/")[1];
    if (R.langs && Object.values(SEGS).includes(seg)) return page(req, env, url);
    return env.ASSETS.fetch(req);
  },
};
