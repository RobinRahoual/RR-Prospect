export class LLMError extends Error {}

// Erreur avec une piste de résolution lisible, affichée telle quelle dans l'assistant
export class HintError extends Error {
  constructor(message: string, public hint = "") {
    super(message);
  }
}
