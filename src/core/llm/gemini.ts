import { LLMError } from "../errors";
import { parseDraft } from "../parse";
import type { DraftOut, Prompt } from "../types";
import type { CloudEngine } from "./router";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  grounding?: boolean;
  fetchImpl?: typeof fetch;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Quota épuisé, surcharge, modèle introuvable → on tente le modèle de repli
const FALLBACK_STATUS = new Set([404, 429, 500, 503]);

export class GeminiEngine implements CloudEngine {
  constructor(private o: GeminiOptions) {
    if (!o.apiKey) throw new LLMError("Clé Gemini manquante");
  }

  private async call(model: string, prompt: Prompt): Promise<string> {
    const f = this.o.fetchImpl ?? fetch;
    const generationConfig: Record<string, unknown> = { temperature: 0.7 };
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      generationConfig,
    };
    if (this.o.grounding) body.tools = [{ google_search: {} }];
    else generationConfig.responseMimeType = "application/json"; // incompatible avec l'outil de recherche

    const res = await f(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": this.o.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    if (!res.ok) throw new HttpError(res.status, json.error?.message ?? `HTTP ${res.status}`);
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (!text) throw new LLMError("Réponse Gemini vide");
    return text;
  }

  async generate(prompt: Prompt): Promise<{ draft: DraftOut; engine: string }> {
    const models = [this.o.model, ...(this.o.fallbackModel && this.o.fallbackModel !== this.o.model ? [this.o.fallbackModel] : [])];
    let last: unknown;
    for (let i = 0; i < models.length; i++) {
      const model = models[i]!;
      try {
        return { draft: parseDraft(await this.call(model, prompt)), engine: `gemini:${model}` };
      } catch (e) {
        last = e;
        const retryable = e instanceof LLMError || (e instanceof HttpError && FALLBACK_STATUS.has(e.status));
        if (i + 1 < models.length && retryable) continue;
        break;
      }
    }
    throw new LLMError(`Gemini indisponible : ${(last as Error)?.message ?? last}`);
  }
}
