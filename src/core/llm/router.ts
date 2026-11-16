import { LLMError } from "../errors";
import type { DraftOut, Mode, Prompt } from "../types";

export interface GenResult {
  draft: DraftOut;
  engine: string;
}
export interface CloudEngine {
  generate(prompt: Prompt): Promise<GenResult>;
}
export interface LocalEngine extends CloudEngine {
  isAvailable(): Promise<boolean>;
}

/**
 * auto  : local d'abord ; si Ollama est absent ou échoue → Gemini (si une clé est configurée)
 * local : Ollama uniquement
 * cloud : Gemini uniquement
 */
export class LLMRouter {
  constructor(private local: LocalEngine | null, private cloud: CloudEngine | null) {}

  async generate(prompt: Prompt, mode: Mode): Promise<GenResult> {
    if (mode === "cloud") return this.cloudOrThrow(prompt);

    if (mode === "local") {
      if (!this.local || !(await this.local.isAvailable())) {
        throw new LLMError("Ollama est injoignable. Lance-le, ou passe en mode Auto / Cloud.");
      }
      return this.local.generate(prompt);
    }

    // auto
    let localError: unknown = null;
    if (this.local && (await this.local.isAvailable())) {
      try {
        return await this.local.generate(prompt);
      } catch (e) {
        localError = e;
      }
    }
    if (this.cloud) return this.cloud.generate(prompt);
    throw new LLMError(
      localError
        ? `L'IA locale a échoué (${(localError as Error).message}) et aucune clé Gemini n'est configurée.`
        : "Aucun moteur disponible : Ollama est injoignable et aucune clé Gemini n'est configurée."
    );
  }

  private cloudOrThrow(prompt: Prompt): Promise<GenResult> {
    if (!this.cloud) throw new LLMError("Aucune clé Gemini configurée.");
    return this.cloud.generate(prompt);
  }
}
