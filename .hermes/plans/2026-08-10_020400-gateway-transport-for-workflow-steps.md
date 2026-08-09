# Gateway Transport for Workflow Steps — Implementation Plan

> **For Hermes:** implement task-by-task, TDD, commit after each task. Every `file:line`
> below was verified against source on 2026-08-10 at commit `442852a`, not copied from
> an older doc.

**Goal:** Let a workflow step send its instruction to an OpenAI-compatible gateway over
HTTP instead of spawning a CLI, with cancellation and step logs behaving the same as the
CLI path.

**Architecture:** `GatewayChatService` (landed in phase 3) already does streaming +
cancel + credential handling. This plan does *not* re-implement any of that. It adds one
discriminator to `WorkflowStepDefinition` (`transport: "cli" | "gateway"`), routes
`runStep` on it, and teaches `WorkflowService.cancel()` to abort a gateway request — it
currently only knows how to kill a child process.

**Tech Stack:** Electron main + React renderer + TypeScript, `node:sqlite`, `node:test`.

---

## Current context (verified, not assumed)

| Fact | Evidence |
| --- | --- |
| Every step spawns a process | `src/main/workflows/workflow-service.ts:691` — `spawn(invocation.executable, …)`, reached only from `spawnStep()` |
| `runStep` has exactly two branches today | `workflow-service.ts:574-590` — `if (dryRun) … else spawnStep(…)` |
| Cancel only kills a child | `workflow-service.ts:172-176` — `running.child?.kill(…)`; a gateway request has no `child`, so cancel would silently no-op |
| Step status comes from process exit | `workflow-service.ts:744-754` — `child.on("exit")` maps `code === 0` to success |
| Chat service is ready to reuse | `src/main/gateway/gateway-chat-service.ts` — `sendChat()`, `cancel(requestId)`, `listTargets()`, 40 tests green |
| Step columns are add-only | `workflow-repository.ts:244-267` insert, `:587-603` hydrate; migration 4 (`migrations.ts:66-76`) is the precedent for adding step columns with `scope: "workflow"` |
| Latest migration version is 8 | `migrations.ts:139` — so the new one is **version 9** |
| Builder step fields live in one drawer | `src/renderer/workflows/WorkflowEditorDrawer.tsx:459-469` (CLI select), `:496-505` (conditional shell field) |
| CSS vocabulary to reuse | `wf-field`, `wf-col-2`, `wf-toggle-row` — confirmed in `workflows.css`; **do not invent class names**, unstyled markup still typechecks and builds |

### Assumptions worth stating

- `WorkflowService` does not currently receive `GatewayChatService`. It is constructed in
  `src/main/main.ts:68` with `(database, activeWebContents, providerSecretVault)`, and
  `gatewayChatService` is created later at `main.ts:89`. **Ordering must be swapped** so
  the chat service exists before the workflow service.
- A new constructor dependency must be **optional and trailing**. `WorkflowService` is
  constructed in tests and harnesses; an optional 4th param degrades gracefully instead
  of forcing every site to change. Verify the count with `npm run typecheck`, not grep.

### Open questions (do not guess — ask before Task 7)

1. **Should a gateway step be allowed to run without a `providerConnectionId`?** Falling
   back to "first available gateway" is convenient but means a workflow silently changes
   which vendor sees the data when connections are added. Recommendation: require an
   explicit connection for a gateway step and fail the step with a clear message
   otherwise. This is the one real product decision in this plan.
2. **Retention of streamed text.** A long completion streamed token-by-token would emit
   hundreds of `workflow:log` events. Recommendation: coalesce to a ~250ms flush
   (mirrors `agent-output-coalescing.test.ts`) rather than one event per delta.

---

## Task 1: Add the `transport` discriminator to the contract

**Objective:** Name the choice in the type system before any code branches on it.

**Files:**
- Modify: `src/contracts/workflow.ts` (add to `WorkflowStepDefinition`, near `cliId` at `:47`)

**Step 1: Add the field**

```ts
/**
 * How this step reaches a model.
 *
 * `cli` spawns the local agent binary — the original and still the default, so an
 * existing workflow row with no value behaves exactly as before. `gateway` sends the
 * instruction to an OpenAI-compatible endpoint over HTTP instead, which is the only
 * way to run a step on a machine where the vendor CLI is not installed.
 */
transport?: "cli" | "gateway";
```

**Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: exit 0 (the field is optional, so nothing else breaks yet).

**Step 3: Commit**

```bash
git add src/contracts/workflow.ts
git commit -m "Name the step transport choice in the contract"
```

---

## Task 2: Persist `transport` (migration 9)

**Objective:** Store the field without touching a released migration.

**Files:**
- Modify: `src/main/database/migrations.ts` (append after the version-8 block ending `:158`)
- Modify: `src/main/database/workflow-repository.ts:244-267` (insert), `:587-603` (hydrate)
- Test: `tests/database-migrations.test.ts`

**Step 1: Write the failing test**

```ts
test("migration 9 adds the step transport column and defaults to cli", () => {
  const db = freshWorkflowDb(); // existing helper in this file
  const columns = db.prepare("pragma table_info(workflow_steps)").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "transport"));
});
```

**Step 2: Run it and watch it fail**

Run: `node --no-warnings --experimental-sqlite --import ./tests/support/register.mjs --test tests/database-migrations.test.ts`
Expected: FAIL — no `transport` column.

**Step 3: Append the migration**

```ts
  {
    version: 9,
    name: "workflow-step-transport",
    // Scoped like migration 4: a workflow-only in-memory test DB has no
    // provider_connections or tasks table, so an unscoped migration would trip on
    // tables it never creates.
    scope: "workflow",
    up: (db) => {
      ensureColumns(db, "workflow_steps", [
        // No `not null default`: an existing row must read as "unset" and be treated
        // as `cli` by the hydrator, which keeps every saved workflow behaving as it
        // does today without a data backfill.
        { name: "transport", ddl: "text" },
      ]);
    },
  },
```

**Step 4: Wire insert and hydrate**

In `insertStep` add `transport` to the column list and `step.transport ?? null` to the
values, keeping positional order aligned. In `hydrate`:

```ts
      // Absent means a row written before this column existed. Defaulting to "cli"
      // here rather than in the DDL is what makes the upgrade a no-op for saved rows.
      transport: step.transport === "gateway" ? "gateway" : "cli",
```

Add `transport: string | null` to the `StepRow` type in the same file.

**Step 5: Verify and commit**

Run: `node … --test tests/database-migrations.test.ts tests/workflow-repository.test.ts`
Expected: all pass.

```bash
git add src/main/database/migrations.ts src/main/database/workflow-repository.ts tests/database-migrations.test.ts
git commit -m "Persist the step transport, defaulting saved rows to CLI"
```

---

## Task 3: Give `WorkflowService` the chat service (optional, trailing)

**Objective:** Make the dependency available without breaking the harnesses.

**Files:**
- Modify: `src/main/workflows/workflow-service.ts` (constructor)
- Modify: `src/main/main.ts:68` and `:89` — **swap the order** so `gatewayChatService` is
  built before `workflowService`

**Step 1: Add the parameter**

```ts
    /**
     * Optional and last: several harnesses and tests construct this service, and a
     * required parameter would force every one of them to change. Absent means gateway
     * steps report that the transport is unavailable rather than crashing.
     */
    private readonly gatewayChatService?: GatewayChatService,
```

**Step 2: Verify the fan-out**

Run: `npm run typecheck`
Expected: exit 0. If it reports construction sites, that list *is* the fan-out — fix each,
do not grep for them.

**Step 3: Commit**

```bash
git add src/main/workflows/workflow-service.ts src/main/main.ts
git commit -m "Hand the gateway chat service to the workflow service"
```

---

## Task 4: Route `runStep` on transport

**Objective:** A gateway step calls `sendChat` instead of `spawn`.

**Files:**
- Modify: `src/main/workflows/workflow-service.ts:574-590` (the `if (dryRun) … else` block)
- Test: `tests/workflow-gateway-step.test.ts` (**new** — must be registered, see Task 6)

**Step 1: Write the failing test**

```ts
test("a gateway step sends the instruction over HTTP and never spawns a CLI", async () => {
  const sent: string[] = [];
  const chat = {
    sendChat: async (request) => {
      sent.push(request.messages.at(-1).content);
      return { ok: true, data: { text: "gateway answer", cancelled: false, /* … */ } };
    },
    cancel: () => true,
    listTargets: () => [],
  };
  // …build a workflow whose single step has transport: "gateway", run it…
  assert.deepEqual(sent, ["do the thing"]);
  assert.match(stepRun.output, /gateway answer/);
});
```

**Step 2: Run it and watch it fail**

Expected: FAIL — the step spawns a CLI and `sent` stays empty.

**Step 3: Add the branch**

```ts
    if (dryRun) {
      output = `[dry-run] ${instruction}`;
      await delay(180);
    } else if (step.transport === "gateway") {
      const result = await this.runGatewayStep({
        step,
        profile,
        instruction,
        runId,
        workflowId: workflow.id,
      });
      status = result.status;
      // No process, so no exit code. Null rather than 0: claiming a clean exit for
      // something that never ran as a process would be a lie in the run record.
      exitCode = null;
      output = result.output;
    } else {
      /* existing spawnStep call, unchanged */
    }
```

`runGatewayStep` must:
- return `{ status: "failed", output: "…" }` with a stated reason when
  `this.gatewayChatService` is absent, or when no connection is bound (see Open
  Question 1) — **never** silently succeed;
- mint `requestId` as `` `${runId}:${step.id}` `` so cancel can find it without extra state;
- pass `step.timeoutSeconds * 1000` through so the step honours its own timeout;
- emit `workflow:log` for streamed text, coalesced (~250ms) rather than per delta;
- map `result.data.cancelled` to status `"cancelled"`, not `"success"`.

**Step 4: Verify, then commit**

Run: `node … --test tests/workflow-gateway-step.test.ts`

```bash
git add src/main/workflows/workflow-service.ts tests/workflow-gateway-step.test.ts
git commit -m "Run a gateway-transport step over HTTP instead of spawning a CLI"
```

---

## Task 5: Make `cancel()` reach a gateway step

**Objective:** Close the real gap — today `cancel()` only kills a child process.

**Files:**
- Modify: `src/main/workflows/workflow-service.ts:164-177`
- Test: `tests/workflow-gateway-step.test.ts`

**Step 1: Write the failing test**

```ts
test("cancelling a run with a gateway step aborts the request, not just a child", async () => {
  let cancelledId = "";
  const chat = { cancel: (id) => { cancelledId = id; return true; }, /* … */ };
  // …start the run, cancel it mid-stream…
  assert.equal(cancelledId, `${runId}:${stepId}`, "the in-flight gateway request must be aborted");
});
```

**Step 2: Run it and watch it fail**

Expected: FAIL — `cancelledId` stays empty, because `cancel()` only calls `child?.kill()`.

**Step 3: Track and abort the request id**

Add `gatewayRequestId?: string` to the `active` map entry (declared around
`workflow-service.ts:31`), set it in `runGatewayStep`, clear it on settle, and in `cancel()`:

```ts
    running.cancelled = true;
    running.child?.kill(process.platform === "win32" ? undefined : "SIGTERM");
    // A gateway step has no child. Without this the Cancel button reported success
    // while the stream kept running and kept billing.
    if (running.gatewayRequestId) this.gatewayChatService?.cancel(running.gatewayRequestId);
    this.repo.updateRunStatus(workflowRunId, "cancelled");
```

**Step 4: Verify and commit**

```bash
git add src/main/workflows/workflow-service.ts tests/workflow-gateway-step.test.ts
git commit -m "Abort an in-flight gateway request when a run is cancelled"
```

---

## Task 6: Register the new test file

**Objective:** Without this, the file is invisible and every assertion above is dead code.

**Files:**
- Modify: `package.json` → `test:workflows` (the script lists every file **by name**)

Add `tests/workflow-gateway-step.test.ts` next to the other workflow entries.

**Verify:** `npm run test:workflows 2>&1 | grep -c workflow-gateway-step` → non-zero, and
the total test count rises by the number of tests you wrote.

```bash
git add package.json
git commit -m "Register the gateway-step test file"
```

---

## Task 7: Builder UI — choose the transport

**Objective:** Expose the choice, and only offer it when it can actually work.

**Files:**
- Modify: `src/renderer/workflows/WorkflowEditorDrawer.tsx` (new field before the CLI
  select at `:459`; include `transport` in the save payload near `:226-232`)
- Modify: `src/renderer/workflows/workflows.css` only if no existing class fits

**Requirements:**
- Reuse `wf-field` / `wf-col-2`; grep `^\.wf-[a-z-]+` before writing any new class name.
- When `transport === "gateway"`: disable the CLI select (it is meaningless) and show a
  gateway connection select fed by `window.agentic.gateway.listChatTargets()`.
- When no gateway target exists, do **not** silently offer the option — show it disabled
  with a one-line reason and a link to Settings. A dead dropdown is worse than an absent one.
- Default new steps to `transport: "cli"`.

**Verify:** `npm run typecheck`, then add a wiring assertion to
`tests/desktop-feature-wiring.test.ts` (a backend-only implementation compiles but shows
up as an unusable UI):

```ts
assert.match(drawer, /transport/, "the builder must expose the transport choice");
assert.match(drawer, /listChatTargets/, "a gateway step needs a connection picker");
```

```bash
git add src/renderer/workflows/WorkflowEditorDrawer.tsx tests/desktop-feature-wiring.test.ts
git commit -m "Let the builder pick a step's transport and gateway connection"
```

---

## Task 8: Verify for real, then close the docs out

**Objective:** Prove it with execution, not description.

**Step 1: Full gates**

```bash
npm test          # expect 511 + your new tests, 0 fail
npm run build     # expect "Packaging application" ✔
```

**Step 2: Prove the tests bite (discriminating matrix, no source sabotage)**

Write a throwaway `.verify/step-transport-matrix.ts` (`.verify/` is gitignored — confirm
with `git check-ignore -v .verify`) that drives the real `runStep` with:

| Input | Must produce |
| --- | --- |
| `transport: undefined` (legacy row) | spawns CLI |
| `transport: "cli"` | spawns CLI |
| `transport: "gateway"` + connection | HTTP, no spawn |
| `transport: "gateway"`, no chat service | `failed` with a stated reason |
| `transport: "gateway"`, no connection bound | `failed`, not a silent fallback |
| cancel mid-stream | `cancelled`, `chat.cancel` called with `runId:stepId` |

If every row reads the same, the routing is a no-op and the tests are decorative.

**Step 3: Live check against a real gateway**

The mock provider at `http://127.0.0.1:5199` streams real SSE and accepts any bearer;
Pool API at `:5100` enforces auth (real 401). Mint a key with
`bash ~/GitTool/pool-api-ai/scripts/create-test-key.sh dev@pool.local <name>` — **write it
to a file and read it through a variable**, never echo it; the terminal redacts key-shaped
output and a redacted paste silently corrupts whatever file receives it.

Run a real one-step workflow through the gateway and confirm: step output holds the reply,
`workflow_step_runs.exit_code` is null (not 0), and Cancel mid-stream lands the run as
`cancelled` with the partial text kept.

**Step 4: Clean up and update the docs**

Delete the `.verify/` scratch files. Then update **three** places, as this repo requires:
- `docs/feature/ai-gateway-sidecar.md` — the phase-3 residual is now closed
- `docs/feature/README.md` — the plan-15 row and the pass note
- `docs/unfinished-features.md` — remove the "workflow/agent adapter" wording from item 3

```bash
git add docs/ && git commit -m "docs: record gateway transport for workflow steps"
git push
```

---

## Files likely to change

| File | Change |
| --- | --- |
| `src/contracts/workflow.ts` | `transport` on `WorkflowStepDefinition` |
| `src/main/database/migrations.ts` | migration 9, `scope: "workflow"` |
| `src/main/database/workflow-repository.ts` | insert + hydrate + `StepRow` |
| `src/main/workflows/workflow-service.ts` | route `runStep`, `runGatewayStep`, `cancel()` |
| `src/main/main.ts` | construction order + pass the chat service |
| `src/renderer/workflows/WorkflowEditorDrawer.tsx` | transport + connection selects |
| `package.json` | register the new test file |
| `tests/workflow-gateway-step.test.ts` | new |
| `tests/desktop-feature-wiring.test.ts` | UI wiring assertions |
| `docs/` × 3 | status flip |

**Not changing:** `gateway-chat-client.ts` and `gateway-chat-service.ts`. If this plan
starts editing them, the design drifted — the whole point is that phase 3 already handles
streaming, cancel, credentials, and the HTTP-200-carrying-an-error case.

---

## Risks and tradeoffs

- **Schema change touches saved workflows.** Mitigated by a nullable column plus a
  hydrator default, so an existing row keeps spawning a CLI with no backfill. Prove it by
  opening a database written before the migration and running a saved workflow.
- **A step with no exit code.** `exit_code` becomes null for gateway steps. Check the run
  detail UI does not render null as `0` — that would claim a clean process exit for
  something that never was a process.
- **Log volume.** Streaming a long answer per-delta would flood `workflow:log` and
  `terminal_logs`. Coalescing is in Task 4 for that reason.
- **Cost is now silent.** A CLI step's spend is visible in that vendor's own tooling; a
  gateway step bills the Pool API key. Worth surfacing later, out of scope here.
- **Parallel sessions.** Another agent session edits this repo live. Check
  `git log --format='%h %ad %an'` and file mtimes before concluding something is broken,
  and re-run a red suite once — five failures here turned out to be a torn read of a file
  being written mid-run.
