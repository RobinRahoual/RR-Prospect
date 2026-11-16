import { KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Card, ChatMessage } from "../core/chat/types";
import type { Conversation } from "../core/repo";
import type { Draft, Mode } from "../core/types";
import type { AppConfig } from "../shared/ipc";
import { mdToHtml } from "./md";
import { DraftEditor } from "./Workspace";
import { errMsg } from "./util";

const MODES: { id: Mode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "local", label: "Local" },
  { id: "cloud", label: "Cloud" },
];

const SUGGESTIONS = [
  "Fais-moi le point sur mes leads",
  "Qui contacter en priorité cette semaine ?",
  "Ajoute le bar « Le Zinc » à Dijon, Instagram inactif depuis 6 mois",
  "Écris un mail pour le lead au meilleur score, ton direct",
];

const TOOL_LABEL: Record<string, string> = {
  get_overview: "Lecture du pipeline",
  search_leads: "Recherche de leads",
  get_lead: "Lecture d'un lead",
  create_lead: "Création d'un lead",
  generate_draft: "Rédaction d'un brouillon",
  list_drafts: "Lecture des brouillons",
  set_lead_status: "Changement de statut",
};

export function Chat({ cfg, onCfg }: { cfg: AppConfig; onCfg: (c: AppConfig) => void }) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const curRef = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  curRef.current = cur;

  const loadConvs = async () => setConvs(await window.api.chat.list());

  useEffect(() => {
    loadConvs();
    window.api.chat.onMessage((m) => {
      if (m.conversationId === curRef.current) setMsgs((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]));
    });
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs, busy]);

  async function open(id: string) {
    setCur(id);
    setErr("");
    setMsgs(await window.api.chat.messages(id));
  }
  async function remove(id: string) {
    await window.api.chat.remove(id);
    if (cur === id) {
      setCur(null);
      setMsgs([]);
    }
    loadConvs();
  }
  async function send(t = text) {
    const content = t.trim();
    if (!content || busy) return;
    setErr("");
    setText("");
    setBusy(true);
    try {
      let id = cur;
      if (!id) {
        id = (await window.api.chat.create()).id;
        curRef.current = id;
        setCur(id);
        setMsgs([]);
      }
      await window.api.chat.send(id, content);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      loadConvs();
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  async function setMode(mode: Mode) {
    await window.api.config.setMode(mode);
    onCfg(await window.api.config.get());
  }

  return (
    <div className="chat">
      <aside className="convs">
        <header>
          <h2>Chats</h2>
          <button
            className="primary small"
            onClick={() => {
              setCur(null);
              setMsgs([]);
              setErr("");
            }}
          >
            + Nouveau
          </button>
        </header>
        <ul className="leads">
          {convs.map((c) => (
            <li key={c.id} className={c.id === cur ? "active" : ""} onClick={() => open(c.id)}>
              <span className="conv-row">
                <span className="conv-title">{c.title}</span>
                <button className="ghost" title="Supprimer" onClick={(e) => (e.stopPropagation(), remove(c.id))}>
                  ×
                </button>
              </span>
            </li>
          ))}
          {convs.length === 0 && <li className="muted pad">Aucune conversation.</li>}
        </ul>
      </aside>

      <div className="chat-main">
        <div className="chat-top">
          <span className="muted small">Moteur</span>
          <div className="seg">
            {MODES.map((m) => (
              <button key={m.id} className={cfg.mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="chat-scroll">
          {msgs.length === 0 && !busy && (
            <div className="empty">
              <h2>Que veux-tu prospecter ?</h2>
              <p className="muted">Je connais ton profil, tes leads et tes brouillons validés. Rien n'est envoyé sans ton accord.</p>
              <div className="sugg">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <Bubble key={m.id ?? i} m={m} />
          ))}
          {busy && <div className="typing muted">RR Prospect réfléchit…</div>}
          {err && <div className="error">{err}</div>}
          <div ref={end} />
        </div>

        <div className="composer">
          <textarea
            rows={2}
            value={text}
            placeholder="Écris ton message… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <button className="primary" disabled={busy || !text.trim()} onClick={() => send()}>
            Envoyer
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === "tool") {
    return (
      <div className="tool-row">
        <span className="chip">✓ {TOOL_LABEL[m.toolName ?? ""] ?? m.toolName}</span>
        {m.cards?.map((c, i) => (
          <CardView key={i} card={c} />
        ))}
      </div>
    );
  }
  if (m.role === "assistant" && !m.content.trim()) return null; // simple appel d'outil : les puces d'outils suffisent
  return (
    <div className={`bubble ${m.role}`}>
      {m.role === "user" ? <div className="bubble-text">{m.content}</div> : <div className="bubble-text md" dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />}
      {m.engine && m.role === "assistant" && <div className="muted small">{m.engine}</div>}
    </div>
  );
}

function CardView({ card }: { card: Card }) {
  if (card.type === "leads") {
    return (
      <div className="card-leads">
        {card.leads.map((l) => (
          <div key={l.id} className="mini">
            <strong>{l.name}</strong>
            <span className="muted small">{[l.category, l.city].filter(Boolean).join(" · ") || "—"}</span>
            <span className="badges">
              {l.gapScore != null && <em className="badge">{l.gapScore}</em>}
              <em className={`badge s-${l.status}`}>{l.status}</em>
            </span>
          </div>
        ))}
      </div>
    );
  }
  return <DraftCard card={card} />;
}

function DraftCard({ card }: { card: Extract<Card, { type: "draft" }> }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const load = async () => setDraft((await window.api.drafts.list(card.leadId)).find((d) => d.id === card.draftId) ?? null);
  useEffect(() => {
    load();
  }, [card.draftId]);
  return (
    <div className="draft-card">
      <div className="muted small">Brouillon pour {card.leadName}</div>
      {draft ? <DraftEditor draft={draft} onSaved={load} /> : <div className="muted small">Brouillon introuvable.</div>}
    </div>
  );
}
