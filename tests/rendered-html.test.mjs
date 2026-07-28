import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the AgenticOS workspace dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>AgenticOS — AI Agent Workspace<\/title>/i);
  assert.match(html, /AI Agent Workspace/);
  assert.match(html, /Coordinate your agents\. Ship better software\./);
  assert.match(html, /All Systems Operational/);
  assert.match(html, /PLANNING/);
  assert.match(html, /WORKFLOW ENGINE/);
  assert.match(html, /TESTING/);
  assert.match(html, /DEPLOYMENT/);
  assert.match(html, /System Overview/);
  assert.match(html, /Task Throughput/);
  assert.match(html, /Model Usage/);
  assert.match(html, /Workflow Activity/);
  assert.match(html, /Select Model for New Agent/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|Building your site/i);
});

test("finished site removes disposable preview and keeps responsive product styles", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /className="workspace-scene"/);
  assert.match(page, /aria-label="AI agent operation map"/);
  assert.match(page, /useState/);
  assert.match(layout, /AgenticOS — AI Agent Workspace/);
  assert.match(css, /@media \(max-width: 800px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.sidebar-backdrop/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("public/_sites-preview", templateRoot)));
});
