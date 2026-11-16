import type { ChatMessage } from "../core/chat/types";
import type { Conversation } from "../core/repo";
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
export interface Api {
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
