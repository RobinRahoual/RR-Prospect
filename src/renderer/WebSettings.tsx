import { useEffect, useState } from "react";
import { SyncSection } from "./Settings";
import { errMsg } from "./util";

export function WebSettings() {
  const [has, setHas] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    window.api.web!.getKeys().then((k) => {
      setHas(k.hasGemini);
      setModel(k.geminiModel);
    });
  }, []);

  async function save() {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const r = await window.api.web!.setGeminiKey(key);
      setHas(true);
      setModel(r.geminiModel);
      setKey("");
      setMsg(r.warn ?? "Clé enregistrée sur cet appareil.");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <h2>Réglages (iPad)</h2>
      <div className="stack">
        <h2>IA : Gemini</h2>
        <p className="muted small">
          Sur iPad, l'IA passe par ton compte Gemini (jamais par ton PC). La clé reste sur cet appareil. Crée-la sur{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>.
        </p>
        {has && <div className="muted small">Clé enregistrée — modèle : {model}</div>}
        <label>
          {has ? "Remplacer la clé" : "Clé API Gemini"}
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" disabled={busy || !key.trim()} onClick={save}>{busy ? "Vérification…" : "Enregistrer"}</button>
        </div>
        {msg && <div className="muted small">{msg}</div>}
        {err && <div className="error">{err}</div>}
      </div>
      <hr className="sep" />
      <SyncSection web />
      <hr className="sep" />
      <div className="row">
        <button onClick={() => window.confirm("Effacer la clé Gemini et la connexion de cet appareil ?") && window.api.web!.signOut()}>
          Effacer les réglages de cet appareil
        </button>
      </div>
    </div>
  );
}
