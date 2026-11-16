import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Mode } from "../core/types";
import type { AppConfig } from "../shared/ipc";

interface StoredConfig {
  setupDone: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  mode: Mode;
  geminiModel?: string;
  geminiFallback?: string;
  geminiKeyEnc?: string; // chiffré via DPAPI (Windows)
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
