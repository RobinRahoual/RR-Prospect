from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from . import models  # noqa: F401  (enregistre les tables)
from .config import settings
from .db import Base, engine
from .routes import router


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)  # Alembic à partir du module 3
    yield


app = FastAPI(title="RR Prospect API", lifespan=lifespan)
if settings.cors_list:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_list,
        allow_methods=["*"],
        allow_headers=["*"],
    )
app.include_router(router)


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def home():
    # Page d'attente jusqu'au front (module 4)
    return (
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>RR Prospect</title><body style='margin:0;min-height:100vh;display:grid;place-items:center;"
        "background:#0b0b0f;color:#eee;font:16px system-ui'><div style='text-align:center'>"
        "<h1>RR Prospect</h1><p>Serveur en ligne ✓</p>"
        "<p style='color:#8a8a95;font-size:13px'>Le tableau de bord arrive au module 4.</p></div>"
    )
