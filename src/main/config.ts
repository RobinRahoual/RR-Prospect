import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Mode } from "../core/types";
import { DEFAULT_MAIL, type MailSettings } from "../core/mail/mailer";
import { DEFAULT_SCAN, type ScanSettings } from "../core/scan/settings";
import type { AppConfig } from "../shared/ipc";

interface StoredConfig {
  setupDone: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  mode: Mode;
  geminiModel?: string;
  geminiFallback?: string;
  geminiKeyEnc?: string; // chiffré via DPAPI (Windows)
  scan?: ScanSettings;
  mail?: MailSettings;
  firebase?: { projectId: string; apiKey: string; email: string };
  fbPassEnc?: string;
  fbPassPlain?: string;
  trackUrl?: string;
  trackSecretEnc?: string;
  trackSecretPlain?: string;
  lastInboxCheck?: string;
  mailPassEnc?: string;
  mailPassPlain?: string;
  oaKeyEnc?: string;
  oaKeyPlain?: string;
  geminiKeyPlain?: string; // uniquement si le chiffrement est indisponible
}

const DEFAULTS: StoredConfig = {
  setupDone: false,
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "mistral-nemo",
  mode: "auto",
};

const file = () => path.join(app.getPath("userData"), "config.json");

export class ConfigStore {
  private c: StoredConfig;

  constructor() {
    try {
      this.c = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), "utf8")) };
    } catch {
      this.c = { ...DEFAULTS };
    }
  }

  get v(): Readonly<StoredConfig> {
    return this.c;
  }

  set(patch: Partial<StoredConfig>): void {
    this.c = { ...this.c, ...patch };
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(this.c, null, 2));
  }

  setGeminiKey(key: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      this.set({ geminiKeyEnc: safeStorage.encryptString(key).toString("base64"), geminiKeyPlain: undefined });
    } else {
      this.set({ geminiKeyPlain: key, geminiKeyEnc: undefined });
    }
  }

  getGeminiKey(): string | null {
    try {
      if (this.c.geminiKeyEnc) return safeStorage.decryptString(Buffer.from(this.c.geminiKeyEnc, "base64"));
    } catch {
      return null;
    }
    return this.c.geminiKeyPlain ?? null;
  }

  setOaKey(key: string): void {
    if (!key) return this.set({ oaKeyEnc: undefined, oaKeyPlain: undefined });
    if (safeStorage.isEncryptionAvailable()) this.set({ oaKeyEnc: safeStorage.encryptString(key).toString("base64"), oaKeyPlain: undefined });
    else this.set({ oaKeyPlain: key, oaKeyEnc: undefined });
  }

  getOaKey(): string | null {
    try {
      if (this.c.oaKeyEnc) return safeStorage.decryptString(Buffer.from(this.c.oaKeyEnc, "base64"));
    } catch {
      return null;
    }
    return this.c.oaKeyPlain ?? null;
  }

  get mail(): MailSettings {
    return { ...DEFAULT_MAIL, ...(this.c.mail ?? {}) };
  }

  setMailPass(pass: string): void {
    if (safeStorage.isEncryptionAvailable()) this.set({ mailPassEnc: safeStorage.encryptString(pass).toString("base64"), mailPassPlain: undefined });
    else this.set({ mailPassPlain: pass, mailPassEnc: undefined });
  }

  getMailPass(): string | null {
    try {
      if (this.c.mailPassEnc) return safeStorage.decryptString(Buffer.from(this.c.mailPassEnc, "base64"));
    } catch {
      return null;
    }
    return this.c.mailPassPlain ?? null;
  }

  setTrack(url: string, secret: string): void {
    const enc = safeStorage.isEncryptionAvailable();
    this.set({
      trackUrl: url,
      trackSecretEnc: enc ? safeStorage.encryptString(secret).toString("base64") : undefined,
      trackSecretPlain: enc ? undefined : secret,
    });
  }

  clearTrack(): void {
    this.set({ trackUrl: undefined, trackSecretEnc: undefined, trackSecretPlain: undefined });
  }

  getTrack(): { url: string; secret: string } | null {
    if (!this.c.trackUrl) return null;
    try {
      const secret = this.c.trackSecretEnc ? safeStorage.decryptString(Buffer.from(this.c.trackSecretEnc, "base64")) : this.c.trackSecretPlain;
      return secret ? { url: this.c.trackUrl, secret } : null;
    } catch {
      return null;
    }
  }

  setFirebase(f: { projectId: string; apiKey: string; email: string } | null, password?: string): void {
    if (!f) return this.set({ firebase: undefined, fbPassEnc: undefined, fbPassPlain: undefined });
    this.set({ firebase: f });
    if (password) {
      const enc = safeStorage.isEncryptionAvailable();
      this.set({ fbPassEnc: enc ? safeStorage.encryptString(password).toString("base64") : undefined, fbPassPlain: enc ? undefined : password });
    }
  }

  getFirebase(): { projectId: string; apiKey: string; email: string; password: string } | null {
    const f = this.c.firebase;
    if (!f) return null;
    try {
      const password = this.c.fbPassEnc ? safeStorage.decryptString(Buffer.from(this.c.fbPassEnc, "base64")) : this.c.fbPassPlain;
      return password ? { ...f, password } : null;
    } catch {
      return null;
    }
  }

  get scan(): ScanSettings {
    return { ...DEFAULT_SCAN, ...(this.c.scan ?? {}) };
  }

  toPublic(): AppConfig {
    return {
      setupDone: this.c.setupDone,
      ollamaModel: this.c.ollamaModel,
      mode: this.c.mode,
      hasGeminiKey: !!this.getGeminiKey() && !!this.c.geminiModel,
      geminiModel: this.c.geminiModel ?? null,
      geminiFallback: this.c.geminiFallback ?? null,
    };
  }
}
