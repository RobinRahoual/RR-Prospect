import { LLMError } from "../errors";
import type { Mode } from "../types";
import type { ChatEngine, ChatMessage, ToolCall, ToolOutput, ToolSpec } from "./types";

export interface AgentOptions {
  local: ChatEngine | null;
  cloud: ChatEngine | null;
  mode: Mode;
  system: string;
  tools: ToolSpec[];
  execute: (call: ToolCall) => Promise<ToolOutput>;
  /** Appelé pour chaque message produit (assistant, outils) : sert à sauvegarder et afficher en direct */
  onMessage?: (m: ChatMessage) => void | Promise<void>;
  maxSteps?: number;
}

const MAX_TOOL_CHARS = 6000;

/** Garde les derniers messages sans commencer au milieu d'un échange d'outils. */
export function trimHistory(messages: ChatMessage[], max = 40): ChatMessage[] {
  let out = messages.slice(-max);
  while (out.length && out[0]!.role !== "user") out = out.slice(1);
  return out;
}

async function pickEngines(o: AgentOptions): Promise<ChatEngine[]> {
  if (o.mode === "cloud") {
    if (!o.cloud) throw new LLMError("Aucune clé Gemini configurée.");
    return [o.cloud];
  }
  const localUp = o.local ? await (o.local.isAvailable?.() ?? Promise.resolve(true)) : false;
  if (o.mode === "local") {
    if (!o.local || !localUp) throw new LLMError("Ollama est injoignable. Lance-le, ou passe en mode Auto / Cloud.");
    return [o.local];
  }
  const list = [...(localUp && o.local ? [o.local] : []), ...(o.cloud ? [o.cloud] : [])];
  if (!list.length) throw new LLMError("Aucun moteur disponible : Ollama est injoignable et aucune clé Gemini n'est configurée.");
  return list;
}

/**
 * Boucle d'agent : le modèle répond, appelle des outils, reçoit leurs résultats, jusqu'à une réponse finale.
 * En mode auto, si le moteur local échoue en cours de route, on bascule sur Gemini en gardant tout l'historique.
 * Retourne les messages produits pendant ce tour.
 */
export async function runAgent(o: AgentOptions, history: ChatMessage[]): Promise<ChatMessage[]> {
  const engines = await pickEngines(o);
  let idx = 0;
  const all = [...history];
  const produced: ChatMessage[] = [];
  const emit = async (m: ChatMessage) => {
    produced.push(m);
    all.push(m);
    await o.onMessage?.(m);
  };

  for (let step = 0; step < (o.maxSteps ?? 6); step++) {
    let reply;
    for (;;) {
      try {
        reply = await engines[idx]!.chat(o.system, all, o.tools);
        break;
      } catch (e) {
        if (idx + 1 < engines.length) idx++;
        else throw e;
      }
    }

    await emit({
      role: "assistant",
      content: reply.content,
      toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined,
      raw: reply.raw,
      engine: reply.engine,
    });
    if (!reply.toolCalls.length) {
      if (!reply.content.trim()) {
        await emit({ role: "assistant", content: "(Le modèle n'a rien répondu. Reformule ou change de moteur.)", engine: reply.engine });
      }
      return produced;
    }

    for (const call of reply.toolCalls) {
      let out: ToolOutput;
      try {
        out = await o.execute(call);
      } catch (e) {
        out = { result: { error: (e as Error).message } };
      }
      let content = JSON.stringify(out.result ?? null);
      if (content.length > MAX_TOOL_CHARS) content = content.slice(0, MAX_TOOL_CHARS) + '…(tronqué)"';
      await emit({ role: "tool", content, toolCallId: call.id, toolName: call.name, cards: out.cards });
    }
  }

  await emit({ role: "assistant", content: "J'ai atteint la limite d'étapes pour cette demande. Dis-moi si je dois continuer.", engine: "agent" });
  return produced;
}
