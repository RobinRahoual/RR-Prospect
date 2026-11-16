import hmac
from typing import Callable

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .llm.gemini import GeminiProvider, make_provider_factory
from .llm.prompts import PROMPT_VERSION, build_prompt
from .llm.types import DraftOut, LLMError, Prompt, parse_draft
from .models import DraftRow, Lead
from .schemas import DraftIn, DraftResp, LeadIn, LeadOut


def require_token(authorization: str = Header(default="")) -> None:
    if not settings.app_token:
        return
    expected = f"Bearer {settings.app_token}"
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(401, "Token invalide")


router = APIRouter(prefix="/api", dependencies=[Depends(require_token)])

# Surchargeable dans les tests
provider_factory: Callable[[], GeminiProvider] = make_provider_factory()


def get_provider() -> GeminiProvider:
    try:
        return provider_factory()
    except LLMError as e:
        raise HTTPException(503, str(e)) from e


def _lead_or_404(db: Session, lead_id: int) -> Lead:
    lead = db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(404, "Lead introuvable")
    return lead


def _save_draft(db: Session, lead: Lead, draft: DraftOut, engine: str) -> DraftRow:
    row = DraftRow(
        lead_id=lead.id,
        subject=draft.subject,
        body_html=draft.body_html,
        hook_used=draft.hook_used,
        confidence=draft.confidence,
        engine=engine,
    )
    db.add(row)
    lead.status = "drafted"
    db.commit()
    return row


@router.get("/health")
def health():
    return {
        "ok": True,
        "prompt_version": PROMPT_VERSION,
        "gemini_configured": bool(settings.gemini_api_key),
        "gemini_model": settings.gemini_model,
        "gemini_fallback": settings.gemini_fallback_model,
    }


@router.post("/leads", response_model=LeadOut, status_code=201)
def create_lead(body: LeadIn, db: Session = Depends(get_db)):
    if body.place_id and db.scalar(select(Lead).where(Lead.place_id == body.place_id)):
        raise HTTPException(409, "Lead déjà présent (place_id)")
    lead = Lead(**body.model_dump())
    db.add(lead)
    db.commit()
    return lead


@router.get("/leads", response_model=list[LeadOut])
def list_leads(status: str | None = None, db: Session = Depends(get_db)):
    q = select(Lead).order_by(Lead.gap_score.desc().nullslast(), Lead.created_at.desc())
    if status:
        q = q.where(Lead.status == status)
    return db.scalars(q.limit(200)).all()


@router.get("/leads/{lead_id}/prompt", response_model=Prompt)
def lead_prompt(lead_id: int, db: Session = Depends(get_db)):
    """Utilisé par le .exe : il récupère le prompt, appelle Ollama en local, puis poste le résultat."""
    return build_prompt(_lead_or_404(db, lead_id))


@router.post("/leads/{lead_id}/drafts/cloud", response_model=DraftResp, status_code=201)
def draft_cloud(lead_id: int, db: Session = Depends(get_db), provider: GeminiProvider = Depends(get_provider)):
    lead = _lead_or_404(db, lead_id)
    try:
        draft, model = provider.generate(build_prompt(lead))
    except LLMError as e:
        raise HTTPException(502, str(e)) from e
    return _save_draft(db, lead, draft, f"gemini:{model}")


@router.post("/leads/{lead_id}/drafts/local", response_model=DraftResp, status_code=201)
def draft_local(lead_id: int, body: DraftIn, db: Session = Depends(get_db)):
    lead = _lead_or_404(db, lead_id)
    try:
        draft = parse_draft(body.raw)
    except LLMError as e:
        raise HTTPException(422, str(e)) from e
    return _save_draft(db, lead, draft, f"ollama:{body.model}")


@router.get("/leads/{lead_id}/drafts", response_model=list[DraftResp])
def list_drafts(lead_id: int, db: Session = Depends(get_db)):
    _lead_or_404(db, lead_id)
    return db.scalars(select(DraftRow).where(DraftRow.lead_id == lead_id).order_by(DraftRow.id.desc())).all()
