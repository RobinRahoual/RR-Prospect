import { LLMError } from "../errors";
import { GEMINI_BASE } from "../llm/gemini";
import type { ChatEngine, ChatMessage, ChatReply, ToolCall, ToolSpec } from "./types";

export interface GeminiChatOptions {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  fetchImpl?: typeof fetch;
}

type Part = Record<string, unknown>;
interface Content {
  role: "user" | "model";
  parts: Part[];
}

const asObject = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { result: v };
  } catch {
    return { result: s };
  }
};

export function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      // Parties brutes d'abord (elles portent les signatures de pensée), sinon reconstruction
      const parts: Part[] =
        m.raw?.family === "gemini"
          ? (m.raw.parts as Part[])
          : [
              ...(m.content ? [{ text: m.content }] : []),
              ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args } })),
            ];
      if (parts.length) out.push({ role: "model", parts });
    } else {
      // Les résultats d'appels parallèles doivent tenir dans UN seul message
      const part = { functionResponse: { name: m.toolName ?? "tool", response: asObject(m.content) } };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.parts.every((p) => "functionResponse" in p)) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    }
  }
  return out;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const FALLBACK_STATUS = new Set([404, 429, 500, 503]);

export class GeminiChat implements ChatEngine {
  constructor(private o: GeminiChatOptions) {
    if (!o.apiKey) throw new LLMError("Clé Gemini manquante");
  }

  private async call(model: string, system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatReply> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: system }] },
      contents: toGeminiContents(messages),
      generationConfig: { temperature: 0.5 },
    };
    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    const res = await (this.o.fetchImpl ?? fetch)(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": this.o.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      promptFeedback?: { blockReason?: string };
      candidates?: { content?: { parts?: Part[] } }[];
    };
    if (!res.ok) throw new HttpError(res.status, json.error?.message ?? `HTTP ${res.status}`);
    const parts = json.candidates?.[0]?.content?.parts;
    if (!parts?.length) {
      throw new LLMError(json.promptFeedback?.blockReason ? `Réponse bloquée par Gemini (${json.promptFeedback.blockReason})` : "Réponse Gemini vide");
    }
    const content = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text as string)
      .join("");
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => {
        const fc = p.functionCall as { id?: string; name: string; args?: Record<string, unknown> };
        return { id: fc.id ?? `call_${Date.now()}_${i}`, name: fc.name, args: fc.args ?? {} };
      });
    return { content, toolCalls, engine: `gemini:${model}`, raw: { family: "gemini", parts } };
  }

  async chat(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatReply> {
    const models = [this.o.model, ...(this.o.fallbackModel && this.o.fallbackModel !== this.o.model ? [this.o.fallbackModel] : [])];
    let last: unknown;
    for (let i = 0; i < models.length; i++) {
      try {
        return await this.call(models[i]!, system, messages, tools);
      } catch (e) {
        last = e;
        const retry = e instanceof LLMError || (e instanceof HttpError && FALLBACK_STATUS.has(e.status));
        if (i + 1 < models.length && retry) continue;
        break;
      }
    }
    throw new LLMError(`Gemini indisponible : ${(last as Error)?.message ?? last}`);
  }
}
