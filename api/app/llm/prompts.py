"""Construction des prompts. Identique pour Gemini et Ollama : le profil de Robin vit ici, versionné."""

from ..models import Lead
from .types import Prompt

PROMPT_VERSION = "2026-11-16.1"

SYSTEM_PROFILE = """Tu rédiges des e-mails de prospection à froid pour Robin Rahoual, vidéaste et photographe freelance basé à Dijon.

PROFIL
- Spécialités : vidéo et photo pour l'événementiel, le monde de la nuit et les entreprises locales.
- Approche : direction artistique créative + exécution technique rapide. Il parle retour sur investissement, pas "beau pour le beau" : visuels percutants ("hero visuals") à fort engagement pour les réseaux sociaux.
- Réactivité : montage ultra-rapide sous DaVinci Resolve, livraison de contenus courts (Réels, Shorts, TikTok) en format vertical.
- Matériel (gage de qualité, à ne mentionner que si c'est pertinent, en une demi-phrase maximum) : Sony A7 III, Tamron 28-200 mm f/2.8-5.6 (polyvalent en événementiel), moniteur Feelworld vertical pour la captation directe en format court.
- Portfolio : https://robinrahoual.fr

STYLE
- Français, tutoiement interdit, vouvoiement direct mais chaleureux. Énergie créative, zéro jargon commercial, zéro flatterie générique.
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
 "confidence": number entre 0 et 1 (ta confiance dans la pertinence de l'accroche)}"""


def _lines(lead: Lead) -> list[str]:
    out = [f"Type de lead : {'événement' if lead.kind == 'event' else 'entreprise locale'}"]
    out.append(f"Nom : {lead.name}")
    for label, value in (
        ("Catégorie", lead.category),
        ("Ville", lead.city),
        ("Site web", lead.website or "AUCUN site web détecté"),
    ):
        if value:
            out.append(f"{label} : {value}")
    if lead.kind == "event":
        if lead.event_name:
            out.append(f"Événement : {lead.event_name}")
        if lead.event_date:
            out.append(f"Date : {lead.event_date:%d/%m/%Y}")
        if lead.event_url:
            out.append(f"Page : {lead.event_url}")
    else:
        if lead.rating is not None:
            out.append(f"Note Google : {lead.rating}/5")
        if lead.photo_count is not None:
            out.append(f"Photos sur la fiche Google : {lead.photo_count}")
        if lead.last_review_at:
            out.append(f"Dernier avis Google : {lead.last_review_at:%m/%Y}")
        if lead.gap_score is not None:
            out.append(f"Score de lacune visuelle : {lead.gap_score}/100")
        if lead.gap_reasons:
            out.append("Lacunes détectées : " + " ; ".join(lead.gap_reasons))
    return out


def build_prompt(lead: Lead) -> Prompt:
    user = (
        "Rédige l'e-mail de prospection pour ce lead.\n\n"
        + "\n".join(_lines(lead))
        + "\n\nAppuie l'accroche sur la lacune ou l'occasion la plus concrète ci-dessus."
    )
    return Prompt(system=SYSTEM_PROFILE, user=user)
