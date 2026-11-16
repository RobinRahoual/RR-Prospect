export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Cartes affichées dans le chat à partir du résultat d'un outil */
export type Card =
  | { type: "leads"; leads: { id: string; name: string; category: string | null; city: string | null; gapScore: number | null; status: string }[] }
  | { type: "draft"; draftId: string; leadId: string; leadName: string; subject: string; bodyHtml: string; engine: string };

export interface ChatMessage {
  id?: string;
  conversationId?: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[]; // assistant
  toolCallId?: string; // tool
  toolName?: string; // tool
  cards?: Card[]; // tool : affichage uniquement
  /** Parties brutes renvoyées par Gemini, à rejouer telles quelles (signatures de pensée exigées par Gemini 3) */
  raw?: { family: "gemini"; parts: unknown[] };
  engine?: string;
  createdAt?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** Schéma JSON (sous-ensemble OpenAPI : type, properties, required, enum, items, description) */
  parameters: Record<string, unknown>;
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
  engine: string;
  raw?: ChatMessage["raw"];
}

export interface ChatEngine {
  isAvailable?(): Promise<boolean>;
  chat(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatReply>;
}

export interface ToolOutput {
  result: unknown;
  cards?: Card[];
}
