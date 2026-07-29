import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    ".verify/**",
    ".vite/**",
    "out/**",
    "coverage/**",
    "tsconfig.tsbuildinfo",
  ]),
]);
