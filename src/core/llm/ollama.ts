import { HintError, LLMError } from "../errors";
import { parseDraft } from "../parse";
import type { DraftOut, Prompt } from "../types";
import type { LocalEngine } from "./router";

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Démarre Ollama si besoin (fourni par le processus principal) ; par défaut simple test de disponibilité */
  ensureRunning?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

export class OllamaEngine implements LocalEngine {
  constructor(private o: OllamaOptions) {}

  async isAvailable(): Promise<boolean> {
    if (this.o.ensureRunning) return this.o.ensureRunning();
    try {
      const r = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async generate(prompt: Prompt): Promise<{ draft: DraftOut; engine: string }> {
    const res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
      body: JSON.stringify({
        model: this.o.model,
        stream: false,
        format: "json",
        options: { temperature: 0.7 },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    });
    if (!res.ok) throw new LLMError(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return { draft: parseDraft(data.message?.content ?? ""), engine: `ollama:${this.o.model}` };
  }
}

/** Télécharge un modèle en journalisant la progression (par paliers de 5 %). */
export async function pullModel(baseUrl: string, model: string, log: (l: string) => void, f: typeof fetch = fetch): Promise<void> {
  const res = await f(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new HintError(`Téléchargement du modèle refusé (HTTP ${res.status})`, `Vérifie le nom du modèle : ${model}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastPct = -10;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j: { error?: string; total?: number; completed?: number; status?: string };
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.error) throw new HintError(`Ollama : ${j.error}`, "Vérifie le nom du modèle et ta connexion internet.");
      if (j.total && j.completed) {
        const pct = Math.floor((j.completed / j.total) * 100);
        if (pct >= lastPct + 5) {
          lastPct = pct;
          log(`${j.status} ${pct}%`);
        }
      } else if (j.status) log(j.status);
    }
  }
}

/** Génère un mot puis lit /api/ps : part du modèle chargée en VRAM. */
export async function gpuCheck(baseUrl: string, model: string, f: typeof fetch = fetch): Promise<{ pct: number; gb: number }> {
  const g = await f(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model, prompt: "Réponds : OK", stream: false, keep_alive: "2m", options: { num_predict: 8 } }),
  });
  if (!g.ok) throw new HintError(`Le modèle ne répond pas (HTTP ${g.status})`, "Relance l'assistant ; si ça persiste, redémarre Ollama.");
  const ps = (await (await f(`${baseUrl}/api/ps`)).json()) as {
    models?: { name?: string; model?: string; size: number; size_vram: number }[];
  };
  const m = (ps.models ?? []).find((x) => x.name === model || x.model === model || x.name?.startsWith(model));
  if (!m || !m.size) return { pct: 0, gb: 0 };
  return { pct: Math.round((m.size_vram / m.size) * 100), gb: +(m.size / 1e9).toFixed(1) };
}
