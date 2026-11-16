import { useState } from "react";
import type { AppConfig } from "../shared/ipc";
import { Chat } from "./Chat";
import { Settings } from "./Settings";
import { Workspace } from "./Workspace";

export function Shell({ cfg, onCfg }: { cfg: AppConfig; onCfg: (c: AppConfig) => void }) {
  const [tab, setTab] = useState<"chat" | "leads" | "settings">("chat");
  const [reload, setReload] = useState(0);
  const go = (t: "chat" | "leads" | "settings") => {
    setTab(t);
    if (t === "leads") setReload((n) => n + 1);
  };
  return (
    <div className="shell">
      <nav className="topnav">
        <strong>RR Prospect</strong>
        <div className="seg">
          <button className={tab === "chat" ? "on" : ""} onClick={() => go("chat")}>
            Chat
          </button>
          <button className={tab === "leads" ? "on" : ""} onClick={() => go("leads")}>
            Leads
          </button>
          <button className={tab === "settings" ? "on" : ""} onClick={() => go("settings")}>
            Réglages
          </button>
        </div>
      </nav>
      <div className="shell-body">
        {/* Les deux vues restent montées : on garde la conversation en cours quand on change d'onglet */}
        <div hidden={tab !== "chat"} className="fill">
          <Chat cfg={cfg} onCfg={onCfg} />
        </div>
        <div hidden={tab !== "leads"} className="fill">
          <Workspace cfg={cfg} onCfg={onCfg} reloadKey={reload} />
        </div>
        <div hidden={tab !== "settings"} className="fill scroll">
          <Settings onScanned={() => setReload((n) => n + 1)} />
        </div>
      </div>
    </div>
  );
}
