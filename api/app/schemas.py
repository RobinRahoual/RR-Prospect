from datetime import datetime

from pydantic import BaseModel, ConfigDict


class LeadIn(BaseModel):
    kind: str = "business"
    name: str
    category: str | None = None
    city: str | None = None
    address: str | None = None
    website: str | None = None
    email: str | None = None
    phone: str | None = None
    place_id: str | None = None
    rating: float | None = None
    photo_count: int | None = None
    last_review_at: datetime | None = None
    gap_score: int | None = None
    gap_reasons: list[str] | None = None
    event_name: str | None = None
    event_date: datetime | None = None
    event_url: str | None = None
    source: str | None = None


class LeadOut(LeadIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    status: str
    created_at: datetime


class DraftIn(BaseModel):
    """Brouillon généré en local : le client envoie la sortie brute d'Ollama, le serveur valide."""

    raw: str
    model: str = "ollama"


class DraftResp(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    lead_id: int
    subject: str
    body_html: str
    hook_used: str | None
    confidence: float | None
    engine: str
    status: str
    created_at: datetime
