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
