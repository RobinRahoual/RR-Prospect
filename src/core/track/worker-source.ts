/** Code du Worker Cloudflare (module ES), déployé par l'app dans le compte gratuit de Robin. */
export const WORKER_JS = `
const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
const TTL = 60 * 60 * 24 * 90;
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const pixel = /^\\/o\\/([A-Za-z0-9-]{8,64})\\.gif$/.exec(url.pathname);
    if (req.method === "GET" && pixel) {
      const key = "o:" + pixel[1];
      const cur = await env.KV.get(key, "json");
      // Seuls les identifiants enregistrés par l'app comptent ; les ouvertures < 15 s après l'envoi (scanners antivirus) sont ignorées
      if (cur && Date.now() - cur.created > 15000) {
        cur.opens = (cur.opens || 0) + 1;
        cur.first = cur.first || Date.now();
        cur.last = Date.now();
        await env.KV.put(key, JSON.stringify(cur), { expirationTtl: TTL });
      }
      return new Response(GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store, max-age=0" } });
    }
    if (url.pathname === "/health") return new Response("ok");
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const auth = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
      if (!same(auth, env.SECRET)) return json({ error: "unauthorized" }, 401);
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (url.pathname === "/api/register") {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(String(body.id))) return json({ error: "bad id" }, 400);
        await env.KV.put("o:" + body.id, JSON.stringify({ created: Date.now(), opens: 0 }), { expirationTtl: TTL });
        return json({ ok: true });
      }
      if (url.pathname === "/api/stats") {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        const out = {};
        for (const id of ids) {
          const v = await env.KV.get("o:" + id, "json");
          if (v) out[id] = { opens: v.opens || 0, first: v.first || null, last: v.last || null };
        }
        return json(out);
      }
    }
    return new Response("not found", { status: 404 });
  },
};
`;
