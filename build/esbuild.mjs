// Bundle main + preload en un fichier chacun (toutes les dépendances embarquées, seul "electron" reste externe)
import { build } from "esbuild";
import fs from "node:fs";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js" });
await build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.js" });

// sql.js charge son module WASM à côté du bundle
fs.copyFileSync("node_modules/sql.js/dist/sql-wasm.wasm", "dist/main/sql-wasm.wasm");
