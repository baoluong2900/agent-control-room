import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Source-level guards for provider connection honesty.
 *
 * These assert on the renderer's text rather than its behaviour because the bug
 * they pin is a *claim*, not a computation: `SettingsModule` used to pass
 * `status: "connected"` into `saveProviderConnection`, which overrode the
 * database's `unverified` default and made a card read "connected" before anything
 * had been checked. The backend tests cover the default; nothing covered the
 * renderer overriding it, which is exactly how the regression survived.
 */

const ROOT = process.cwd();

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

test("the renderer never claims a provider is connected", async () => {
  const source = await read("src/renderer/settings/SettingsModule.tsx");

  // `saveProviderConnection` must not be handed a status at all: the database
  // defaults new rows to `unverified`, and verification is the only path forward.
  assert.equal(
    /status:\s*["'`]connected["'`]/.test(source),
    false,
    "SettingsModule hardcodes status: 'connected' again — saving a credential is not evidence it works",
  );
});

test("connect and reconnect both verify before reporting a result", async () => {
  const source = await read("src/renderer/settings/SettingsModule.tsx");

  const connectBody = source.slice(
    source.indexOf("async function connectProvider"),
    source.indexOf("async function reconnectProvider"),
  );
  const reconnectBody = source.slice(
    source.indexOf("async function reconnectProvider"),
    source.indexOf("async function disconnectProvider"),
  );

  assert.ok(connectBody.length > 0 && reconnectBody.length > 0, "both handlers still exist");
  // One-click flow is preserved by verifying immediately rather than by asserting
  // success: the user sees `disconnected — CLI missing` instead of a false green.
  assert.match(connectBody, /verifyProviderConnection/, "Connect must verify before showing a status");
  assert.match(reconnectBody, /verifyProviderConnection/, "Reconnect must verify before showing a status");
});

test("no surface still calls the credential page an OAuth flow", async () => {
  // The app opens the provider's website and the user pastes a credential back.
  // There is no callback listener, no device-code exchange, and no refresh, so a
  // name like `openProviderAuth` promised a flow that does not exist.
  for (const file of [
    "src/contracts/ipc.ts",
    "src/preload/preload.ts",
    "src/main/ipc/register-ipc.ts",
    "src/main/settings/settings-service.ts",
    "src/renderer/settings/SettingsModule.tsx",
  ]) {
    const source = await read(file);
    assert.equal(
      /openProviderAuth\s*[(:]/.test(source),
      false,
      `${file} still exposes openProviderAuth; use openProviderSite`,
    );
  }
});

test("the IPC channel name matches the renamed API on both sides", async () => {
  const preload = await read("src/preload/preload.ts");
  const register = await read("src/main/ipc/register-ipc.ts");

  // A mismatch here typechecks cleanly and fails only at runtime, which is the
  // failure mode the repo's four-place rule exists to prevent.
  assert.match(preload, /invoke\("settings:open-provider-site"/);
  assert.match(register, /handle\("settings:open-provider-site"/);
  assert.equal(/settings:open-provider-auth/.test(preload + register), false, "the old channel is gone");
});
