# RR Prospect

Squelette API + base + routeur IA. NAS = API, base, (plus tard) front et pixel. PC = `.exe` Electron + Ollama local. iPad = PWA, Gemini.

## 1. Tester ta clé Gemini (sur ton PC, avant tout déploiement)
```powershell
cd rr-prospect
pip install google-genai pydantic pydantic-settings sqlalchemy
$env:GEMINI_API_KEY="ta_clé"
python scripts/test_gemini.py --list   # noms de modèles dispo pour ta clé
python scripts/test_gemini.py          # test Pro puis Flash
```
Si Pro répond `429 / limit: 0` → active la facturation à l'usage dans AI Studio et mets un plafond de budget dans Google Cloud.
Ajuste `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` dans `.env` selon la liste.

## 2. Déployer sur le NAS
```bash
cp .env.example .env   # remplis POSTGRES_PASSWORD, APP_TOKEN, GEMINI_API_KEY
docker compose up -d --build
curl -H "Authorization: Bearer $APP_TOKEN" http://IP_NAS:8000/api/health
```
Docs interactives : `http://IP_NAS:8000/docs`

## 3. Le .exe (PC) — installation en un clic
1. Onglet **Releases** du dépôt → télécharge `RR-Prospect-Setup-x.y.z.exe` → double-clic.
2. Au premier lancement, saisis l'adresse de la webapp du NAS (ex. `http://192.168.1.50:3000`) et le modèle Ollama.
3. Prérequis : Ollama installé, `ollama pull mistral-nemo`, `ollama ps` doit afficher 100 % GPU.

Publier une nouvelle version : `git tag v0.1.0 && git push origin v0.1.0` → GitHub Actions compile l'installeur et l'attache à la Release.
Compiler à la main : `cd desktop && npm install && npm run build` (installeur dans `desktop/dist`).

## Flux IA
- iPad / navigateur : `POST /api/leads/{id}/drafts/cloud` (Gemini Pro, repli Flash sur 429/404/503)
- .exe : `GET /api/leads/{id}/prompt` → `window.localAI.generate(system, user)` → `POST /api/leads/{id}/drafts/local {raw, model}` (validation côté serveur, repli sur `/drafts/cloud` si Ollama est indisponible)

## Tests
`cd api && pip install -r requirements.txt && pytest -q`
