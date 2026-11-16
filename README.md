# RR Prospect

Application Windows de prospection pour vidéaste/photographe freelance. **Locale d'abord** : elle fonctionne seule sur le PC, sans serveur ni compte cloud. La synchronisation iPad (Firebase) et le tracking (Cloudflare) sont des extras optionnels, ajoutés aux modules suivants.

## Installer
1. Télécharge `RR-Prospect-Setup-x.y.z.exe` (onglet **Releases**, ou **Actions → dernière exécution → Artifacts**) et double-clique.
   SmartScreen : « Informations complémentaires » → « Exécuter quand même » (installeur non signé).
2. Au premier lancement, l'assistant fait tout :
   - installe Ollama et télécharge le modèle (`mistral-nemo` par défaut),
   - mesure l'occupation du GPU et active Vulkan si besoin (RX 9000 sous Windows),
   - vérifie ta clé Gemini si tu en donnes une (facultatif) : Pro, sinon Flash.

Les données vivent dans `%APPDATA%\rr-prospect` (base SQLite + config). La clé Gemini y est chiffrée (DPAPI).

## IA : trois modes (sélecteur dans l'app)
| Mode | Comportement |
|---|---|
| Auto | Ollama local d'abord ; s'il est éteint ou échoue → Gemini (si une clé existe) |
| Local | Ollama uniquement |
| Cloud | Gemini uniquement (Pro, repli Flash sur quota/surcharge) |

## Développement
```bash
npm install
npm test            # moteur : prompts, parser, Gemini + repli, routeur, SQLite
npm run typecheck
npm start           # build + lance Electron
npm run dist        # installeur dans release/
```
Structure : `src/core` (moteur pur, réutilisé plus tard par la webapp et le Worker), `src/main` (Electron), `src/preload`, `src/renderer` (React), `src/shared` (contrat IPC).

Publier une version : créer une Release GitHub avec un tag `v*` → le workflow compile et attache l'`.exe`.

## Feuille de route
1. ✅ Moteur + app locale + assistant + génération de brouillons
2. Scan Google Places (score de présence visuelle) + événements (OpenAgenda, open data Dijon)
3. Envoi Gmail (OAuth sur le PC), liste de suppression, plafond quotidien
4. Firebase : synchronisation PC ⇄ iPad dans les deux sens + webapp
5. Worker Cloudflare : pixel d'ouverture, clics, proxy Gemini pour l'iPad
