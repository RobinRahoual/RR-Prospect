"""Teste ta clé Gemini : liste les modèles, vérifie Pro puis Flash, génère un brouillon d'exemple.

Usage (depuis la racine du projet) :
    pip install google-genai pydantic pydantic-settings sqlalchemy
    export GEMINI_API_KEY=...            # PowerShell : $env:GEMINI_API_KEY="..."
    python scripts/test_gemini.py --list # voir les noms de modèles disponibles pour ta clé
    python scripts/test_gemini.py        # test complet Pro + repli Flash
"""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))

from app.llm.gemini import GeminiProvider  # noqa: E402
from app.llm.prompts import build_prompt  # noqa: E402
from app.llm.types import LLMError  # noqa: E402

KEY = os.environ.get("GEMINI_API_KEY", "")
PRO = os.environ.get("GEMINI_MODEL", "gemini-pro-latest")
FLASH = os.environ.get("GEMINI_FALLBACK_MODEL", "gemini-flash-latest")


def list_models() -> None:
    from google import genai

    client = genai.Client(api_key=KEY)
    names = sorted(m.name.removeprefix("models/") for m in client.models.list())
    for n in names:
        if "gemini" in n:
            print(n)


def sample_lead() -> SimpleNamespace:
    return SimpleNamespace(
        kind="business", name="Le Comptoir du Théâtre (exemple)", category="bar", city="Dijon",
        website=None, rating=4.2, photo_count=6, last_review_at=None, gap_score=78,
        gap_reasons=["pas de site web", "6 photos seulement sur Google", "aucun avis depuis 8 mois"],
        event_name=None, event_date=None, event_url=None,
    )


def main() -> int:
    if not KEY:
        print("GEMINI_API_KEY manquante.")
        return 1
    if "--list" in sys.argv:
        list_models()
        return 0
    prompt = build_prompt(sample_lead())  # type: ignore[arg-type]
    for label, model in (("PRO", PRO), ("FLASH", FLASH)):
        print(f"\n--- {label} : {model} ---")
        try:
            draft, used = GeminiProvider(KEY, model, fallback_model=None).generate(prompt)
        except LLMError as e:
            print(f"ÉCHEC : {e}")
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                print("→ Quota 0 sur ce modèle : active la facturation à l'usage dans AI Studio (palier payant).")
            continue
        print(f"OK ({used}) — confiance {draft.confidence}")
        print("Objet :", draft.subject)
        print("Accroche :", draft.hook_used)
        print(draft.body_html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
