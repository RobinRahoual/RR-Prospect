import { FormEvent, useEffect, useRef, useState } from "react";
import type { Draft, Lead, LeadInput, Mode } from "../core/types";
import type { AppConfig } from "../shared/ipc";
import { errMsg, htmlToText, sanitizeHtml } from "./util";

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: "auto", label: "Auto", help: "Local d'abord, repli Gemini" },
  { id: "local", label: "Local", help: "Ollama uniquement" },
  { id: "cloud", label: "Cloud", help: "Gemini uniquement" },
];

export function Workspace({ cfg, onCfg, reloadKey = 0 }: { cfg: AppConfig; onCfg: (c: AppConfig) => void; reloadKey?: number }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = async () => setLeads(await window.api.leads.list());
  useEffect(() => {
    refresh();
  }, [reloadKey]);

  const lead = leads.find((l) => l.id === sel) ?? null;

  return (
    <div className="split">
      <aside>
        <header>
          <h2>Leads</h2>
          <button className="primary small" onClick={() => setAdding((a) => !a)}>
            {adding ? "Fermer" : "+ Ajouter"}
          </button>
        </header>
        {adding && (
          <AddLead
            onCreated={async (l) => {
              await refresh();
              setSel(l.id);
              setAdding(false);
            }}
          />
        )}
        <ul className="leads">
          {leads.length === 0 && <li className="muted pad">Aucun lead. Ajoute-en un pour tester la génération.</li>}
          {leads.map((l) => (
            <li key={l.id} className={l.id === sel ? "active" : ""} onClick={() => setSel(l.id)}>
              <strong>{l.name}</strong>
              <span className="muted">{[l.category, l.city].filter(Boolean).join(" · ") || "—"}</span>
              <span className="badges">
                {l.gapScore != null && <em className="badge">{l.gapScore}</em>}
                <em className={`badge s-${l.status}`}>{l.status}</em>
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <section>
        {lead ? (
          <LeadView key={lead.id} lead={lead} cfg={cfg} onCfg={onCfg} onChanged={refresh} />
        ) : (
          <div className="center muted">Sélectionne un lead</div>
        )}
      </section>
    </div>
  );
}

function AddLead({ onCreated }: { onCreated: (l: Lead) => void }) {
  const [f, setF] = useState({ name: "", category: "", city: "Dijon", website: "", email: "", gapScore: "", reasons: "" });
  const [err, setErr] = useState("");
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const nz = (s: string) => s.trim() || null;
    const input: LeadInput = {
      name: f.name,
      category: nz(f.category),
      city: nz(f.city),
      website: nz(f.website),
      email: nz(f.email),
      gapScore: f.gapScore ? Number(f.gapScore) : null,
      gapReasons: f.reasons.split("\n").map((s) => s.trim()).filter(Boolean),
      source: "manuel",
    };
    try {
      onCreated(await window.api.leads.create(input));
    } catch (e2) {
      setErr(errMsg(e2));
    }
  }

  return (
    <form className="stack pad" onSubmit={submit}>
      <input placeholder="Nom *" value={f.name} onChange={up("name")} required />
      <div className="row">
        <input placeholder="Catégorie (bar, resto…)" value={f.category} onChange={up("category")} />
        <input placeholder="Ville" value={f.city} onChange={up("city")} />
      </div>
      <input placeholder="Site web (vide = aucun)" value={f.website} onChange={up("website")} />
      <input placeholder="E-mail" value={f.email} onChange={up("email")} />
      <input placeholder="Score de lacune 0-100" type="number" min={0} max={100} value={f.gapScore} onChange={up("gapScore")} />
      <textarea placeholder={"Lacunes, une par ligne\nex. 6 photos seulement sur Google"} rows={3} value={f.reasons} onChange={up("reasons")} />
      {err && <div className="error">{err}</div>}
      <button className="primary">Créer</button>
    </form>
  );
}

function LeadView({ lead, cfg, onCfg, onChanged }: { lead: Lead; cfg: AppConfig; onCfg: (c: AppConfig) => void; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => setDrafts(await window.api.drafts.list(lead.id));
  useEffect(() => {
    load();
  }, [lead.id]);

  async function setMode(mode: Mode) {
    await window.api.config.setMode(mode);
    onCfg({ ...cfg, mode });
  }

  async function analyze() {
    setBusy(true);
    setErr("");
    try {
      const r = await window.api.leads.analyze(lead.id);
      if (r.note) setErr(r.note);
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setErr("");
    try {
      await window.api.drafts.generate(lead.id);
      await load();
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lead">
      <h2>{lead.name}</h2>
      <p className="muted">
        {[lead.category, lead.city, lead.website ?? "aucun site web", lead.email].filter(Boolean).join(" · ")}
      </p>
      {lead.gapReasons.length > 0 && (
        <ul className="reasons">
          {lead.gapReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Moteur IA">
          {MODES.map((m) => (
            <button key={m.id} title={m.help} className={cfg.mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <button disabled={busy} onClick={analyze} title="Visite le site et mesure sa présence visuelle">
          {lead.analyzedAt ? "Ré-analyser le site" : "Analyser le site"}
        </button>
        <button className="primary" disabled={busy} onClick={generate}>
          {busy ? "Génération…" : "Générer un brouillon"}
        </button>
      </div>
      {err && <div className="error">{err}</div>}

      {drafts.map((d) => (
        <DraftEditor key={d.id + d.updatedAt} draft={d} onSaved={() => { load(); onChanged(); }} />
      ))}
    </div>
  );
}

export function DraftEditor({ draft, onSaved }: { draft: Draft; onSaved: () => void }) {
  const [subject, setSubject] = useState(draft.subject);
  const body = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState("");

  const currentHtml = () => sanitizeHtml(body.current?.innerHTML ?? draft.bodyHtml);

  async function save(status?: "approved") {
    await window.api.drafts.update(draft.id, { subject, bodyHtml: currentHtml(), status });
    onSaved();
  }
  async function copy() {
    await navigator.clipboard.writeText(`${subject}\n\n${htmlToText(currentHtml())}`);
    setMsg("Copié");
    setTimeout(() => setMsg(""), 1500);
  }

  return (
    <article className={`draft ${draft.status}`}>
      <div className="meta muted small">
        <span>{draft.engine}</span>
        <span>confiance {Math.round(draft.confidence * 100)}%</span>
        <span>accroche : {draft.hookUsed || "—"}</span>
        <span className={`badge s-${draft.status}`}>{draft.status}</span>
      </div>
      <input className="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <div
        ref={body}
        className="body"
        contentEditable
        suppressContentEditableWarning
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(draft.bodyHtml) }}
      />
      <div className="row">
        <button onClick={() => save()}>Enregistrer</button>
        <button onClick={copy}>{msg || "Copier"}</button>
        <button className="primary" onClick={() => save("approved")}>
          Valider
        </button>
      </div>
    </article>
  );
}
