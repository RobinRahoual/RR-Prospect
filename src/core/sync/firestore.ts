type F = typeof fetch;

export interface RemoteDoc {
  id: string;
  u: string; // date de modification (ISO) posée par l'appareil
  j: string; // ligne sérialisée en JSON
  p: string; // heure d'écriture côté serveur (sert de curseur de synchronisation)
}
export interface RemoteWrite {
  col: string;
  id: string;
  u: string;
  j: string;
}

/** Contrat minimal du serveur de synchronisation (Firestore en vrai, mémoire dans les tests). */
export interface Remote {
  commit(writes: RemoteWrite[]): Promise<void>;
  /** Documents écrits au plus tôt à `sinceP` (inclus), par ordre d'écriture */
  pull(col: string, sinceP: string | null, limit: number): Promise<RemoteDoc[]>;
}

export interface FirebaseConfig {
  projectId: string;
  apiKey: string;
  email: string;
  password?: string;
}

/** Connexion email / mot de passe (API REST Firebase Auth) avec renouvellement automatique du jeton. */
export class FirebaseAuth {
  private idToken = "";
  private expires = 0;

  constructor(
    private cfg: { apiKey: string; email: string; password?: string },
    private f: F = (...a) => fetch(...a),
    private opts: { refreshToken?: string; onRefreshToken?: (t: string) => void } = {}
  ) {}

  private async call(url: string, init: RequestInit) {
    const res = await this.f(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string }; [k: string]: unknown };
    if (!res.ok) throw new Error(authMessage(j.error?.message ?? `HTTP ${res.status}`));
    return j;
  }

  async token(): Promise<string> {
    if (this.idToken && Date.now() < this.expires - 60_000) return this.idToken;
    let j: Record<string, unknown> | null = null;
    if (this.opts.refreshToken) {
      try {
        const r = await this.call(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.cfg.apiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.opts.refreshToken)}`,
        });
        j = { idToken: r.id_token, refreshToken: r.refresh_token, expiresIn: r.expires_in };
      } catch {
        this.opts.refreshToken = undefined; // jeton périmé : on retombe sur le mot de passe
      }
    }
    if (!j) {
      if (!this.cfg.password) throw new Error("Connexion requise");
      j = await this.call(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(this.cfg.apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password, returnSecureToken: true }),
      });
    }
    this.idToken = String(j.idToken);
    this.expires = Date.now() + Number(j.expiresIn ?? 3600) * 1000;
    if (j.refreshToken) {
      this.opts.refreshToken = String(j.refreshToken);
      this.opts.onRefreshToken?.(String(j.refreshToken));
    }
    return this.idToken;
  }
}

export function authMessage(code: string): string {
  if (/EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS/.test(code)) return "Email ou mot de passe Firebase incorrect.";
  if (/API key not valid|API_KEY_INVALID/i.test(code)) return "Clé API Firebase invalide.";
  if (/OPERATION_NOT_ALLOWED/.test(code)) return "La connexion par email/mot de passe n'est pas activée dans Firebase (Authentication → Sign-in method).";
  if (/TOO_MANY_ATTEMPTS/.test(code)) return "Trop de tentatives : réessaie dans quelques minutes.";
  return code;
}

const ts = (iso: string) => ({ timestampValue: iso });

export class FirestoreRemote implements Remote {
  private base: string;
  constructor(private projectId: string, private auth: FirebaseAuth, private f: F = (...a) => fetch(...a)) {
    this.base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.auth.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } } & T;
    if (!res.ok) {
      const st = (j as { error?: { status?: string } }).error?.status;
      if (st === "PERMISSION_DENIED") throw new Error("Firestore refuse l'accès : vérifie les règles de sécurité et l'email utilisé.");
      if (st === "NOT_FOUND" || res.status === 404) throw new Error("Base Firestore introuvable : crée-la dans la console Firebase (Firestore Database → Créer).");
      if (st === "RESOURCE_EXHAUSTED") throw new Error("Quota Firebase gratuit atteint pour aujourd'hui : la synchronisation reprendra demain.");
      throw new Error((j as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
    }
    return j;
  }

  async commit(writes: RemoteWrite[]): Promise<void> {
    for (let i = 0; i < writes.length; i += 100) {
      const chunk = writes.slice(i, i + 100);
      await this.post(":commit", {
        writes: chunk.map((w) => ({
          update: {
            name: `projects/${this.projectId}/databases/(default)/documents/${w.col}/${encodeURIComponent(w.id)}`,
            fields: { u: { stringValue: w.u }, j: { stringValue: w.j } },
          },
          updateTransforms: [{ fieldPath: "p", setToServerValue: "REQUEST_TIME" }],
        })),
      });
    }
  }

  async pull(col: string, sinceP: string | null, limit: number): Promise<RemoteDoc[]> {
    const rows = await this.post<{ document?: { name: string; fields?: Record<string, Record<string, string>> } }[]>(":runQuery", {
      structuredQuery: {
        from: [{ collectionId: col }],
        ...(sinceP ? { where: { fieldFilter: { field: { fieldPath: "p" }, op: "GREATER_THAN_OR_EQUAL", value: ts(sinceP) } } } : {}),
        orderBy: [{ field: { fieldPath: "p" }, direction: "ASCENDING" }],
        limit,
      },
    });
    const out: RemoteDoc[] = [];
    for (const r of rows) {
      const d = r.document;
      const fl = d?.fields;
      if (!d || !fl?.u?.stringValue || !fl.j?.stringValue || !fl.p?.timestampValue) continue;
      out.push({ id: decodeURIComponent(d.name.split("/").pop()!), u: fl.u.stringValue, j: fl.j.stringValue, p: fl.p.timestampValue });
    }
    return out;
  }
}

export const FIRESTORE_RULES = (email: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null && request.auth.token.email == "${email.replace(/"/g, "")}";
    }
  }
}`;
