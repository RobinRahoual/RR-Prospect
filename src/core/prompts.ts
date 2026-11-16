/** Construction des prompts. Identique pour Gemini et Ollama : le profil de Robin vit ici, versionné. */
import type { Lead, Prompt } from "./types";

export const PROMPT_VERSION = "2026-11-16.1";

export const SYSTEM_PROFILE = `Tu rédiges des e-mails de prospection à froid pour Robin Rahoual, vidéaste et photographe freelance basé à Dijon.

PROFIL
- Spécialités : vidéo et photo pour l'événementiel, le monde de la nuit et les entreprises locales.
- Approche : direction artistique créative + exécution technique rapide. Il parle retour sur investissement, pas "beau pour le beau" : visuels percutants ("hero visuals") à fort engagement pour les réseaux sociaux.
- Réactivité : montage ultra-rapide sous DaVinci Resolve, livraison de contenus courts (Réels, Shorts, TikTok) en format vertical.
- Matériel (gage de qualité, à ne mentionner que si c'est pertinent, en une demi-phrase maximum) : Sony A7 III, Tamron 28-200 mm f/2.8-5.6 (polyvalent en événementiel), moniteur Feelworld vertical pour la captation directe en format court.
- Portfolio : https://robinrahoual.fr

STYLE
- Français, vouvoiement direct mais chaleureux (jamais de tutoiement). Énergie créative, zéro jargon commercial, zéro flatterie générique.
- 90 à 130 mots dans le corps. Une seule demande claire en conclusion (échange de 15 minutes, ou envoi de 2-3 exemples).
- Commence par un constat précis et vérifiable sur le prospect (jamais "j'espère que vous allez bien").
- N'invente AUCUN fait sur le prospect : utilise uniquement les informations fournies.
- Ne mets ni signature, ni lien de désinscription, ni formule de politesse longue : ils sont ajoutés à l'envoi.
- Le portfolio peut être cité une fois, en lien HTML.

SORTIE
Réponds UNIQUEMENT par un objet JSON, sans texte autour, avec exactement ces clés :
{"subject": string (max 70 caractères, sans majuscules agressives),
 "body_html": string (HTML simple : <p>, <a>, <strong>, pas de style inline),
 "hook_used": string (le fait précis du prospect sur lequel repose l'accroche),
 "confidence": number entre 0 et 1 (ta confiance dans la pertinence de l'accroche)}`;

const pad = (n: number) => String(n).padStart(2, "0");
const dmy = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};
const my = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};

function facts(lead: Lead): string[] {
  const out = [`Type de lead : ${lead.kind === "event" ? "événement" : "entreprise locale"}`, `Nom : ${lead.name}`];
  if (lead.category) out.push(`Catégorie : ${lead.category}`);
  if (lead.city) out.push(`Ville : ${lead.city}`);
  out.push(`Site web : ${lead.website || "AUCUN site web détecté"}`);
  if (lead.kind === "event") {
    if (lead.eventName) out.push(`Événement : ${lead.eventName}`);
    if (lead.eventDate) out.push(`Date : ${dmy(lead.eventDate)}`);
    if (lead.eventUrl) out.push(`Page : ${lead.eventUrl}`);
  } else {
    if (lead.rating != null) out.push(`Note Google : ${lead.rating}/5`);
    if (lead.photoCount != null) out.push(`Photos sur la fiche Google : ${lead.photoCount}`);
    if (lead.lastReviewAt) out.push(`Dernier avis Google : ${my(lead.lastReviewAt)}`);
    if (lead.gapScore != null) out.push(`Score de lacune visuelle : ${lead.gapScore}/100`);
    if (lead.gapReasons.length) out.push("Lacunes détectées : " + lead.gapReasons.join(" ; "));
  }
  return out;
}

export function buildPrompt(lead: Lead): Prompt {
  return {
    system: SYSTEM_PROFILE,
    user:
      "Rédige l'e-mail de prospection pour ce lead.\n\n" +
      facts(lead).join("\n") +
      "\n\nAppuie l'accroche sur la lacune ou l'occasion la plus concrète ci-dessus.",
  };
}
