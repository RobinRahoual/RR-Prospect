# RR Prospect

Squelette API + base + routeur IA. NAS = API, base, (plus tard) front et pixel. PC = `.exe` Electron + Ollama local. iPad = PWA, Gemini.

## Installation (automatique)
1. Onglet **Releases** → télécharge `RR-Prospect-Setup-x.y.z.exe` → double-clic (SmartScreen : « Informations complémentaires » → « Exécuter quand même », l'installeur n'est pas signé).
2. L'assistant demande 4 infos (IP du NAS, utilisateur/mot de passe SSH, clé Gemini, modèle) puis fait tout seul :
   - installe Ollama, télécharge le modèle, active Vulkan si le GPU n'est pas utilisé,
   - teste la clé Gemini (Pro, sinon Flash) et corrige les noms de modèles,
   - déploie l'API + PostgreSQL sur le NAS par SSH (`docker compose up -d --build`), génère les secrets, vérifie que l'API répond.
3. Relancer l'assistant est sans risque : les secrets du NAS sont conservés.

Prérequis : une clé Gemini ([AI Studio](https://aistudio.google.com/apikey)), Docker sur le NAS (CasaOS l'installe), SSH actif.

Publier une version : `git tag v0.1.1 && git push origin v0.1.1` → GitHub Actions compile l'installeur et l'attache à la Release.

## Flux IA
- iPad / navigateur : `POST /api/leads/{id}/drafts/cloud` (Gemini Pro, repli Flash sur 429/404/503)
- .exe : `GET /api/leads/{id}/prompt` → `window.localAI.generate(system, user)` → `POST /api/leads/{id}/drafts/local {raw, model}` (validation côté serveur, repli sur `/drafts/cloud` si Ollama est indisponible)

## Tests
`cd api && pip install -r requirements.txt && pytest -q`
