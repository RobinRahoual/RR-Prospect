import { useEffect, useState } from "react";
import type { MailState } from "../shared/ipc";
import { SCAN_CATEGORIES, type ScanSettings } from "../core/scan/settings";
import type { ScanReport } from "../core/scan/osm";
import { errMsg } from "./util";

function MailSection() {
  const [m, setM] = useState<MailState | null>(null);
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [running, setRunning] = useState(false);
  const load = async () => setM(await window.api.mail.get());
  useEffect(() => {
    load();
    window.api.mail.onProgress((p) =>
      setProg(p.waitSec ? `Pause ${p.waitSec} s avant le prochain (${p.index}/${p.total})` : `${p.index}/${p.total} — ${p.lead} : ${p.result?.ok ? "envoyé" : p.result?.error}`)
    );
  }, []);
  if (!m) return null;

  async function batch() {
    if (!window.confirm("Envoyer tous les brouillons validés, un par un avec une pause de 1,5 à 4 minutes entre chaque ? Garde l'app ouverte.")) return;
    setRunning(true);
    setErr("");
    setProg("Démarrage…");
    try {
      const r = await window.api.mail.sendApproved();
      setMsg(`Terminé : ${r.sent} envoyé(s), ${r.failed} échec(s)${r.stopped ? " — arrêté." : "."}`);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setRunning(false);
      setProg("");
      load();
    }
  }
  const set = (p: Partial<MailState["settings"]>) => setM({ ...m, settings: { ...m.settings, ...p } });

  async function save() {
    setErr("");
    setMsg("");
    try {
      setM(await window.api.mail.set(m!.settings, pass));
      setPass("");
      setMsg("Enregistré.");
      return true;
    } catch (e) {
      setErr(errMsg(e));
      return false;
    }
  }
  async function test() {
    setBusy(true);
    if (await save()) {
      const r = await window.api.mail.test();
      if (r.ok) setMsg(`Message de test envoyé à ${r.to}. Regarde ta boîte de réception.`);
      else setErr(r.error);
    }
    setBusy(false);
  }

  return (
    <div className="stack">
      <h2>Envoi par Gmail</h2>
      <p className="muted small">
        Les mails partent de ton adresse Gmail et apparaissent dans « Envoyés ». Il faut un <strong>mot de passe d'application</strong> (la validation en 2 étapes doit être activée sur ton compte Google) :{" "}
        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">créer un mot de passe d'application</a>.
      </p>
      <label>
        Adresse Gmail
        <input value={m.settings.address} onChange={(e) => set({ address: e.target.value })} placeholder="toi@gmail.com" />
      </label>
      <label>
        Mot de passe d'application {m.hasPassword && <span className="muted small">(enregistré — laisse vide pour le garder)</span>}
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
      </label>
      <label>
        Nom affiché
        <input value={m.settings.fromName} onChange={(e) => set({ fromName: e.target.value })} />
      </label>
      <label>
        Signature (ajoutée à chaque mail, avec la mention « STOP » de désinscription)
        <textarea rows={3} value={m.settings.signature} onChange={(e) => set({ signature: e.target.value })} />
      </label>
      <label>
        Plafond d'envois par jour : {m.settings.dailyCap}
        <input type="range" min={1} max={40} value={m.settings.dailyCap} onChange={(e) => set({ dailyCap: Number(e.target.value) })} />
        <span className="muted small">Aujourd'hui : {m.sentToday} / {m.cap}. Reste prudent : au-delà de ~30/jour, Gmail peut limiter ton compte.</span>
      </label>
      <div className="row">
        <button onClick={save}>Enregistrer</button>
        <button disabled={busy} onClick={test}>{busy ? "Envoi…" : "Envoyer un mail de test à moi-même"}</button>
      </div>
      <div className="row">
        <button className="primary" disabled={running || !m.configured} onClick={batch}>
          Envoyer tous les brouillons validés
        </button>
        {running && <button onClick={() => window.api.mail.cancel()}>Arrêter</button>}
      </div>
      {prog && <div className="muted small">{prog}</div>}
      {msg && <div className="muted small">{msg}</div>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

export function Settings({ onScanned }: { onScanned: () => void }) {
  const [s, setS] = useState<ScanSettings | null>(null);
  const [place, setPlace] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [oaKey, setOaKey] = useState("");
  const [uidText, setUidText] = useState("");
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    window.api.scan.getSettings().then((v) => {
      setS(v);
      setPlace(v.placeLabel);
      setUidText(v.agendaUids.join(", "));
    });
    window.api.scan.hasOaKey().then(setHasKey);
    window.api.scan.onLog((l) => setLog((x) => [...x.slice(-20), l]));
  }, []);

  if (!s) return <div className="center muted">Chargement…</div>;
  const set = (p: Partial<ScanSettings>) => setS({ ...s, ...p });

  async function locate() {
    setErr("");
    setMsg("");
    try {
      const g = await window.api.scan.geocode(place);
      set({ placeLabel: g.label, lat: g.lat, lon: g.lon });
      setPlace(g.label);
      setMsg("Lieu trouvé — pense à enregistrer.");
    } catch (e) {
      setErr(errMsg(e));
    }
  }
  async function save(): Promise<boolean> {
    setErr("");
    try {
      if (oaKey.trim()) {
        await window.api.scan.setOaKey(oaKey);
        setOaKey("");
        setHasKey(true);
      }
      setS(await window.api.scan.setSettings(s!));
      setMsg("Réglages enregistrés.");
      return true;
    } catch (e) {
      setErr(errMsg(e));
      return false;
    }
  }
  async function run() {
    if (!(await save())) return;
    setBusy(true);
    setLog([]);
    setReport(null);
    try {
      setReport(await window.api.scan.run());
      onScanned();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (id: string) =>
    set({ categories: s.categories.includes(id) ? s.categories.filter((c) => c !== id) : [...s.categories, id] });

  return (
    <div className="settings">
      <h2>Scan de leads</h2>
      <p className="muted small">100 % gratuit : OpenStreetMap, sans clé ni carte bancaire. Tu règles la zone, le rayon et les catégories.</p>

      <label>
        Zone de départ
        <div className="row">
          <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Ville ou adresse" onKeyDown={(e) => e.key === "Enter" && locate()} />
          <button onClick={locate}>Localiser</button>
        </div>
        <span className="muted small">
          {s.placeLabel} · {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
        </span>
      </label>

      <label>
        Rayon : {s.radiusKm} km
        <input type="range" min={1} max={50} value={s.radiusKm} onChange={(e) => set({ radiusKm: Number(e.target.value) })} />
      </label>

      <fieldset className="cats">
        <legend>Catégories</legend>
        {SCAN_CATEGORIES.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={s.categories.includes(c.id)} onChange={() => toggle(c.id)} />
            {c.label}
          </label>
        ))}
      </fieldset>

      <fieldset className="cats">
        <legend>Sources (toutes gratuites)</legend>
        <label className="check">
          <input type="checkbox" checked={s.sources.osm} onChange={(e) => set({ sources: { ...s.sources, osm: e.target.checked } })} />
          OpenStreetMap — commerces existants (site, téléphone, email quand ils sont renseignés)
        </label>
        <label className="check">
          <input type="checkbox" checked={s.sources.sirene} onChange={(e) => set({ sources: { ...s.sources, sirene: e.target.checked } })} />
          SIRENE — entreprises créées récemment (pas encore de présence visuelle)
        </label>
        {s.sources.sirene && (
          <label>
            Créées depuis moins de {s.sireneMonths} mois
            <input type="range" min={1} max={60} value={s.sireneMonths} onChange={(e) => set({ sireneMonths: Number(e.target.value) })} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={s.sources.openagenda} onChange={(e) => set({ sources: { ...s.sources, openagenda: e.target.checked } })} />
          OpenAgenda — événements à venir (clé gratuite + identifiants d'agenda)
        </label>
        {s.sources.openagenda && (
          <>
            <label>
              Clé API OpenAgenda {hasKey && <span className="muted small">(enregistrée — laisse vide pour la garder)</span>}
              <input type="password" value={oaKey} onChange={(e) => setOaKey(e.target.value)} placeholder="Clé de lecture openagenda.com" />
            </label>
            <label>
              UID des agendas (un par ligne ou séparés par des virgules)
              <textarea rows={2} value={uidText} onChange={(e) => { setUidText(e.target.value); set({ agendaUids: e.target.value.split(/[\s,;]+/).filter(Boolean) }); }} />
              <span className="muted small">Le numéro dans l'adresse d'un agenda : openagenda.com/…/agendas/<b>12345678</b></span>
            </label>
          </>
        )}
      </fieldset>

      <label>
        Maximum de leads ajoutés par scan
        <input type="number" min={1} max={500} value={s.maxResults} onChange={(e) => set({ maxResults: Number(e.target.value) })} />
        <span className="muted small">Les plus prometteurs (score de lacune élevé) sont ajoutés en premier.</span>
      </label>

      <div className="row">
        <button onClick={save}>Enregistrer</button>
        <button className="primary" disabled={busy} onClick={run}>
          {busy ? "Scan en cours…" : "Lancer le scan"}
        </button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      {err && <div className="error">{err}</div>}
      {busy && log.length > 0 && <pre className="log">{log.join("\n")}</pre>}
      {report && (
        <div className="muted">
          {report.source} : {report.found} résultats · <strong>{report.added} ajoutés</strong> · {report.duplicates} déjà présents. Le score est une estimation : utilise « Analyser le site » avant d'écrire.
          {report.errors?.map((e) => (
            <div key={e} className="error">{e}</div>
          ))}
        </div>
      )}
      <hr className="sep" />
      <MailSection />
    </div>
  );
}
