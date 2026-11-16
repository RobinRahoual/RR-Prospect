export type LeadKind = "business" | "event";
export type LeadStatus = "new" | "drafted" | "sent" | "replied" | "skipped";
export type DraftStatus = "draft" | "approved" | "sent";

// Les identifiants sont des UUID : indispensable pour la synchronisation PC ⇄ iPad (Firestore)
export interface Lead {
  id: string;
  kind: LeadKind;
  name: string;
  category: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  placeId: string | null;
  rating: number | null;
  photoCount: number | null;
  lastReviewAt: string | null; // ISO
  gapScore: number | null; // 0-100, haut = grosse lacune visuelle
  gapReasons: string[];
  eventName: string | null;
  eventDate: string | null; // ISO
  eventUrl: string | null;
  source: string | null;
  status: LeadStatus;
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LeadInput = Partial<Omit<Lead, "id" | "status" | "analyzedAt" | "createdAt" | "updatedAt">> & { name: string };

export interface Draft {
  id: string;
  leadId: string;
  subject: string;
  bodyHtml: string;
  hookUsed: string;
  confidence: number;
  engine: string; // "gemini:<modèle>" | "ollama:<modèle>"
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DraftOut {
  subject: string;
  bodyHtml: string;
  hookUsed: string;
  confidence: number;
}

export interface Prompt {
  system: string;
  user: string;
}

export type Mode = "auto" | "local" | "cloud";
