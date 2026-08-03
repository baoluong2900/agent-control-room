import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));
const desktopSrc = fileURLToPath(new URL("./src", import.meta.url));
const contractsSrc = fileURLToPath(new URL("./src/contracts", import.meta.url));
const sharedPublicDir = fileURLToPath(new URL("./public", import.meta.url));
const rendererOutDir = fileURLToPath(new URL("./.vite/renderer/main_window", import.meta.url));

export default defineConfig({
  root: rendererRoot,
  base: "./",
  publicDir: sharedPublicDir,
  build: {
    emptyOutDir: true,
    outDir: rendererOutDir,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@desktop": desktopSrc,
      "@contracts": contractsSrc,
    },
  },
});
