import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// App web (iPad) : hébergée sur GitHub Pages, chemins relatifs
export default defineConfig({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
