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

Publier une version : créer une Release GitHub avec un tag `v*` → le workflow fixe la version d'après le tag, compile et attache l'`.exe`, `latest.yml` et `.blockmap`. Les apps installées se mettent à jour toutes seules (téléchargement en arrière-plan, installation à la fermeture ou au clic).

## Feuille de route
1. ✅ Moteur + app locale + assistant + génération de brouillons
1b. ✅ Interface chat : assistant spécialisé prospection (playbook, profil, exemples validés par toi) qui lit/crée tes leads et rédige les brouillons via des outils ; il n'envoie jamais rien
2. ✅ Scan gratuit OpenStreetMap (zone, rayon, catégories réglables dans Réglages). + SIRENE (entreprises récentes), OpenAgenda (événements, clé gratuite) et analyse de site (mobile, images, vidéo, mise à jour, réseaux, email). Google Places en option avec quota dur : à venir
3. ✅ Envoi Gmail (SMTP + mot de passe d'application), validation obligatoire, plafond/jour, mention STOP + liste de suppression, envoi groupé espacé
3b. ✅ Mises à jour automatiques depuis les Releases GitHub (dépôt public requis)
3c. ✅ Lecture de la boîte Gmail (IMAP) : réponses, STOP et rebonds traités automatiquement, relances J+4
3d. ✅ Suivi d'ouverture : Worker Cloudflare gratuit installé par l'app (jeton API collé une fois)
4. Firebase : synchronisation PC ⇄ iPad dans les deux sens + webapp
5. Worker Cloudflare : pixel d'ouverture, clics, proxy Gemini pour l'iPad
