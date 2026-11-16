// Erreur avec une piste de résolution lisible, affichée telle quelle dans l'assistant
class HintError extends Error {
  constructor(message, hint = "") {
    super(message);
    this.hint = hint;
  }
}

module.exports = { HintError };
