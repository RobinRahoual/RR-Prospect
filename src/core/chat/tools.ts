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
