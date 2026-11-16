import { useEffect, useState } from "react";
import type { Job } from "../core/repo";
import { errMsg } from "./util";

const KIND: Record<string, string> = { scan: "Scan de la zone", analyze: "Analyse d'un site", send: "Envoi d'un mail", send_approved: "Envoi des brouillons validés" };
const STATUS: Record<string, string> = { pending: "En attente du PC", running: "En cours sur le PC", done: "Terminé", error: "Échec" };

/** iPad : ce qu'on a demandé au PC (scan, analyse, envoi) et où ça en est. */
export function JobsPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState("");
  const load = () => window.api.web!.jobs.list().then(setJobs);
  useEffect(() => {
    void load();
    window.api.sync.onDone(() => void load());
  }, []);

  async function ask(kind: "scan" | "send_approved", confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setErr("");
    try {
      await window.api.web!.jobs.enqueue(kind);
      await load();
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  return (
    <div className="stack">
      <h2>Commandes envoyées au PC</h2>
      <p className="muted small">
        Le scan, l'analyse de sites et l'envoi de mails se font sur le PC (le navigateur de l'iPad ne peut pas). Tu les demandes ici ou depuis le chat : le PC les exécute dès qu'il est allumé,
        avec les mêmes garde-fous (brouillon validé, plafond du jour, désinscrits). Une commande de plus de 12 h (envoi) ou 24 h est abandonnée.
      </p>
      <div className="row">
        <button onClick={() => ask("scan")}>Scanner la zone (sur le PC)</button>
        <button
          onClick={() => ask("send_approved", "Demander au PC d'envoyer tous les brouillons validés (dans la limite du plafond du jour) ?")}
        >
          Envoyer les brouillons validés (sur le PC)
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      {jobs.length === 0 ? (
        <div className="muted small">Aucune commande pour l'instant.</div>
      ) : (
        <ul className="reasons">
          {jobs.map((j) => (
            <li key={j.id}>
              <strong>{KIND[j.kind] ?? j.kind}</strong> — {STATUS[j.status] ?? j.status}{" "}
              <span className="muted small">({new Date(j.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })})</span>
              {j.result && <div className={j.status === "error" ? "error" : "muted small"}>{j.result}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
