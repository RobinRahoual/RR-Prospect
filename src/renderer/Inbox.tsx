import { useEffect, useState } from "react";
import type { InboundItem } from "../shared/ipc";
import { errMsg } from "./util";

const LABEL: Record<string, string> = { reply: "Réponse", stop: "STOP", bounce: "Adresse invalide" };

export function Inbox({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const [items, setItems] = useState<InboundItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const load = async () => setItems(await window.api.inbox.list());
  useEffect(() => {
    load();
  }, [reloadKey]);
  useEffect(() => {
    window.api.inbox.onNew(() => {
      load();
      onChanged();
    });
  }, []);

  async function check() {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await window.api.inbox.check();
      await window.api.track.refresh().catch(() => undefined);
      setMsg(`${r.checked} message(s) examiné(s) : ${r.replies} réponse(s), ${r.stops} STOP, ${r.bounces} adresse(s) invalide(s).`);
      await load();
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <h2>Réponses</h2>
      <p className="muted small">L'app lit ta boîte Gmail toutes les 15 minutes : une réponse passe le lead en « replied », un « STOP » ou un rebond le bloque automatiquement.</p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={check}>{busy ? "Lecture de la boîte…" : "Vérifier maintenant"}</button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      {err && <div className="error">{err}</div>}
      {items.length === 0 && <div className="muted">Aucune réponse pour l'instant.</div>}
      {items.map((i, k) => (
        <article key={k} className="draft">
          <div className="meta small">
            <strong>{i.leadName}</strong>
            <span className={`badge ${i.kind === "reply" ? "s-approved" : ""}`}>{LABEL[i.kind] ?? i.kind}</span>
            <span className="muted">{i.date.slice(0, 10)}</span>
          </div>
          <div className="subject">{i.subject}</div>
          {i.snippet && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{i.snippet}</div>}
        </article>
      ))}
    </div>
  );
}
