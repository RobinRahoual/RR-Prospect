import { z } from "zod";
import { LLMError } from "./errors";
import type { DraftOut } from "./types";

const Raw = z.object({
  subject: z.string().min(3).max(200),
  body_html: z.string().min(20),
  hook_used: z.string().optional().default(""),
  confidence: z.number().min(0).max(1).optional().default(0.5),
});

/** Parse la sortie brute d'un LLM (Gemini ou Ollama). Tolère les blocs ```json et le texte autour. */
export function parseDraft(raw: string): DraftOut {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LLMError("Aucun objet JSON dans la réponse du modèle");
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new LLMError(`JSON invalide : ${(e as Error).message}`);
  }
  const r = Raw.safeParse(data);
  if (!r.success) {
    throw new LLMError("Brouillon invalide : " + r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  }
  return { subject: r.data.subject, bodyHtml: r.data.body_html, hookUsed: r.data.hook_used, confidence: r.data.confidence };
}
