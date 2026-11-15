import { EmailMessage } from "cloudflare:email";

const ORIGINS = ["https://fdgmaker.com", "https://www.fdgmaker.com"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const b64 = (s) => { const u = new TextEncoder().encode(s); let bin = ""; for (const c of u) bin += String.fromCharCode(c); return btoa(bin).replace(/.{1,76}/g, "$&\r\n"); };
const hdr = (s) => "=?UTF-8?B?" + btoa(String.fromCharCode(...new TextEncoder().encode(s))) + "?=";
const clean = (s, n) => String(s || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);
const recent = new Map();

async function contact(req, env) {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const origin = req.headers.get("origin") || "";
  if (!ORIGINS.includes(origin)) return json({ ok: false, error: "origin" }, 403);
  if ((+req.headers.get("content-length") || 0) > 20000) return json({ ok: false, error: "size" }, 413);
  let d; try { d = await req.json(); } catch { return json({ ok: false, error: "json" }, 400); }
  const nome = clean(d.nome, 80), email = clean(d.email, 120), assunto = clean(d.assunto, 60) || "Contato", msg = String(d.msg || "").slice(0, 4000).trim();
  if (d.site || (+d.t || 0) < 3000) return json({ ok: true }); // robô: finge sucesso
  if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || msg.length < 5) return json({ ok: false, error: "invalid" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "?", now = Date.now(), last = recent.get(ip) || 0;
  if (now - last < 60000) return json({ ok: false, error: "rate" }, 429);
  recent.set(ip, now); if (recent.size > 5000) recent.clear();
  const to = env.CONTACT_TO, from = "site@fdgmaker.com";
  if (!to || !env.MAIL) return json({ ok: false, error: "config" }, 500);
  const body = `Nome: ${nome}\nE-mail: ${email}\nAssunto: ${assunto}\nPaís: ${req.headers.get("cf-ipcountry") || "?"}\n\n${msg}\n`;
  const raw = [
    `From: FDG Maker <${from}>`, `To: <${to}>`, `Reply-To: ${hdr(nome)} <${email}>`,
    `Subject: ${hdr("[FDG Maker] " + assunto + " — " + nome)}`,
    `Message-ID: <${crypto.randomUUID()}@fdgmaker.com>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(body),
  ].join("\r\n");
  try { await env.MAIL.send(new EmailMessage(from, to, raw)); } catch (e) { return json({ ok: false, error: "send" }, 502); }
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/contact") return contact(req, env);
    return env.ASSETS.fetch(req);
  },
};
