import { useEffect, useState } from "react";
import type { UpdateState } from "../shared/ipc";
import type { AppConfig } from "../shared/ipc";
import { Chat } from "./Chat";
import { Inbox } from "./Inbox";
import { Settings } from "./Settings";
import { Workspace } from "./Workspace";

export function Shell({ cfg, onCfg }: { cfg: AppConfig; onCfg: (c: AppConfig) => void }) {
  const [tab, setTab] = useState<"chat" | "leads" | "inbox" | "settings">("chat");
  const [reload, setReload] = useState(0);
  const [upd, setUpd] = useState<UpdateState | null>(null);
  useEffect(() => {
    window.api.update.state().then(setUpd);
    window.api.update.onState(setUpd);
  }, []);
  const go = (t: "chat" | "leads" | "inbox" | "settings") => {
    setTab(t);
    if (t === "leads" || t === "inbox") setReload((n) => n + 1);
  };
  return (
    <div className="shell">
      <nav className="topnav">
        <span>
          <strong>RR Prospect</strong> <span className="muted small">v{upd?.version ?? ""}</span>
        </span>
        <div className="seg">
          <button className={tab === "chat" ? "on" : ""} onClick={() => go("chat")}>
            Chat
          </button>
          <button className={tab === "leads" ? "on" : ""} onClick={() => go("leads")}>
            Leads
          </button>
          <button className={tab === "inbox" ? "on" : ""} onClick={() => go("inbox")}>
            Réponses
          </button>
          <button className={tab === "settings" ? "on" : ""} onClick={() => go("settings")}>
            Réglages
          </button>
        </div>
      </nav>
      {upd?.state === "downloading" && <div className="banner">Mise à jour en cours de téléchargement… {upd.percent}%</div>}
      {upd?.state === "ready" && (
        <div className="banner">
          Version {upd.next} prête.
          <button className="primary small" onClick={() => window.api.update.install()}>
            Redémarrer et mettre à jour
          </button>
          <span className="muted small">(sinon, installée à la fermeture)</span>
        </div>
      )}
      <div className="shell-body">
        {/* Les deux vues restent montées : on garde la conversation en cours quand on change d'onglet */}
        <div hidden={tab !== "chat"} className="fill">
          <Chat cfg={cfg} onCfg={onCfg} />
        </div>
        <div hidden={tab !== "leads"} className="fill">
          <Workspace cfg={cfg} onCfg={onCfg} reloadKey={reload} />
        </div>
        <div hidden={tab !== "inbox"} className="fill scroll">
          <Inbox reloadKey={reload} onChanged={() => setReload((n) => n + 1)} />
        </div>
        <div hidden={tab !== "settings"} className="fill scroll">
          <Settings onScanned={() => setReload((n) => n + 1)} />
        </div>
      </div>
    </div>
  );
}
