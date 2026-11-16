import { WORKER_JS } from "./worker-source";

type F = typeof fetch;
const API = "https://api.cloudflare.com/client/v4";

export interface DeployResult {
  url: string;
  accountId: string;
}

async function cf<T>(f: F, token: string, method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  const res = await f(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(form ? {} : body ? { "Content-Type": "application/json" } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[]; result?: T };
  if (!res.ok || j.success === false) {
    const msg = j.errors?.map((e) => e.message).join(" ; ") || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new Error(`Cloudflare refuse le jeton (${msg}). Utilise le modèle « Edit Cloudflare Workers ».`);
    throw new Error(msg);
  }
  return j.result as T;
}

/** Déploie le Worker de suivi + son stockage KV dans le compte Cloudflare gratuit de l'utilisateur. */
export async function deployTracker(
  o: { token: string; secret: string; accountId?: string; name?: string },
  f: F = fetch,
  log: (l: string) => void = () => undefined,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<DeployResult> {
  const name = o.name ?? "rr-prospect-track";
  let accountId = o.accountId?.trim();
  if (!accountId) {
    log("Recherche de ton compte Cloudflare…");
    const accs = await cf<{ id: string; name: string }[]>(f, o.token, "GET", "/accounts");
    if (!accs?.length) throw new Error("Aucun compte Cloudflare trouvé pour ce jeton");
    accountId = accs[0]!.id;
  }
  log("Création du stockage (KV)…");
  const spaces = await cf<{ id: string; title: string }[]>(f, o.token, "GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const ns =
    spaces?.find((s) => s.title === name) ??
    (await cf<{ id: string }>(f, o.token, "POST", `/accounts/${accountId}/storage/kv/namespaces`, { title: name }));

  log("Envoi du Worker…");
  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: "2025-01-01",
          bindings: [
            { type: "kv_namespace", name: "KV", namespace_id: ns.id },
            { type: "secret_text", name: "SECRET", text: o.secret },
          ],
        }),
      ],
      { type: "application/json" }
    )
  );
  form.append("worker.js", new Blob([WORKER_JS], { type: "application/javascript+module" }), "worker.js");
  await cf(f, o.token, "PUT", `/accounts/${accountId}/workers/scripts/${name}`, undefined, form);

  log("Activation de l'adresse workers.dev…");
  let sub = (await cf<{ subdomain?: string } | null>(f, o.token, "GET", `/accounts/${accountId}/workers/subdomain`))?.subdomain;
  if (!sub) {
    sub = `rrp-${Math.random().toString(16).slice(2, 8)}`;
    await cf(f, o.token, "PUT", `/accounts/${accountId}/workers/subdomain`, { subdomain: sub });
  }
  await cf(f, o.token, "POST", `/accounts/${accountId}/workers/scripts/${name}/subdomain`, { enabled: true });

  const url = `https://${name}.${sub}.workers.dev`;
  log("Vérification (la mise en ligne peut prendre quelques secondes)…");
  for (let i = 0; i < 8; i++) {
    try {
      const r = await f(`${url}/health`, { signal: AbortSignal.timeout(8_000) });
      if (r.ok && (await r.text()) === "ok") return { url, accountId };
    } catch {
      /* pas encore propagé */
    }
    await wait(3000);
  }
  throw new Error(`Worker déployé mais pas encore joignable sur ${url}. Réessaie dans une minute.`);
}

export class Tracker {
  constructor(private url: string, private secret: string, private f: F = fetch) {}

  pixelUrl(id: string): string {
    return `${this.url}/o/${id}.gif`;
  }

  private async post<T>(path: string, body: unknown, timeout = 6000): Promise<T> {
    const res = await this.f(`${this.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Suivi : HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Déclare un identifiant de suivi avant l'envoi. Retourne false si le Worker est injoignable (le mail part alors sans pixel). */
  async register(id: string): Promise<boolean> {
    try {
      await this.post("/api/register", { id });
      return true;
    } catch {
      return false;
    }
  }

  stats(ids: string[]): Promise<Record<string, { opens: number; first: number | null; last: number | null }>> {
    return this.post("/api/stats", { ids }, 20_000);
  }
}
