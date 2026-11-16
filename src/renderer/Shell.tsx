import { useState } from "react";
import type { AppConfig } from "../shared/ipc";
import { Chat } from "./Chat";
import { Workspace } from "./Workspace";

export function Shell({ cfg, onCfg }: { cfg: AppConfig; onCfg: (c: AppConfig) => void }) {
  const [tab, setTab] = useState<"chat" | "leads">("chat");
  return (
    <div className="shell">
      <nav className="topnav">
        <strong>RR Prospect</strong>
        <div className="seg">
          <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
            Chat
          </button>
          <button className={tab === "leads" ? "on" : ""} onClick={() => setTab("leads")}>
            Leads
          </button>
        </div>
      </nav>
      <div className="shell-body">
        {/* Les deux vues restent montées : on garde la conversation en cours quand on change d'onglet */}
        <div hidden={tab !== "chat"} className="fill">
          <Chat cfg={cfg} onCfg={onCfg} />
        </div>
        <div hidden={tab !== "leads"} className="fill">
          <Workspace cfg={cfg} onCfg={onCfg} />
        </div>
      </div>
    </div>
  );
}
