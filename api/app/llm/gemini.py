import logging
from typing import Any, Callable

from .types import DraftOut, LLMError, Prompt, parse_draft

log = logging.getLogger("rr.gemini")


def _should_fallback(exc: Exception) -> bool:
    """Quota épuisé, surcharge ou modèle introuvable → on tente le modèle de repli."""
    code = getattr(exc, "code", None)
    if code in (404, 429, 500, 503):
        return True
    s = str(exc)
    return any(k in s for k in ("RESOURCE_EXHAUSTED", "UNAVAILABLE", "NOT_FOUND", "429"))


class GeminiProvider:
    def __init__(
        self,
        api_key: str,
        model: str,
        fallback_model: str | None = None,
        grounding: bool = False,
        client: Any = None,
    ):
        self.model = model
        self.fallback_model = fallback_model
        self.grounding = grounding
        if client is not None:
            self._client = client
        else:
            if not api_key:
                raise LLMError("GEMINI_API_KEY manquante")
            from google import genai  # import tardif : les tests n'en ont pas besoin

            self._client = genai.Client(api_key=api_key)

    def _call(self, model: str, prompt: Prompt) -> str:
        from google.genai import types

        cfg: dict[str, Any] = {"system_instruction": prompt.system, "temperature": 0.7}
        if self.grounding:
            # JSON mode + outil de recherche sont incompatibles : on parse le texte librement
            cfg["tools"] = [types.Tool(google_search=types.GoogleSearch())]
        else:
            cfg["response_mime_type"] = "application/json"
        resp = self._client.models.generate_content(
            model=model, contents=prompt.user, config=types.GenerateContentConfig(**cfg)
        )
        if not resp.text:
            raise LLMError("Réponse Gemini vide")
        return resp.text

    def generate(self, prompt: Prompt) -> tuple[DraftOut, str]:
        """Retourne (brouillon, modèle effectivement utilisé)."""
        models = [self.model] + ([self.fallback_model] if self.fallback_model else [])
        last: Exception | None = None
        for i, model in enumerate(models):
            try:
                return parse_draft(self._call(model, prompt)), model
            except Exception as e:  # noqa: BLE001
                last = e
                if i + 1 < len(models) and (_should_fallback(e) or isinstance(e, LLMError)):
                    log.warning("Gemini %s a échoué (%s) → repli sur %s", model, e, models[i + 1])
                    continue
                break
        raise LLMError(f"Gemini indisponible : {last}") from last


def make_provider_factory() -> Callable[[], GeminiProvider]:
    from ..config import settings

    def factory() -> GeminiProvider:
        return GeminiProvider(
            api_key=settings.gemini_api_key,
            model=settings.gemini_model,
            fallback_model=settings.gemini_fallback_model or None,
            grounding=settings.gemini_grounding,
        )

    return factory
