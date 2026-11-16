const BASE = "https://generativelanguage.googleapis.com/v1beta";

async function api(key, pathAndQuery, body) {
  const res = await fetch(`${BASE}/${pathAndQuery}`, {
    method: body ? "POST" : "GET",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40000),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* corps vide */
  }
  return { ok: res.ok, status: res.status, json, msg: json?.error?.message || "" };
}

async function probe(key, model) {
  const r = await api(key, `models/${model}:generateContent`, { contents: [{ parts: [{ text: "Réponds : OK" }] }] });
  return { ok: r.ok, status: r.status, msg: r.msg };
}

// gemini-3.5-pro, gemini-2.5-flash… → le plus récent d'un type
function pickLatest(names, kind) {
  const re = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${kind}$`);
  return names
    .map((n) => n.replace(/^models\//, ""))
    .map((n) => ({ n, m: n.match(re) }))
    .filter((x) => x.m)
    .sort((a, b) => parseFloat(b.m[1]) - parseFloat(a.m[1]))[0]?.n;
}

async function test(key, wantedPro, wantedFlash) {
  const list = await api(key, "models?pageSize=200");
  if (!list.ok) {
    return { keyOk: false, status: list.status, msg: list.msg };
  }
  const names = (list.json.models || []).map((m) => m.name);
  const proCandidates = [...new Set([wantedPro, pickLatest(names, "pro")].filter(Boolean))];
  const flashCandidates = [...new Set([wantedFlash, pickLatest(names, "flash")].filter(Boolean))];

  let pro = null;
  let proMsg = "";
  for (const m of proCandidates) {
    const r = await probe(key, m);
    if (r.ok) {
      pro = m;
      break;
    }
    proMsg = `${r.status} ${r.msg}`.slice(0, 200);
  }
  let flash = null;
  for (const m of flashCandidates) {
    if ((await probe(key, m)).ok) {
      flash = m;
      break;
    }
  }
  return { keyOk: true, pro, flash, proMsg };
}

module.exports = { test };
