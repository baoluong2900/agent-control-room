import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    rollupOptions: {
      external: [
        "electron",
        "node:child_process",
        "node:crypto",
        "node:fs",
        "node:fs/promises",
        "node:os",
        "node:path",
        "node:process",
        "node:sqlite",
      ],
    },
  },
});
