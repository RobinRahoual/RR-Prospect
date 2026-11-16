import type { Lead } from "../types";
import type { Repo } from "../repo";

type F = typeof fetch;
const MAX_BYTES = 1_500_000;
const UA = "Mozilla/5.0 (compatible; RR-Prospect/0.3; +https://robinrahoual.fr)";

export interface SiteSignals {
  reachable: boolean;
  status?: number;
  title?: string;
  hasViewport: boolean;
  imageCount: number;
  hasVideo: boolean;
  copyrightYear: number | null;
  socials: Record<string, string>;
  emails: string[];
  generator?: string;
}

/** Refuse les adresses locales/privées : l'URL vient de données externes (OSM, SIRENE…). */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return !(a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (h.includes(":")) return !(h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff"));
  return true;
}

export function extractSignals(html: string): Omit<SiteSignals, "reachable" | "status"> {
  const text = html.slice(0, MAX_BYTES);
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text)?.[1]?.trim();
  const socials: Record<string, string> = {};
  const pats: [string, RegExp][] = [
    ["instagram", /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|explore|reel)([A-Za-z0-9_.]{2,30})/i],
    ["facebook", /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|plugins|tr\?)([A-Za-z0-9_.\-/]{2,60})/i],
    ["tiktok", /https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,30})/i],
    ["youtube", /https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)([A-Za-z0-9_.\-]{2,40})/i],
    ["linkedin", /https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:company|in)\/([A-Za-z0-9_.\-]{2,40})/i],
  ];
  for (const [k, re] of pats) {
    const m = re.exec(text);
    if (m) socials[k] = m[0];
  }
  const emails = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (!/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(e) && !/(sentry|example|wixpress|domain\.|votre|email@)/.test(e)) emails.add(e);
    if (emails.size >= 5) break;
  }
  const years = [...text.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,30}((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].map((m) => Number(m[2] ?? m[1]));
  const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,60})/i.exec(text)?.[1];
  return {
    title,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(text),
    imageCount: (text.match(/<img\b/gi) ?? []).length,
    hasVideo: /<video\b|youtube\.com\/embed|player\.vimeo\.com|dailymotion\.com\/embed/i.test(text),
    copyrightYear: years.length ? Math.max(...years) : null,
    socials,
    emails: [...emails],
    generator: gen,
  };
}

export async function fetchSite(url: string, f: F = fetch, resolvePublic?: (host: string) => Promise<boolean>): Promise<SiteSignals> {
  const empty = { hasViewport: false, imageCount: 0, hasVideo: false, copyrightYear: null, socials: {}, emails: [] };
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(cur);
    if (!/^https?:$/.test(u.protocol) || !isPublicHost(u.hostname) || (resolvePublic && !(await resolvePublic(u.hostname)))) {
      return { reachable: false, ...empty };
    }
    let res: Response;
    try {
      res = await f(cur, { redirect: "manual", headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(12_000) });
    } catch {
      return { reachable: false, ...empty };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      cur = new URL(res.headers.get("location")!, cur).toString();
      continue;
    }
    if (!res.ok) return { reachable: false, status: res.status, ...empty };
    const html = (await res.text()).slice(0, MAX_BYTES);
    return { reachable: true, status: res.status, ...extractSignals(html) };
  }
  return { reachable: false, ...empty };
}

export function scoreSite(sig: SiteSignals, year = new Date().getFullYear()): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!sig.reachable) return { score: 60, reasons: ["Site injoignable ou bloqué à l'analyse automatique"] };
  let score = 0;
  const add = (n: number, r: string) => ((score += n), reasons.push(r));
  if (!sig.hasViewport) add(20, "Site non adapté au mobile");
  if (sig.imageCount <= 3) add(20, `Très peu d'images sur la page d'accueil (${sig.imageCount})`);
  if (!sig.hasVideo) add(10, "Aucune vidéo sur la page d'accueil");
  if (sig.copyrightYear && sig.copyrightYear <= year - 3) add(15, `Site pas mis à jour depuis ©${sig.copyrightYear}`);
  if (!Object.keys(sig.socials).length) add(15, "Aucun lien vers des réseaux sociaux");
  if (sig.socials.instagram) reasons.push(`Instagram : ${sig.socials.instagram} (à regarder à la main, l'app ne peut pas lire Instagram)`);
  return { score: Math.min(score, 100), reasons };
}

/** Choisit l'email du site le plus plausible (même domaine de préférence, hors adresses génériques peu utiles). */
export function pickEmail(emails: string[], website: string | null): string | null {
  let host = "";
  try {
    host = new URL(website ?? "").hostname.replace(/^www\./, "");
  } catch {
    /* ignore */
  }
  const same = emails.filter((e) => host && e.endsWith(`@${host}`));
  return (same[0] ?? emails[0]) || null;
}

export async function analyzeLead(
  repo: Repo,
  lead: Lead,
  f: F = fetch,
  resolvePublic?: (host: string) => Promise<boolean>
): Promise<{ lead: Lead; signals: SiteSignals | null; note?: string }> {
  if (!lead.website) {
    repo.updateLead(lead.id, { analyzed: true });
    return { lead: repo.getLead(lead.id)!, signals: null, note: "Pas de site web : rien à analyser (c'est déjà un signal fort)." };
  }
  const sig = await fetchSite(lead.website, f, resolvePublic);
  const { score, reasons } = scoreSite(sig);
  repo.updateLead(lead.id, {
    gapScore: score,
    gapReasons: reasons,
    email: lead.email ?? (sig.reachable ? pickEmail(sig.emails, lead.website) : null),
    analyzed: true,
  });
  return { lead: repo.getLead(lead.id)!, signals: sig };
}
