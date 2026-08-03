import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("renderer navigation uses one AgenticOS shell", async () => {
  const [app, sidebar, navigation, agentsCss] = await Promise.all([
    readFile(new URL("../src/renderer/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/components/Sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/workspace-navigation.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/agents/agents.css", import.meta.url), "utf8"),
  ]);

  assert.match(sidebar, /AgenticOS/);
  assert.match(sidebar, /workspaceNavigation/);
  assert.match(navigation, /Settings/);
  assert.match(navigation, /Integrations/);
  assert.match(navigation, /Analytics/);
  assert.match(app, /SettingsModule/);
  assert.match(app, /IntegrationsModule/);
  assert.match(app, /AnalyticsModule/);
  assert.doesNotMatch(`${app}\n${sidebar}`, /AI Agent Platform|isAgentPlatformSurface|sidebar-agent-platform/);
  assert.doesNotMatch(`${app}\n${agentsCss}`, /app-shell-agents|dashboard-agents/);
});

test("overview, task, and agent controls avoid stale mock runtime values", async () => {
  const [app, map, tasks, topbar, agents] = await Promise.all([
    readFile(new URL("../src/renderer/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/map/WorkspaceMap3D.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/tasks/TasksModule.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/components/TopBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/agents/AgentsPage.tsx", import.meta.url), "utf8"),
  ]);

  const runtimeSource = `${app}\n${map}\n${tasks}\n${topbar}\n${agents}`;
  assert.doesNotMatch(
    runtimeSource,
    /Define API Schema|Implement Auth|Deploy to Prod|2\.48%|-12\.5%|db\/schema\.ts|app\/chatgpt-auth\.ts|worker\/index\.ts|vite\.config\.ts|>LW</,
  );
  assert.doesNotMatch(runtimeSource, /agents-platform-map|agent-map-image/);
  assert.match(tasks, /Agent Task Deck/);
  assert.match(app, /Working Model Roster/);

  assert.match(map, /history: AgentRunRecord\[\]/);
  assert.match(map, /buildErrorRate\(history\)/);
  assert.match(topbar, /onNavigate/);
  assert.match(topbar, /setNotificationsOpen/);
  assert.doesNotMatch(agents, /setNotificationsOpen|workspaceInitials|agent-notification-button|agent-user-button/);
  assert.match(agents, /formatDuration\(totalMs\)/);
  assert.match(agents, /onToggleExpanded/);
});
