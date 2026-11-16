import type { ChatMessage } from "../core/chat/types";
import type { Conversation } from "../core/repo";
import type { BatchProgress, MailSettings, SendResult } from "../core/mail/mailer";
import type { GeoResult, ScanReport } from "../core/scan/osm";
import type { ScanSettings } from "../core/scan/settings";
import type { Draft, DraftStatus, Lead, LeadInput, Mode } from "../core/types";

export interface AppConfig {
  setupDone: boolean;
  ollamaModel: string;
  mode: Mode;
  hasGeminiKey: boolean;
  geminiModel: string | null;
  geminiFallback: string | null;
}

export type SetupStep = "ollama" | "model" | "gpu" | "gemini";
export interface SetupParams {
  model?: string;
  geminiKey?: string;
}
export interface StepResult {
  ok: boolean;
  detail?: string;
  warn?: string;
  error?: string;
  hint?: string;
}

/** Contrat entre l'interface (renderer) et le processus principal. Exposé en `window.api`. */
export type UpdateState =
  | { state: "idle" | "checking" | "uptodate" | "unavailable"; version: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string; next: string };

export interface MailState {
  settings: MailSettings;
  hasPassword: boolean;
  configured: boolean;
  sentToday: number;
  cap: number;
}

export interface InboundItem {
  leadId: string;
  leadName: string;
  kind: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

export interface TrackState {
  enabled: boolean;
  url: string | null;
}

export interface SyncState {
  configured: boolean;
  projectId: string;
  apiKey: string;
  email: string;
  hasPassword: boolean;
  lastAt: string | null;
  lastError: string | null;
  rules: string;
}

/** Fonctions propres à l'app web (iPad) */
export interface WebApi {
  jobs: {
    /** Confie une tâche au PC (il l'exécute dès qu'il est allumé) */
    enqueue(kind: import("../core/repo").JobKind, params?: Record<string, unknown>): Promise<import("../core/repo").Job>;
    list(): Promise<import("../core/repo").Job[]>;
  };
  getKeys(): Promise<{ hasGemini: boolean; geminiModel: string | null }>;
  setGeminiKey(key: string): Promise<{ hasGemini: boolean; geminiModel: string | null; warn?: string }>;
  signOut(): Promise<void>;
}

export interface Api {
  web?: WebApi;
  sync: {
    get(): Promise<SyncState>;
    set(cfg: { projectId: string; apiKey: string; email: string }, password?: string): Promise<SyncState>;
    run(): Promise<{ pulled: number; pushed: number }>;
    disable(): Promise<SyncState>;
    onDone(cb: (r: { pulled: number; pushed: number; error?: string }) => void): void;
  };
  inbox: {
    check(): Promise<{ replies: number; stops: number; bounces: number; checked: number }>;
    list(): Promise<InboundItem[]>;
    onNew(cb: (r: { replies: number; stops: number; bounces: number }) => void): void;
  };
  track: {
    get(): Promise<TrackState>;
    install(token: string): Promise<TrackState>;
    disable(): Promise<TrackState>;
    refresh(): Promise<Record<string, { opens: number; last: string | null }>>;
    opens(): Promise<Record<string, { opens: number; last: string | null }>>;
    onLog(cb: (l: string) => void): void;
  };
  mail: {
    get(): Promise<MailState>;
    set(settings: Partial<MailSettings>, appPassword?: string): Promise<MailState>;
    test(): Promise<SendResult>;
    send(draftId: string): Promise<SendResult>;
    sendApproved(): Promise<{ sent: number; failed: number; stopped: boolean }>;
    cancel(): Promise<void>;
    onProgress(cb: (p: BatchProgress) => void): void;
  };
  update: {
    state(): Promise<UpdateState>;
    check(): Promise<void>;
    install(): Promise<void>;
    onState(cb: (s: UpdateState) => void): void;
  };
  config: {
    get(): Promise<AppConfig>;
    setMode(mode: Mode): Promise<void>;
  };
  setup: {
    step(name: SetupStep, params: SetupParams): Promise<StepResult>;
    finish(): Promise<void>;
    onLog(cb: (line: string) => void): void;
  };
  leads: {
    list(): Promise<Lead[]>;
    create(input: LeadInput): Promise<Lead>;
    analyze(id: string): Promise<{ lead: Lead; note?: string }>;
    get(id: string): Promise<Lead | null>;
    suppress(id: string): Promise<Lead | null>;
  };
  scan: {
    getSettings(): Promise<ScanSettings>;
    setSettings(s: Partial<ScanSettings>): Promise<ScanSettings>;
    geocode(query: string): Promise<GeoResult>;
    run(): Promise<ScanReport>;
    hasOaKey(): Promise<boolean>;
    setOaKey(key: string): Promise<void>;
    onLog(cb: (line: string) => void): void;
  };
  chat: {
    list(): Promise<Conversation[]>;
    create(): Promise<Conversation>;
    messages(conversationId: string): Promise<ChatMessage[]>;
    /** Résolu quand la réponse complète est terminée ; les messages arrivent en direct via onMessage */
    send(conversationId: string, text: string): Promise<void>;
    remove(conversationId: string): Promise<void>;
    onMessage(cb: (m: ChatMessage) => void): void;
  };
  drafts: {
    list(leadId: string): Promise<Draft[]>;
    generate(leadId: string, mode?: Mode): Promise<Draft>;
    update(id: string, patch: { subject?: string; bodyHtml?: string; status?: DraftStatus }): Promise<Draft>;
  };
}
