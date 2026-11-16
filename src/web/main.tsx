import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../renderer/App";
import "../renderer/styles.css";
import { createWebApi } from "./api";

const root = createRoot(document.getElementById("root")!);
root.render(<div className="center muted">Chargement…</div>);
createWebApi()
  .then((api) => {
    window.api = api;
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  })
  .catch((e) => root.render(<div className="center error">Impossible de démarrer : {String(e?.message ?? e)}</div>));
