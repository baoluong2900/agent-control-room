import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

const removedStarterFiles = [
  "next.config.ts",
  "vite.config.ts",
  "worker/index.ts",
  "db/index.ts",
  "drizzle.config.ts",
  "examples/d1/db/schema.ts",
  "app/page.tsx",
  "app/layout.tsx",
  "app/chatgpt-auth.ts",
];

test("unused starter runtime files stay removed", async () => {
  for (const file of removedStarterFiles) {
    await assert.rejects(access(new URL(file, root)), undefined, `${file} should not exist`);
  }
});

test("web and ORM runtime dependencies stay out of package.json", async () => {
  const packageJson = await readFile(new URL("package.json", root), "utf8");

  assert.doesNotMatch(packageJson, /"next"|"vinext"|"drizzle-orm"|"wrangler"/);
});

test("packaged renderer output matches the Electron load path", async () => {
  const [forgeConfig, rendererConfig, windowLoader] = await Promise.all([
    readFile(new URL("forge.config.ts", root), "utf8"),
    readFile(new URL("vite.renderer.config.ts", root), "utf8"),
    readFile(new URL("src/main/windows/main-window.ts", root), "utf8"),
  ]);

  assert.match(forgeConfig, /name:\s*"main_window"/);
  assert.match(rendererConfig, /\.vite\/renderer\/main_window/);
  assert.match(rendererConfig, /outDir:\s*rendererOutDir/);
  assert.match(windowLoader, /\.\.\/renderer\/\$\{MAIN_WINDOW_VITE_NAME\}\/index\.html/);
});

test("renderer startup failures render a visible boot error instead of a blank page", async () => {
  const [appSource, styles] = await Promise.all([
    readFile(new URL("src/renderer/App.tsx", root), "utf8"),
    readFile(new URL("src/renderer/styles.css", root), "utf8"),
  ]);

  assert.match(appSource, /BootErrorScreen/);
  assert.match(appSource, /Electron preload bridge is not available/);
  assert.match(appSource, /unhandledrejection/);
  assert.match(styles, /\.boot-error-screen/);
  assert.match(styles, /\.boot-error-panel/);
});
