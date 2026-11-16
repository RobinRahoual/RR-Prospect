import type { Lead, DraftOut } from "../types";
import type { Repo } from "../repo";
import type { ScanReport } from "../scan/osm";
import type { ScanSettings } from "../scan/settings";
import { SCAN_CATEGORIES } from "../scan/settings";
import type { Card, ToolCall, ToolOutput, ToolSpec } from "./types";

export const TOOLS: ToolSpec[] = [
  {
    name: "get_overview",
    description: "Résumé du pipeline : nombre de leads par statut et meilleurs leads à contacter.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "search_leads",
    description: "Cherche dans les leads de Robin. Tous les filtres sont optionnels.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texte à chercher dans le nom, la catégorie ou la ville" },
        status: { type: "string", enum: ["new", "drafted", "sent", "replied", "skipped"] },
        limit: { type: "integer", description: "Maximum de résultats (défaut 10)" },
      },
    },
  },
  {
    name: "scan_area",
    description:
      "Lance un scan GRATUIT (OpenStreetMap) des commerces autour de la zone réglée par Robin dans l'onglet Réglages, et ajoute les leads trouvés. Sans argument, utilise ses réglages. À lancer seulement si Robin le demande.",
    parameters: {
      type: "object",
      properties: {
        categories: { type: "array", items: { type: "string", enum: SCAN_CATEGORIES.map((c) => c.id) }, description: "Remplace les catégories réglées, pour ce scan seulement" },
        radius_km: { type: "number", description: "Remplace le rayon réglé (1 à 50), pour ce scan seulement" },
      },
    },
  },
  {
    name: "analyze_lead",
    description:
      "Visite le site web d'un lead (ou des meilleurs leads non analysés si `lead` est omis) et mesure sa présence visuelle : mobile, images, vidéo, mise à jour, réseaux sociaux, email de contact. Met à jour le score. Ne lit pas Instagram.",
    parameters: {
      type: "object",
      properties: {
        lead: { type: "string", description: "id, début d'id ou nom ; omis = les meilleurs leads non analysés" },
        limit: { type: "integer", description: "Si `lead` est omis : combien de leads analyser (1 à 10, défaut 5)" },
      },
    },
  },
  {
    name: "get_activity",
    description:
      "Activité après envoi : réponses reçues (réponse, STOP, rebond), leads qui ont ouvert le mail sans répondre, et relances à faire (contactés il y a 4 jours ou plus sans réponse).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_lead",
    description: "Détails d'un lead et de ses brouillons. `lead` = id, début d'id ou nom.",
    parameters: { type: "object", properties: { lead: { type: "string" } }, required: ["lead"] },
  },
  {
    name: "create_lead",
    description: "Ajoute un lead saisi par Robin. N'invente jamais d'email ni de téléphone.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        category: { type: "string" },
        city: { type: "string" },
        website: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        notes: { type: "string", description: "Constat sur sa présence visuelle (ex : peu de photos, Instagram inactif)" },
      },
      required: ["name"],
    },
  },
  {
    name: "generate_draft",
    description:
      "Rédige un brouillon d'email pour un lead (il s'affiche sous forme de carte dans le chat). Robin le relit et le valide, rien n'est envoyé.",
    parameters: {
      type: "object",
      properties: {
        lead: { type: "string", description: "id, début d'id ou nom du lead" },
        instructions: { type: "string", description: "Consigne de Robin pour ce brouillon (angle, ton, offre…)" },
      },
      required: ["lead"],
    },
  },
  {
    name: "list_drafts",
    description: "Liste les brouillons d'un lead.",
    parameters: { type: "object", properties: { lead: { type: "string" } }, required: ["lead"] },
  },
  {
    name: "set_lead_status",
    description: "Marque un lead comme ignoré (skipped) ou le remet à traiter (new).",
    parameters: {
      type: "object",
      properties: { lead: { type: "string" }, status: { type: "string", enum: ["new", "skipped"] } },
      required: ["lead", "status"],
    },
  },
];

export interface ToolDeps {
  repo: Repo;
  scan?: (overrides: Partial<ScanSettings>) => Promise<ScanReport & { settings: ScanSettings }>;
  analyze?: (lead: Lead) => Promise<{ lead: Lead; signals: unknown; note?: string }>;
  generateDraft: (lead: Lead, instructions?: string) => Promise<{ draft: DraftOut; engine: string }>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function resolveLead(repo: Repo, ref: unknown): Lead {
  const r = str(ref);
  if (!r) throw new Error("Référence de lead manquante");
  const all = repo.listLeads();
  const low = r.toLowerCase();
  const hit = all.find((l) => l.id === r) ?? (r.length >= 6 ? all.find((l) => l.id.startsWith(low)) : undefined);
  if (hit) return hit;
  const exact = all.filter((l) => l.name.toLowerCase() === low);
  if (exact.length === 1) return exact[0]!;
  const part = all.filter((l) => l.name.toLowerCase().includes(low));
  if (part.length === 1) return part[0]!;
  if (part.length > 1) throw new Error(`Plusieurs leads correspondent : ${part.slice(0, 5).map((l) => `${l.name} (${l.id.slice(0, 8)})`).join(", ")}. Précise.`);
  throw new Error(`Aucun lead trouvé pour « ${r} »`);
}

const brief = (l: Lead) => ({
  id: l.id.slice(0, 8),
  name: l.name,
  category: l.category,
  city: l.city,
  gapScore: l.gapScore,
  status: l.status,
  hasEmail: !!l.email,
});

const leadsCard = (ls: Lead[]): Card => ({
  type: "leads",
  leads: ls.map((l) => ({ id: l.id, name: l.name, category: l.category, city: l.city, gapScore: l.gapScore, status: l.status })),
});

export function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function executeTool(deps: ToolDeps, call: ToolCall): Promise<ToolOutput> {
  const { repo } = deps;
  const a = call.args;
  switch (call.name) {
    case "get_overview": {
      const all = repo.listLeads();
      const by: Record<string, number> = {};
      for (const l of all) by[l.status] = (by[l.status] ?? 0) + 1;
      const top = all.filter((l) => l.status === "new").slice(0, 5);
      return { result: { total: all.length, byStatus: by, top: top.map(brief) }, cards: top.length ? [leadsCard(top)] : undefined };
    }
    case "search_leads": {
      const q = str(a.query)?.toLowerCase();
      const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 25);
      const status = str(a.status) as Lead["status"] | null;
      const found = repo
        .listLeads(status ?? undefined)
        .filter((l) => !q || [l.name, l.category, l.city].some((x) => x?.toLowerCase().includes(q)))
        .slice(0, limit);
      return { result: { count: found.length, leads: found.map(brief) }, cards: found.length ? [leadsCard(found)] : undefined };
    }
    case "scan_area": {
      if (!deps.scan) throw new Error("Le scan n'est pas disponible");
      const cats = Array.isArray(a.categories) ? a.categories.filter((x): x is string => typeof x === "string") : undefined;
      const r = await deps.scan({ ...(cats?.length ? { categories: cats } : {}), ...(Number(a.radius_km) ? { radiusKm: Number(a.radius_km) } : {}) });
      const top = repo.listLeads("new").slice(0, 5);
      return {
        result: { zone: r.settings.placeLabel, rayonKm: r.settings.radiusKm, trouvés: r.found, ajoutés: r.added, déjàPrésents: r.duplicates, source: r.source, meilleurs: top.map(brief) },
        cards: top.length ? [leadsCard(top)] : undefined,
      };
    }
    case "analyze_lead": {
      if (!deps.analyze) throw new Error("L'analyse web n'est pas disponible");
      const targets = str(a.lead)
        ? [resolveLead(repo, a.lead)]
        : repo.listLeads().filter((l) => !l.analyzedAt && l.website).slice(0, Math.min(Math.max(Number(a.limit) || 5, 1), 10));
      if (!targets.length) return { result: { message: "Aucun lead avec site web à analyser." } };
      const out = [];
      for (const l of targets) {
        const r = await deps.analyze(l);
        out.push({ ...brief(r.lead), score: r.lead.gapScore, raisons: r.lead.gapReasons, email: r.lead.email, note: r.note });
      }
      return { result: { analysés: out }, cards: [leadsCard(targets.map((l) => repo.getLead(l.id)!))] };
    }
    case "get_activity": {
      const opens = repo.opensByLead();
      const leads = repo.listLeads();
      const byId = new Map(leads.map((l) => [l.id, l]));
      const follow = repo.followUps(4).slice(0, 15).map((f) => ({ lead: byId.get(f.leadId)?.name ?? f.name, envoyéLe: f.sentAt.slice(0, 10), ouvertures: f.opens }));
      const openedNoReply = leads.filter((l) => l.status === "sent" && opens[l.id]).slice(0, 10).map((l) => ({ lead: l.name, ouvertures: opens[l.id]!.opens }));
      return {
        result: {
          réponses: repo.listInbound(10).map((i) => ({ lead: i.leadName, type: i.kind, objet: i.subject, extrait: i.snippet.slice(0, 160), date: i.date.slice(0, 10) })),
          ouvertsSansRéponse: openedNoReply,
          relancesÀFaire: follow,
          note: "Les ouvertures sont indicatives (certains clients mail chargent les images automatiquement).",
        },
      };
    }
    case "get_lead": {
      const l = resolveLead(repo, a.lead);
      const drafts = repo.listDrafts(l.id).map((d) => ({ id: d.id.slice(0, 8), subject: d.subject, status: d.status }));
      return { result: { ...l, id: l.id.slice(0, 8), drafts } };
    }
    case "create_lead": {
      const name = str(a.name);
      if (!name) throw new Error("Nom manquant");
      const notes = str(a.notes);
      const l = repo.createLead({
        name,
        category: str(a.category),
        city: str(a.city),
        website: str(a.website),
        email: str(a.email),
        phone: str(a.phone),
        gapReasons: notes ? [notes] : [],
        source: "chat",
      });
      return { result: { created: brief(l) }, cards: [leadsCard([l])] };
    }
    case "generate_draft": {
      const l = resolveLead(repo, a.lead);
      if (l.email && repo.isSuppressed(l.email)) throw new Error("Ce contact est dans la liste de suppression : ne pas le démarcher.");
      const { draft, engine } = await deps.generateDraft(l, str(a.instructions) ?? undefined);
      const saved = repo.addDraft(l.id, draft, engine);
      return {
        result: { draftId: saved.id.slice(0, 8), subject: saved.subject, hook: saved.hookUsed, confidence: saved.confidence, note: "Le brouillon est affiché à Robin sous forme de carte ; ne le recopie pas." },
        cards: [{ type: "draft", draftId: saved.id, leadId: l.id, leadName: l.name, subject: saved.subject, bodyHtml: saved.bodyHtml, engine }],
      };
    }
    case "list_drafts": {
      const l = resolveLead(repo, a.lead);
      return { result: repo.listDrafts(l.id).map((d) => ({ id: d.id.slice(0, 8), subject: d.subject, status: d.status, text: htmlToPlain(d.bodyHtml).slice(0, 500) })) };
    }
    case "set_lead_status": {
      const l = resolveLead(repo, a.lead);
      const s = a.status === "skipped" ? "skipped" : "new";
      repo.setLeadStatus(l.id, s);
      return { result: { lead: l.name, status: s } };
    }
    default:
      throw new Error(`Outil inconnu : ${call.name}`);
  }
}
