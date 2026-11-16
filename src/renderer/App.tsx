import { useEffect, useState } from "react";
import type { AppConfig } from "../shared/ipc";
import { Wizard } from "./Wizard";
import { Workspace } from "./Workspace";

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const reload = () => window.api.config.get().then(setCfg);
  useEffect(() => {
    reload();
  }, []);

  if (!cfg) return <div className="center muted">Chargement…</div>;
  if (!cfg.setupDone) return <Wizard onDone={reload} />;
  return <Workspace cfg={cfg} onCfg={setCfg} />;
}
