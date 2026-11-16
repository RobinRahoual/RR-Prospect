import { LLMError } from "../errors";
import type { ChatEngine, ChatMessage, ChatReply, ToolSpec } from "./types";

export interface OllamaChatOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  ensureRunning?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

type OllamaMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
};

export function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMsg[] {
  const out: OllamaMsg[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}),
      });
    } else out.push({ role: "tool", content: m.content, tool_name: m.toolName });
  }
  return out;
}

export class OllamaChat implements ChatEngine {
  constructor(private o: OllamaChatOptions) {}

  async isAvailable(): Promise<boolean> {
    if (this.o.ensureRunning) return this.o.ensureRunning();
    try {
      return (await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  }

  async chat(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatReply> {
    const res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 180_000),
      body: JSON.stringify({
        model: this.o.model,
        stream: false,
        options: { temperature: 0.5 },
        messages: toOllamaMessages(system, messages),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }),
    });
    if (!res.ok) throw new LLMError(`Ollama HTTP ${res.status}${res.status === 400 ? " (ce modèle gère-t-il les outils ?)" : ""}`);
    const data = (await res.json()) as {
      message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
    };
    const calls = (data.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => {
        let args = c.function!.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        return { id: `call_${Date.now()}_${i}`, name: c.function!.name!, args: (args ?? {}) as Record<string, unknown> };
      });
    return { content: data.message?.content ?? "", toolCalls: calls, engine: `ollama:${this.o.model}` };
  }
}
