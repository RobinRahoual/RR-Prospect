from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Lead(Base):
    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), default="business")  # business | event
    name: Mapped[str] = mapped_column(String(255))
    category: Mapped[str | None] = mapped_column(String(128))
    city: Mapped[str | None] = mapped_column(String(128))
    address: Mapped[str | None] = mapped_column(String(255))
    website: Mapped[str | None] = mapped_column(String(512))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(64))
    place_id: Mapped[str | None] = mapped_column(String(255), unique=True)
    rating: Mapped[float | None] = mapped_column(Float)
    photo_count: Mapped[int | None] = mapped_column(Integer)
    last_review_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    gap_score: Mapped[int | None] = mapped_column(Integer)  # 0-100, haut = grosse lacune visuelle
    gap_reasons: Mapped[list | None] = mapped_column(JSON)
    event_name: Mapped[str | None] = mapped_column(String(255))
    event_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    event_url: Mapped[str | None] = mapped_column(String(512))
    source: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="new")  # new|drafted|sent|replied|skipped
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    drafts: Mapped[list["DraftRow"]] = relationship(back_populates="lead", cascade="all, delete-orphan")


class DraftRow(Base):
    __tablename__ = "drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lead_id: Mapped[int] = mapped_column(ForeignKey("leads.id", ondelete="CASCADE"))
    subject: Mapped[str] = mapped_column(String(255))
    body_html: Mapped[str] = mapped_column(Text)
    hook_used: Mapped[str | None] = mapped_column(String(255))
    confidence: Mapped[float | None] = mapped_column(Float)
    engine: Mapped[str] = mapped_column(String(64))  # ex: "gemini:gemini-pro-latest" | "ollama:mistral-nemo"
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|approved|sent
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    lead: Mapped[Lead] = relationship(back_populates="drafts")


class Suppression(Base):
    """Adresses à ne plus jamais contacter (désinscription, demande RGPD)."""

    __tablename__ = "suppression_list"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    reason: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
