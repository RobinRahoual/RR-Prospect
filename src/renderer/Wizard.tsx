import { FormEvent, useEffect, useRef, useState } from "react";
import type { SetupParams, SetupStep, StepResult } from "../shared/ipc";

const STEPS: { id: SetupStep; label: string; fatal: boolean }[] = [
  { id: "ollama", label: "Installer Ollama (IA locale)", fatal: true },
  { id: "model", label: "Télécharger le modèle de rédaction", fatal: true },
  { id: "gpu", label: "Activer l'accélération GPU", fatal: false },
  { id: "gemini", label: "Vérifier la clé Gemini (Pro, repli Flash)", fatal: true },
];

type State = { status: "idle" | "run" | "ok" | "warn" | "err"; text: string };
const ICON: Record<State["status"], string> = { idle: "○", run: "⏳", ok: "✓", warn: "⚠", err: "✗" };

export function Wizard({ onDone }: { onDone: () => void }) {
  const [model, setModel] = useState("mistral-nemo");
  const [geminiKey, setGeminiKey] = useState("");
  const [started, setStarted] = useState(false);
  const [states, setStates] = useState<Record<string, State>>({});
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const params = useRef<SetupParams>({});

  useEffect(() => {
    window.api.setup.onLog((l) => setLines((p) => [...p.slice(-200), l]));
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines]);

  const set = (id: string, s: State) => setStates((p) => ({ ...p, [id]: s }));

  async function run(from: number) {
    setFailedAt(null);
    for (let i = from; i < STEPS.length; i++) {
      const s = STEPS[i]!;
      set(s.id, { status: "run", text: "" });
      setLines((p) => [...p, `— ${s.label}`]);
      const r: StepResult = await window.api.setup.step(s.id, params.current);
      if (r.ok) {
        set(s.id, { status: r.warn ? "warn" : "ok", text: [r.detail, r.warn].filter(Boolean).join("\n") });
        continue;
      }
      set(s.id, { status: "err", text: [r.error, r.hint].filter(Boolean).join("\n") });
      if (s.fatal) {
        setFailedAt(i);
        return;
      }
    }
    await window.api.setup.finish();
    setTimeout(onDone, 1000);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    params.current = { model: model.trim() || "mistral-nemo", geminiKey: geminiKey.trim() };
    setStarted(true);
    run(0);
  }

  const skipGemini = async () => {
    await window.api.setup.finish();
    onDone();
  };

  return (
    <div className="center">
      <main className="wizard">
        <h1>RR Prospect</h1>
        <p className="muted">
          L'assistant installe l'IA locale sur ce PC (Ollama + modèle + GPU). La clé Gemini est facultative : elle sert de
          repli et pour l'iPad. Aucune commande à taper.
        </p>

        {!started && (
          <form onSubmit={submit} className="stack">
            <label>
              Modèle IA local
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="mistral-nemo" />
            </label>
            <label>
              Clé API Gemini <span className="muted">(facultatif — aistudio.google.com/apikey)</span>
              <input type="password" value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} />
            </label>
            <button className="primary">Tout installer</button>
            <p className="muted small">La clé est chiffrée sur ce PC (Windows DPAPI) et n'en sort jamais.</p>
          </form>
        )}

        {started && (
          <>
            <ol className="steps">
              {STEPS.map((s) => {
                const st = states[s.id] ?? { status: "idle" as const, text: "" };
                return (
                  <li key={s.id} className={st.status}>
                    <span className="ic">{ICON[st.status]}</span>
                    <div>
                      {s.label}
                      {st.text && <small>{st.text}</small>}
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="log" ref={logRef}>
              {lines.join("\n")}
            </div>
            {failedAt !== null && (
              <div className="row">
                <button className="primary" onClick={() => run(failedAt)}>
                  Réessayer
                </button>
                {STEPS[failedAt]!.id === "gemini" && <button onClick={skipGemini}>Continuer sans Gemini</button>}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
