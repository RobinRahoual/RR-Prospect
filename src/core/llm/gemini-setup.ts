import { GEMINI_BASE } from "./gemini";

interface ApiResult {
  ok: boolean;
  status: number;
  msg: string;
  json: { models?: { name: string }[] };
}

async function api(f: typeof fetch, key: string, pathAndQuery: string, body?: unknown): Promise<ApiResult> {
  const res = await f(`${GEMINI_BASE}/${pathAndQuery}`, {
    method: body ? "POST" : "GET",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40_000),
  });
  const json = (await res.json().catch(() => ({}))) as ApiResult["json"] & { error?: { message?: string } };
  return { ok: res.ok, status: res.status, msg: json.error?.message ?? "", json };
}

const probe = (f: typeof fetch, key: string, model: string) =>
  api(f, key, `models/${model}:generateContent`, { contents: [{ parts: [{ text: "Réponds : OK" }] }] });

/** gemini-3.5-pro, gemini-2.5-flash… → le plus récent d'un type */
export function pickLatest(names: string[], kind: "pro" | "flash"): string | undefined {
  const re = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${kind}$`);
  return names
    .map((n) => n.replace(/^models\//, ""))
    .map((n) => ({ n, m: n.match(re) }))
    .filter((x): x is { n: string; m: RegExpMatchArray } => !!x.m)
    .sort((a, b) => parseFloat(b.m[1]!) - parseFloat(a.m[1]!))[0]?.n;
}

export interface GeminiTest {
  keyOk: boolean;
  status?: number;
  pro?: string;
  flash?: string;
  proMsg?: string;
}

/** Vérifie la clé, puis sonde Pro et Flash (noms souhaités d'abord, puis les plus récents de la liste). */
export async function testGeminiKey(
  key: string,
  wantedPro: string,
  wantedFlash: string,
  f: typeof fetch = fetch
): Promise<GeminiTest> {
  const list = await api(f, key, "models?pageSize=200");
  if (!list.ok) return { keyOk: false, status: list.status };
  const names = (list.json.models ?? []).map((m) => m.name);
  const first = async (candidates: (string | undefined)[]) => {
    let msg = "";
    for (const m of [...new Set(candidates.filter((x): x is string => !!x))]) {
      const r = await probe(f, key, m);
      if (r.ok) return { model: m, msg: "" };
      msg = `${r.status} ${r.msg}`.slice(0, 200);
    }
    return { model: undefined, msg };
  };
  const pro = await first([wantedPro, pickLatest(names, "pro")]);
  const flash = await first([wantedFlash, pickLatest(names, "flash")]);
  return { keyOk: true, pro: pro.model, flash: flash.model, proMsg: pro.msg };
}
