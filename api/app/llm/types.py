import json
import re

from pydantic import BaseModel, Field


class Prompt(BaseModel):
    system: str
    user: str


class DraftOut(BaseModel):
    subject: str = Field(min_length=3, max_length=200)
    body_html: str = Field(min_length=20)
    hook_used: str = ""
    confidence: float = Field(default=0.5, ge=0, le=1)


class LLMError(Exception):
    pass


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def parse_draft(raw: str) -> DraftOut:
    """Parse la sortie brute d'un LLM (Gemini ou Ollama) en brouillon validé.

    Tolère les blocs ```json et le texte autour de l'objet JSON.
    """
    text = _FENCE.sub("", raw.strip())
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise LLMError("Aucun objet JSON dans la réponse du modèle")
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError as e:
        raise LLMError(f"JSON invalide : {e}") from e
    try:
        return DraftOut.model_validate(data)
    except Exception as e:  # pydantic.ValidationError
        raise LLMError(f"Brouillon invalide : {e}") from e
