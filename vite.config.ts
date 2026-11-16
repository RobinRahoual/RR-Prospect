import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Le renderer est chargé en file:// par Electron → chemins relatifs
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
