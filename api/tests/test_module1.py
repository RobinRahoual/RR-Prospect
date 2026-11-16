import os

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["APP_TOKEN"] = "secret"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import routes  # noqa: E402
from app.llm.gemini import GeminiProvider  # noqa: E402
from app.llm.types import LLMError, Prompt, parse_draft  # noqa: E402
from app.main import app  # noqa: E402

GOOD = '{"subject":"Vos photos Google ont 8 mois","body_html":"<p>Bonjour, votre fiche Google compte 6 photos.</p>","hook_used":"6 photos","confidence":0.8}'
H = {"Authorization": "Bearer secret"}


# --- parser ---------------------------------------------------------------
def test_parse_plain_and_fenced():
    assert parse_draft(GOOD).subject.startswith("Vos photos")
    assert parse_draft(f"```json\n{GOOD}\n```").confidence == 0.8
    assert parse_draft(f"Voici :\n{GOOD}\nBonne journée").hook_used == "6 photos"


@pytest.mark.parametrize("bad", ["", "pas de json", "{not json}", '{"subject":"x"}'])
def test_parse_rejects_garbage(bad):
    with pytest.raises(LLMError):
        parse_draft(bad)


# --- repli Pro -> Flash ----------------------------------------------------
class FakeClient:
    """Imite client.models.generate_content ; `behaviour[model]` = texte ou exception."""

    def __init__(self, behaviour):
        self.calls = []
        self.models = self
        self._b = behaviour

    def generate_content(self, model, contents, config):
        self.calls.append(model)
        out = self._b[model]
        if isinstance(out, Exception):
            raise out
        return type("R", (), {"text": out})()


class Quota(Exception):
    code = 429


def test_fallback_on_quota():
    c = FakeClient({"pro": Quota("RESOURCE_EXHAUSTED"), "flash": GOOD})
    draft, used = GeminiProvider("k", "pro", "flash", client=c).generate(Prompt(system="s", user="u"))
    assert used == "flash" and c.calls == ["pro", "flash"] and draft.confidence == 0.8


def test_no_fallback_needed():
    c = FakeClient({"pro": GOOD, "flash": GOOD})
    _, used = GeminiProvider("k", "pro", "flash", client=c).generate(Prompt(system="s", user="u"))
    assert used == "pro" and c.calls == ["pro"]


def test_both_fail_raises():
    c = FakeClient({"pro": Quota("429"), "flash": Quota("429")})
    with pytest.raises(LLMError):
        GeminiProvider("k", "pro", "flash", client=c).generate(Prompt(system="s", user="u"))


# --- API -------------------------------------------------------------------
@pytest.fixture()
def client():
    with TestClient(app) as c:  # déclenche lifespan -> create_all
        yield c


def test_auth_required(client):
    assert client.get("/api/health").status_code == 401
    assert client.get("/api/health", headers=H).status_code == 200


def test_full_flow(client, monkeypatch):
    lead = client.post(
        "/api/leads", headers=H,
        json={"name": "Bar Test", "city": "Dijon", "gap_score": 80, "gap_reasons": ["pas de site web"], "place_id": "p1"},
    ).json()
    assert client.post("/api/leads", headers=H, json={"name": "Dup", "place_id": "p1"}).status_code == 409

    p = client.get(f"/api/leads/{lead['id']}/prompt", headers=H).json()
    assert "Bar Test" in p["user"] and "AUCUN site web" in p["user"] and "robinrahoual.fr" in p["system"]

    # brouillon local (sortie Ollama brute)
    r = client.post(f"/api/leads/{lead['id']}/drafts/local", headers=H, json={"raw": GOOD, "model": "mistral-nemo"})
    assert r.status_code == 201 and r.json()["engine"] == "ollama:mistral-nemo"
    assert client.post(f"/api/leads/{lead['id']}/drafts/local", headers=H, json={"raw": "n'importe quoi"}).status_code == 422

    # brouillon cloud (Gemini simulé, Pro en quota -> Flash)
    fake = FakeClient({"pro": Quota("429"), "flash": GOOD})
    monkeypatch.setattr(routes, "provider_factory", lambda: GeminiProvider("k", "pro", "flash", client=fake))
    r = client.post(f"/api/leads/{lead['id']}/drafts/cloud", headers=H)
    assert r.status_code == 201 and r.json()["engine"] == "gemini:flash"

    assert len(client.get(f"/api/leads/{lead['id']}/drafts", headers=H).json()) == 2
    assert client.get("/api/leads?status=drafted", headers=H).json()[0]["id"] == lead["id"]
