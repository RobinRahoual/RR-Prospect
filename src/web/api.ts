import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import {
  buildPrompt, buildSystem, Database, DEFAULT_SCAN, enqueueJob, executeTool, FIRESTORE_RULES, FirebaseAuth, FirestoreRemote, GeminiChat, GeminiEngine,
  LLMRouter, Repo, runAgent, syncOnce, testGeminiKey, TOOLS, trimHistory, type ChatMessage, type Lead,
} from "../core/web";
import type { Api, SyncState } from "../shared/ipc";

const LS = {
  fb: "rrp.fb",
  rt: "rrp.rt",
  gem: "rrp.gem",
};
const read = <T>(k: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "null") as T | null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* stockage indisponible (navigation privée) : on reste en mémoire */
  }
};

const PC_ONLY = () => new Error("Disponible uniquement dans l'app PC.");
const QUEUED = "Demandé au PC : il l'exécutera dès qu'il est allumé (réponse dans quelques instants si c'est le cas).";

type Fb = { projectId: string; apiKey: string; email: string };
type Gem = { key: string; model: string; fallback: string };

export async function createWebApi(): Promise<Api> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new Database(new SQL.Database());
  const repo = new Repo(db);
  repo.migrate();

  let fb = read<Fb>(LS.fb);
  let gem = read<Gem>(LS.gem);
  let auth: FirebaseAuth | null = null;
  let syncing = false;
  let last: { at: string | null; error: string | null } = { at: null, error: null };
  const doneCbs = new Set<(r: { pulled: number; pushed: number; error?: string }) => void>();
  const msgCbs = new Set<(m: ChatMessage) => void>();

  const remote = (password?: string) => {
    if (!fb) throw new Error("Synchronisation non configurée (Réglages)");
    if (password || !auth) {
      auth = new FirebaseAuth({ apiKey: fb.apiKey, email: fb.email, password }, (...a) => fetch(...a), {
        refreshToken: read<string>(LS.rt) ?? undefined,
        onRefreshToken: (t) => write(LS.rt, t),
      });
    }
    return new FirestoreRemote(fb.projectId, auth);
  };

  async function sync(password?: string) {
    if (!fb || syncing) return { pulled: 0, pushed: 0 };
    syncing = true;
    try {
      const r = await syncOnce(repo, remote(password));
      last = { at: new Date().toISOString(), error: null };
      doneCbs.forEach((cb) => cb(r));
      return r;
    } catch (e) {
      const m = (e as Error).message;
      last = { at: last.at, error: m };
      doneCbs.forEach((cb) => cb({ pulled: 0, pushed: 0, error: m }));
      throw e;
    } finally {
      syncing = false;
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (!fb) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void sync().catch(() => undefined), 2000);
  };

  // Tant qu'une commande attend le PC, on regarde plus souvent si elle est terminée
  setInterval(() => document.visibilityState === "visible" && fb && repo.openJobs().length && void sync().catch(() => undefined), 8_000);
  // Rafraîchit en continu : toutes les minutes et au retour sur l'app
  setInterval(() => document.visibilityState === "visible" && void sync().catch(() => undefined), 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void sync().catch(() => undefined));
  if (fb) void sync().catch(() => undefined);

  const cloudEngine = () => (gem ? new GeminiEngine({ apiKey: gem.key, model: gem.model, fallbackModel: gem.fallback }) : null);
  const busy = new Set<string>();

  const syncState = (): SyncState => ({
    configured: !!fb,
    projectId: fb?.projectId ?? "",
    apiKey: fb?.apiKey ?? "",
    email: fb?.email ?? "",
    hasPassword: !!read(LS.rt),
    lastAt: last.at,
    lastError: last.error,
    rules: FIRESTORE_RULES(fb?.email || "ton-email@exemple.fr"),
  });

  const none = { opens: {} as Record<string, never> };

  return {
    web: {
      jobs: {
        enqueue: async (kind, params) => {
          const j = enqueueJob(repo, kind, params);
          soon();
          return j;
        },
        list: async () => repo.listJobs(15),
      },
      getKeys: async () => ({ hasGemini: !!gem, geminiModel: gem?.model ?? null }),
      setGeminiKey: async (key) => {
        const k = key.trim();
        const r = await testGeminiKey(k, "gemini-pro-latest", "gemini-flash-latest");
        if (!r.keyOk) throw new Error(`Clé refusée par Google (${r.status}).`);
        if (!r.pro && !r.flash) throw new Error("Aucun modèle Gemini utilisable avec cette clé.");
        gem = { key: k, model: (r.pro ?? r.flash)!, fallback: (r.flash ?? r.pro)! };
        write(LS.gem, gem);
        return { hasGemini: true, geminiModel: gem.model, warn: r.pro ? undefined : `Pro indisponible (${r.proMsg}) : Flash utilisé.` };
      },
      signOut: async () => {
        write(LS.fb, null);
        write(LS.rt, null);
        write(LS.gem, null);
        location.reload();
      },
    },
    config: {
      get: async () => ({ setupDone: true, ollamaModel: "", mode: "cloud", hasGeminiKey: !!gem, geminiModel: gem?.model ?? null, geminiFallback: gem?.fallback ?? null }),
      setMode: async () => undefined,
    },
    setup: { step: async () => ({ ok: true }), finish: async () => undefined, onLog: () => undefined },
    update: { state: async () => ({ state: "unavailable", version: "web" }), check: async () => undefined, install: async () => undefined, onState: () => undefined },
    leads: {
      list: async () => repo.listLeads(),
      create: async (i) => {
        const l = repo.createLead(i);
        soon();
        return l;
      },
      get: async (id) => repo.getLead(id),
      analyze: async (id) => {
        const lead = repo.getLead(id);
        if (!lead) throw new Error("Lead introuvable");
        enqueueJob(repo, "analyze", { leadId: id });
        soon();
        return { lead, note: `Analyse ${QUEUED}` };
      },
      suppress: async (id) => {
        const l = repo.getLead(id);
        if (!l) return null;
        if (l.email) repo.addSuppression(l.email, "ne pas contacter (manuel)");
        repo.setLeadStatus(l.id, "skipped");
        soon();
        return repo.getLead(id);
      },
    },
    drafts: {
      list: async (leadId) => repo.listDrafts(leadId),
      generate: async (leadId) => {
        const lead = repo.getLead(leadId);
        if (!lead) throw new Error("Lead introuvable");
        const r = await new LLMRouter(null, cloudEngine()).generate(buildPrompt(lead, { examples: repo.listApprovedExamples(3) }), "cloud");
        const d = repo.addDraft(lead.id, r.draft, r.engine);
        soon();
        return d;
      },
      update: async (id, patch) => {
        const d = repo.updateDraft(id, patch);
        soon();
        return d;
      },
    },
    chat: {
      list: async () => repo.listConversations(),
      create: async () => repo.createConversation(),
      messages: async (id) => repo.getMessages(id),
      remove: async (id) => repo.deleteConversation(id),
      onMessage: (cb) => void msgCbs.add(cb),
      send: async (convId, text) => {
        const clean = text.trim().slice(0, 8000);
        if (!clean) return;
        if (busy.has(convId)) throw new Error("Une réponse est déjà en cours dans cette conversation.");
        if (!gem) throw new Error("Ajoute ta clé Gemini dans Réglages.");
        busy.add(convId);
        try {
          const emit = (m: ChatMessage) => msgCbs.forEach((cb) => cb(m));
          const first = repo.getMessages(convId).length === 0;
          emit(repo.addMessage(convId, { role: "user", content: clean }));
          if (first) repo.renameConversation(convId, clean.replace(/\s+/g, " ").slice(0, 48));
          const router = new LLMRouter(null, cloudEngine());
          const deps = {
            repo,
            scan: async (o: { categories?: string[]; radiusKm?: number }) => {
              enqueueJob(repo, "scan", o);
              soon();
              return { queued: `Scan ${QUEUED} Les nouveaux leads apparaîtront après la synchro.` };
            },
            analyze: async (lead: Lead) => {
              enqueueJob(repo, "analyze", { leadId: lead.id });
              soon();
              return { queued: `Analyse de ${lead.name} ${QUEUED}` };
            },
            generateDraft: (lead: Lead, instructions?: string) => router.generate(buildPrompt(lead, { instructions, examples: repo.listApprovedExamples(3) }), "cloud"),
          };
          await runAgent(
            {
              local: null,
              cloud: new GeminiChat({ apiKey: gem.key, model: gem.model, fallbackModel: gem.fallback }),
              mode: "cloud",
              system: buildSystem(repo),
              tools: TOOLS,
              execute: (call) => executeTool(deps, call),
              onMessage: (m) => emit(repo.addMessage(convId, m)),
            },
            trimHistory(repo.getMessages(convId))
          );
        } finally {
          busy.delete(convId);
          soon();
        }
      },
    },
    scan: {
      getSettings: async () => DEFAULT_SCAN,
      setSettings: async () => DEFAULT_SCAN,
      geocode: async () => {
        throw PC_ONLY();
      },
      run: async () => {
        throw PC_ONLY();
      },
      hasOaKey: async () => false,
      setOaKey: async () => undefined,
      onLog: () => undefined,
    },
    mail: {
      get: async () => {
        throw PC_ONLY();
      },
      set: async () => {
        throw PC_ONLY();
      },
      test: async () => ({ ok: false, error: "Le test d'envoi se fait depuis le PC." }),
      send: async (draftId) => {
        const d = repo.getDraft(draftId);
        if (!d) return { ok: false, error: "Brouillon introuvable" };
        if (d.status !== "approved") return { ok: false, error: "Valide le brouillon avant de l'envoyer" };
        const j = enqueueJob(repo, "send", { draftId });
        soon();
        return { ok: true, to: repo.getLead(d.leadId)?.email ?? "", messageId: j.id };
      },
      sendApproved: async () => {
        enqueueJob(repo, "send_approved");
        soon();
        return { sent: 0, failed: 0, stopped: false };
      },
      cancel: async () => undefined,
      onProgress: () => undefined,
    },
    inbox: { check: async () => ({ replies: 0, stops: 0, bounces: 0, checked: 0 }), list: async () => [], onNew: () => undefined },
    track: {
      get: async () => ({ enabled: false, url: null }),
      install: async () => {
        throw PC_ONLY();
      },
      disable: async () => ({ enabled: false, url: null }),
      refresh: async () => none.opens,
      opens: async () => none.opens,
      onLog: () => undefined,
    },
    sync: {
      get: async () => syncState(),
      set: async (cfg, password) => {
        fb = { projectId: cfg.projectId.trim(), apiKey: cfg.apiKey.trim(), email: cfg.email.trim() };
        if (!fb.projectId || !fb.apiKey || !fb.email) throw new Error("Renseigne l'identifiant du projet, la clé API et l'email");
        if (!password?.trim() && !read(LS.rt)) throw new Error("Renseigne aussi le mot de passe");
        write(LS.fb, fb);
        auth = null;
        try {
          await sync(password?.trim() || undefined);
        } catch (e) {
          fb = null;
          write(LS.fb, null);
          write(LS.rt, null);
          throw e;
        }
        return syncState();
      },
      run: async () => sync(),
      disable: async () => {
        fb = null;
        auth = null;
        write(LS.fb, null);
        write(LS.rt, null);
        return syncState();
      },
      onDone: (cb) => void doneCbs.add(cb),
    },
  };
}
