/**
 * Isometric workspace scene configuration.
 *
 * Layout is a hexagonal district ring around the central Workflow Engine plaza.
 * Everything an agent can stand on or walk along is declared here so the roads,
 * the walk animation and the click targets all read from one source of truth.
 */

import type { AgentStatus } from "@contracts";

export type ZoneId =
  | "planning"
  | "code"
  | "documents"
  | "engine"
  | "testing"
  | "monitoring"
  | "deployment";

export type AgentState =
  | "idle"
  | "thinking"
  | "moving"
  | "working"
  | "reviewing"
  | "testing"
  | "deploying"
  | "blocked"
  | "complete";

export type Vec3 = [number, number, number];

export type AgentVariant = "planner" | "coder" | "reviewer" | "tester" | "deployer" | "monitor";

export type ZoneVariant = "core" | "lab" | "office" | "ops" | "vault" | "yard";

export type ZoneConfig = {
  accent: string;
  /** Footprint of the floating platform in world units. */
  footprint: [number, number];
  id: ZoneId;
  /** Point light reach for this zone. */
  lightDistance: number;
  lightIntensity: number;
  position: Vec3;
  /** Platform faces the plaza; derived once here so meshes and docks agree. */
  rotationY: number;
  scale: number;
  subtitle: string;
  title: string;
  variant: ZoneVariant;
};

export type AgentConfig = {
  accent: string;
  homeZone: ZoneId;
  id: string;
  /** Lane offset in world units so agents never overlap on a shared road. */
  lane: number;
  name: string;
  role: string;
  state: AgentState;
  variant: AgentVariant;
};

/** Deep office-neon tokens tuned to the AI workspace reference palette. */
export const palette = {
  amber: "#fbbf24",
  blue: "#60a5fa",
  core: "#60a5fa",
  cyan: "#67e8f9",
  green: "#86efac",
  lavender: "#a78bfa",
  peach: "#fdba9b",
  pink: "#f472b6",
  violet: "#a78bfa",
} as const;

/** Radius of the district ring measured from the plaza centre. */
const RING_RADIUS = 7;

/** Hex ring order, clockwise from the top of the map. */
const ringOrder: ZoneId[] = [
  "planning",
  "documents",
  "testing",
  "deployment",
  "monitoring",
  "code",
];

function ringPosition(index: number, radius = RING_RADIUS): Vec3 {
  // -90deg start puts "planning" at the far edge of an isometric camera.
  const angle = (Math.PI / 3) * index - Math.PI / 2;
  return [
    Number((Math.cos(angle) * radius).toFixed(3)),
    0,
    Number((Math.sin(angle) * radius).toFixed(3)),
  ];
}

/**
 * Every block shares the same isometric orientation, exactly like the design
 * reference. Rotating platforms toward the plaza hid their interiors behind
 * their own walls, which is what made the map read as flat dark plates.
 */
function faceCenter(_position: Vec3): number {
  return 0;
}

type ZoneSeed = Omit<ZoneConfig, "position" | "rotationY"> & { ringIndex: number };

const zoneSeeds: ZoneSeed[] = [
  {
    id: "planning",
    ringIndex: 0,
    title: "PLANNING",
    subtitle: "Strategy & Roadmap",
    accent: palette.blue,
    variant: "office",
    footprint: [5.7, 4.55],
    scale: 1.04,
    lightIntensity: 1.5,
    lightDistance: 8,
  },
  {
    id: "documents",
    ringIndex: 1,
    title: "DOCUMENTS",
    subtitle: "Knowledge Base",
    accent: palette.lavender,
    variant: "vault",
    footprint: [5.7, 4.55],
    scale: 1.04,
    lightIntensity: 1.6,
    lightDistance: 8,
  },
  {
    id: "testing",
    ringIndex: 2,
    title: "TESTING",
    subtitle: "Quality Assurance",
    accent: palette.pink,
    variant: "lab",
    footprint: [5.95, 4.75],
    scale: 1.1,
    lightIntensity: 1.35,
    lightDistance: 7.5,
  },
  {
    id: "deployment",
    ringIndex: 3,
    title: "DEPLOYMENT",
    subtitle: "CI/CD Pipeline",
    accent: palette.amber,
    variant: "yard",
    footprint: [5.95, 4.75],
    scale: 1.1,
    lightIntensity: 1.3,
    lightDistance: 7.5,
  },
  {
    id: "monitoring",
    ringIndex: 4,
    title: "MONITORING",
    subtitle: "Observability & Metrics",
    accent: palette.peach,
    variant: "ops",
    footprint: [5.95, 4.75],
    scale: 1.1,
    lightIntensity: 1.3,
    lightDistance: 7.5,
  },
  {
    id: "code",
    ringIndex: 5,
    title: "CODE",
    subtitle: "Development Zone",
    accent: palette.cyan,
    variant: "lab",
    footprint: [5.95, 4.75],
    scale: 1.1,
    lightIntensity: 1.55,
    lightDistance: 8,
  },
];

export const zones: ZoneConfig[] = [
  {
    id: "engine",
    title: "WORKFLOW ENGINE",
    subtitle: "Orchestration & Logic",
    accent: palette.core,
    variant: "core",
    footprint: [6.2, 6.2],
    position: [0, 0, 0],
    rotationY: 0,
    scale: 1,
    lightIntensity: 1.5,
    lightDistance: 10,
  },
  ...zoneSeeds.map((seed) => {
    const position = ringPosition(seed.ringIndex);
    const { ringIndex: _ringIndex, ...rest } = seed;
    return { ...rest, position, rotationY: faceCenter(position) } satisfies ZoneConfig;
  }),
];

export const zoneById = new Map<ZoneId, ZoneConfig>(zones.map((zone) => [zone.id, zone]));

/* ------------------------------------------------------------------ */
/* Navigation graph                                                    */
/* ------------------------------------------------------------------ */

export type NavNodeId = string;

export type NavNode = {
  id: NavNodeId;
  /** Zone this node belongs to, used to resolve travel targets. */
  kind: "dock" | "gate" | "plaza";
  position: Vec3;
  zoneId: ZoneId;
};

/** Radius where the ring road runs. */
const GATE_RADIUS = RING_RADIUS - 3.05;
/** Radius of the plaza rim nodes around the engine. */
const PLAZA_RADIUS = 2.35;

function scaleTo(position: Vec3, radius: number): Vec3 {
  const length = Math.hypot(position[0], position[2]) || 1;
  return [
    Number(((position[0] / length) * radius).toFixed(3)),
    0,
    Number(((position[2] / length) * radius).toFixed(3)),
  ];
}

const navNodeList: NavNode[] = [];
const navEdgeList: Array<[NavNodeId, NavNodeId]> = [];

navNodeList.push({ id: "plaza:engine", kind: "dock", position: [0, 0, 0], zoneId: "engine" });

ringOrder.forEach((zoneId, index) => {
  const zonePosition = ringPosition(index);

  // Dock sits on the platform, slightly toward the plaza so the agent is visible.
  const dock = scaleTo(zonePosition, RING_RADIUS - 1.15);
  const gate = scaleTo(zonePosition, GATE_RADIUS);
  const plazaRim = scaleTo(zonePosition, PLAZA_RADIUS);

  navNodeList.push(
    { id: `dock:${zoneId}`, kind: "dock", position: dock, zoneId },
    { id: `gate:${zoneId}`, kind: "gate", position: gate, zoneId },
    { id: `rim:${zoneId}`, kind: "plaza", position: plazaRim, zoneId: "engine" },
  );

  navEdgeList.push([`dock:${zoneId}`, `gate:${zoneId}`]);
  navEdgeList.push([`gate:${zoneId}`, `rim:${zoneId}`]);
  navEdgeList.push([`rim:${zoneId}`, "plaza:engine"]);
});

// Ring road: connect neighbouring gates so agents can hop districts without
// walking through the engine every time.
ringOrder.forEach((zoneId, index) => {
  const next = ringOrder[(index + 1) % ringOrder.length];
  navEdgeList.push([`gate:${zoneId}`, `gate:${next}`]);
});

export const navNodes: NavNode[] = navNodeList;
export const navEdges: Array<[NavNodeId, NavNodeId]> = navEdgeList;

export const navNodeById = new Map<NavNodeId, NavNode>(
  navNodes.map((node) => [node.id, node]),
);

/** Node an agent parks on when it is assigned to a zone. */
export function dockNodeId(zoneId: ZoneId): NavNodeId {
  return zoneId === "engine" ? "plaza:engine" : `dock:${zoneId}`;
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

export const agents: AgentConfig[] = [
  {
    id: "planner-01",
    name: "Planner",
    role: "Planner",
    homeZone: "planning",
    accent: palette.blue,
    lane: 0.34,
    state: "thinking",
    variant: "planner",
  },
  {
    id: "planner-02",
    name: "Analyst",
    role: "Planner",
    homeZone: "planning",
    accent: palette.blue,
    lane: -0.18,
    state: "working",
    variant: "planner",
  },
  {
    id: "planner-03",
    name: "Coordinator",
    role: "Planner",
    homeZone: "planning",
    accent: palette.blue,
    lane: -1.06,
    state: "moving",
    variant: "planner",
  },
  {
    id: "coder-01",
    name: "Coder",
    role: "Coder",
    homeZone: "code",
    accent: palette.cyan,
    lane: -0.34,
    state: "working",
    variant: "coder",
  },
  {
    id: "coder-02",
    name: "Frontend",
    role: "Coder",
    homeZone: "code",
    accent: palette.cyan,
    lane: 0.12,
    state: "working",
    variant: "coder",
  },
  {
    id: "coder-03",
    name: "Backend",
    role: "Coder",
    homeZone: "code",
    accent: palette.cyan,
    lane: -0.82,
    state: "working",
    variant: "coder",
  },
  {
    id: "reviewer-01",
    name: "Reviewer",
    role: "Reviewer",
    homeZone: "engine",
    accent: palette.green,
    lane: 0.62,
    state: "reviewing",
    variant: "reviewer",
  },
  {
    id: "reviewer-02",
    name: "Architect",
    role: "Reviewer",
    homeZone: "documents",
    accent: palette.lavender,
    lane: 0.74,
    state: "reviewing",
    variant: "reviewer",
  },
  {
    id: "reviewer-03",
    name: "Curator",
    role: "Reviewer",
    homeZone: "documents",
    accent: palette.lavender,
    lane: -0.36,
    state: "working",
    variant: "reviewer",
  },
  {
    id: "tester-01",
    name: "Tester",
    role: "Tester",
    homeZone: "testing",
    accent: palette.pink,
    lane: -0.62,
    state: "testing",
    variant: "tester",
  },
  {
    id: "tester-02",
    name: "QA Lead",
    role: "Tester",
    homeZone: "testing",
    accent: palette.pink,
    lane: 0.26,
    state: "working",
    variant: "tester",
  },
  {
    id: "tester-03",
    name: "Runner",
    role: "Tester",
    homeZone: "testing",
    accent: palette.pink,
    lane: 1.06,
    state: "testing",
    variant: "tester",
  },
  {
    id: "deployer-01",
    name: "Deployer",
    role: "Deployer",
    homeZone: "deployment",
    accent: palette.amber,
    lane: 0.9,
    state: "deploying",
    variant: "deployer",
  },
  {
    id: "deployer-02",
    name: "Release",
    role: "Deployer",
    homeZone: "deployment",
    accent: palette.amber,
    lane: -0.1,
    state: "working",
    variant: "deployer",
  },
  {
    id: "deployer-03",
    name: "Staging",
    role: "Deployer",
    homeZone: "deployment",
    accent: palette.amber,
    lane: 1.2,
    state: "deploying",
    variant: "deployer",
  },
  {
    id: "monitor-01",
    name: "Monitor",
    role: "Monitor",
    homeZone: "monitoring",
    accent: palette.peach,
    lane: -0.9,
    state: "idle",
    variant: "monitor",
  },
  {
    id: "monitor-02",
    name: "Observer",
    role: "Monitor",
    homeZone: "monitoring",
    accent: palette.peach,
    lane: 0.16,
    state: "reviewing",
    variant: "monitor",
  },
  {
    id: "monitor-03",
    name: "Incident",
    role: "Monitor",
    homeZone: "monitoring",
    accent: palette.peach,
    lane: 1.08,
    state: "moving",
    variant: "monitor",
  },
];

/**
 * Where each agent should stand for a given run status, and what it does there.
 * A status change makes exactly the involved agents walk; everyone else keeps
 * working in place, which is what stops the whole crowd from twitching.
 */
export type AgentAssignment = { state: AgentState; zoneId: ZoneId };

const stay = (zoneId: ZoneId, state: AgentState): AgentAssignment => ({ state, zoneId });

const baseline: Record<string, AgentAssignment> = {
  "planner-01": stay("planning", "thinking"),
  "coder-01": stay("code", "working"),
  "reviewer-01": stay("engine", "reviewing"),
  "tester-01": stay("testing", "idle"),
  "deployer-01": stay("deployment", "idle"),
  "monitor-01": stay("monitoring", "idle"),
};

export const statusAssignments: Record<AgentStatus, Record<string, AgentAssignment>> = {
  idle: baseline,
  queued: {
    ...baseline,
    "planner-01": stay("planning", "thinking"),
  },
  planning: {
    ...baseline,
    "planner-01": stay("planning", "working"),
    "reviewer-01": stay("planning", "reviewing"),
  },
  moving: {
    ...baseline,
    "planner-01": stay("engine", "moving"),
    "coder-01": stay("engine", "moving"),
  },
  reading: {
    ...baseline,
    "planner-01": stay("documents", "working"),
    "reviewer-01": stay("documents", "reviewing"),
  },
  coding: {
    ...baseline,
    "coder-01": stay("code", "working"),
    "reviewer-01": stay("code", "reviewing"),
  },
  testing: {
    ...baseline,
    "tester-01": stay("testing", "testing"),
    "coder-01": stay("testing", "working"),
  },
  reviewing: {
    ...baseline,
    "reviewer-01": stay("code", "reviewing"),
    "tester-01": stay("code", "idle"),
  },
  "waiting-approval": {
    ...baseline,
    "reviewer-01": stay("engine", "blocked"),
    "planner-01": stay("engine", "blocked"),
  },
  completed: {
    ...baseline,
    "deployer-01": stay("deployment", "deploying"),
    "monitor-01": stay("deployment", "complete"),
    "tester-01": stay("testing", "complete"),
  },
  failed: {
    ...baseline,
    "monitor-01": stay("monitoring", "blocked"),
    "reviewer-01": stay("monitoring", "blocked"),
  },
  stopped: {
    ...baseline,
    "monitor-01": stay("monitoring", "idle"),
  },
};

/** Directed workflow graph rendered as glowing data conduits. */
export const workflowPaths: Array<{ accent: string; from: ZoneId; to: ZoneId }> = [
  { from: "planning", to: "engine", accent: palette.blue },
  { from: "code", to: "engine", accent: palette.cyan },
  { from: "documents", to: "engine", accent: palette.lavender },
  { from: "engine", to: "testing", accent: palette.pink },
  { from: "testing", to: "deployment", accent: palette.pink },
  { from: "deployment", to: "monitoring", accent: palette.amber },
  { from: "monitoring", to: "planning", accent: palette.peach },
];

/** Material presets. */
export const materials = {
  concrete: { color: "#142236", metalness: 0.28, roughness: 0.72 },
  darkMetal: { color: "#111C31", metalness: 0.58, roughness: 0.5 },
  frostedGlass: {
    color: "#8EC8FF",
    metalness: 0.1,
    opacity: 0.18,
    roughness: 0.14,
    transparent: true,
  },
  road: { color: "#0D1728", metalness: 0.38, roughness: 0.6 },
  robotShell: { color: "#EEF6FF", metalness: 0.2, roughness: 0.34 },
  robotJoint: { color: "#24314B", metalness: 0.54, roughness: 0.42 },
  screen: { color: "#081729", metalness: 0.18, roughness: 0.24 },
} as const;
