import { Canvas, useThree } from "@react-three/fiber";
import {
  Bot,
  BrainCircuit,
  Code2,
  FileText,
  Rocket,
  TestTube2,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useEffect, type CSSProperties } from "react";
import * as THREE from "three";
import type { AgentRunRecord, AgentStatus } from "@contracts";
import { WorkspaceScene } from "./WorkspaceScene";
import { zoneById, type ZoneId } from "./scene-config";

type OperationCard = {
  eta: string;
  icon: LucideIcon;
  id: ZoneId;
  priority: "High" | "Medium" | "Low";
  role: string;
  title: string;
};

type OperationCardView = OperationCard & {
  accent: string;
  status: string;
  statusTone: "active" | "completed" | "idle";
};

/** Floating cards sit in HTML above the canvas so text stays sharp (§16.7). */
const operationCards: OperationCard[] = [
  {
    id: "planning",
    title: "IPC Contract Audit",
    icon: BrainCircuit,
    eta: "ETA 10m",
    priority: "High",
    role: "Planning",
  },
  {
    id: "code",
    title: "Agent Runtime",
    icon: Code2,
    eta: "ETA 25m",
    priority: "High",
    role: "Coding",
  },
  {
    id: "documents",
    title: "Workspace Docs",
    icon: FileText,
    eta: "ETA 12m",
    priority: "Medium",
    role: "Reading",
  },
  {
    id: "testing",
    title: "Verification",
    icon: TestTube2,
    eta: "ETA 15m",
    priority: "High",
    role: "Testing",
  },
  {
    id: "deployment",
    title: "Desktop Package",
    icon: Rocket,
    eta: "ETA 8m",
    priority: "Medium",
    role: "Release",
  },
];

const zoneStatuses: Partial<Record<ZoneId, AgentStatus[]>> = {
  planning: ["queued", "planning", "waiting-approval"],
  documents: ["reading"],
  code: ["coding", "reviewing"],
  testing: ["testing"],
  deployment: ["completed"],
};

const activeStatuses = new Set<AgentStatus>([
  "queued",
  "planning",
  "moving",
  "reading",
  "coding",
  "testing",
  "reviewing",
  "waiting-approval",
]);

function FloatingTask({ card, onOpenZone }: { card: OperationCardView; onOpenZone?: (zone: ZoneId) => void }) {
  const Icon = card.icon;
  const style = { "--task-accent": card.accent } as CSSProperties;

  return (
    <button className={`floating-task task-${card.id}`} style={style} type="button" onClick={() => onOpenZone?.(card.id)}>
      <header>
        <span>
          <Icon size={12} />
          {card.title}
        </span>
        <em>{card.priority}</em>
      </header>
      <p>
        <Bot size={12} />
        {card.role}
      </p>
      <footer>
        <strong className={card.statusTone === "completed" ? "completed" : ""}>
          {card.statusTone === "completed" ? "✓ " : ""}
          {card.status}
        </strong>
        <span>{card.eta}</span>
      </footer>
    </button>
  );
}

/** Keeps the whole district ring inside the panel at any window size. */
function CameraFit({ radius = 8.1 }: { radius?: number }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  useEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return;

    // Isometric footprint: the ring projects roughly 1.3x wider than tall.
    const horizontal = size.width / (radius * 2 * 1.3);
    const vertical = size.height / (radius * 2 * 0.96);

    camera.zoom = Math.max(12, Math.min(horizontal, vertical));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, radius, size.height, size.width]);

  return null;
}

export function WorkspaceMap3D({
  activeStatus,
  history,
  onOpenZone,
  selectedZone,
  onSelectZone,
}: {
  activeStatus: AgentStatus;
  history: AgentRunRecord[];
  onOpenZone?: (zone: ZoneId) => void;
  selectedZone: string;
  onSelectZone: (zone: string) => void;
}) {
  const cards = buildOperationCards(history, activeStatus);
  const errorRate = buildErrorRate(history);

  return (
    <section
      className="workspace-scene desktop-workspace-scene"
      aria-label={`AI agent operation map, active state ${activeStatus}`}
      data-active-status={activeStatus}
    >
      <div className="scene-atmosphere" aria-hidden="true" />
      <div className="scene-reference-texture" aria-hidden="true" />

      <div className="workspace-canvas-host">
        <Canvas
          camera={{ far: 160, near: 0.1, position: [21, 18.5, 21], zoom: 34 }}
          dpr={[1, 1.2]}
          gl={{
            alpha: true,
            antialias: true,
            powerPreference: "high-performance",
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.12,
          }}
          orthographic
          shadows
        >
          <fog attach="fog" args={["#070815", 28, 52]} />
          <CameraFit />
          <ambientLight intensity={0.2} />
          <hemisphereLight args={["#78B8FF", "#070815", 0.4]} />
          <directionalLight
            castShadow
            intensity={0.9}
            position={[9, 15, 7]}
            shadow-mapSize={[1024, 1024]}
          />
          <directionalLight color="#67e8f9" intensity={0.28} position={[-9, 9, -7]} />
          <pointLight color="#60a5fa" distance={16} intensity={0.52} position={[0, 5.2, 0]} />
          <pointLight color="#fbbf24" distance={11} intensity={0.18} position={[0, 1.8, 0]} />

          <Suspense fallback={null}>
            <WorkspaceScene
              activeStatus={activeStatus}
              onSelectZone={onSelectZone}
              selectedZone={selectedZone}
            />
          </Suspense>
        </Canvas>
      </div>

      {cards.map((card) => (
        <FloatingTask card={card} key={card.id} onOpenZone={onOpenZone} />
      ))}

      <article className="error-rate-card">
        <small>Run Error Rate</small>
        <strong>{errorRate.value}</strong>
        <span>{errorRate.delta}</span>
        <em>{errorRate.detail}</em>
        <svg viewBox="0 0 100 38" role="img" aria-label="Run error rate trend">
          <path d={errorRate.path} />
          <circle cx={errorRate.lastPoint.x} cy={errorRate.lastPoint.y} r="3" />
        </svg>
      </article>
    </section>
  );
}

function buildOperationCards(history: AgentRunRecord[], activeStatus: AgentStatus): OperationCardView[] {
  return operationCards.map((card) => {
    const statuses = new Set(zoneStatuses[card.id] ?? []);
    const activeCount = history.filter((run) => statuses.has(run.status) && activeStatuses.has(run.status)).length;
    const completedCount = history.filter((run) => statuses.has(run.status) && run.status === "completed").length;
    const currentZoneActive = statuses.has(activeStatus) && activeStatuses.has(activeStatus);
    const totalActive = activeCount + (currentZoneActive && activeCount === 0 ? 1 : 0);
    const accent = zoneById.get(card.id)?.accent ?? "#60a5fa";

    if (totalActive > 0) {
      return {
        ...card,
        accent,
        status: "In Progress",
        statusTone: "active",
      };
    }

    if (completedCount > 0) {
      return {
        ...card,
        accent,
        status: "Completed",
        statusTone: "completed",
      };
    }

    return {
      ...card,
      accent,
      status: "Idle",
      statusTone: "idle",
    };
  });
}

function buildErrorRate(history: AgentRunRecord[]): {
  delta: string;
  detail: string;
  lastPoint: { x: number; y: number };
  path: string;
  value: string;
} {
  const now = Date.now();
  const current = errorRateBetween(history, now - 86_400_000, now);
  const previous = errorRateBetween(history, now - 172_800_000, now - 86_400_000);
  const buckets = Array.from({ length: 8 }, (_, index) => {
    const bucketMs = 86_400_000 / 8;
    const start = now - 86_400_000 + bucketMs * index;
    return errorRateBetween(history, start, start + bucketMs).rate;
  });

  if (current.finished === 0) {
    return {
      delta: "0 runs",
      detail: "last 24h",
      lastPoint: lastPointFor(buckets, 100, 38),
      path: pointsFor(buckets, 100, 38),
      value: "No data",
    };
  }

  const delta = previous.finished === 0 ? null : current.rate - previous.rate;
  return {
    delta: delta === null ? "No baseline" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts`,
    detail: `${current.failed}/${current.finished} failed runs`,
    lastPoint: lastPointFor(buckets, 100, 38),
    path: pointsFor(buckets, 100, 38),
    value: `${current.rate.toFixed(1)}%`,
  };
}

function errorRateBetween(history: AgentRunRecord[], start: number, end: number): {
  failed: number;
  finished: number;
  rate: number;
} {
  const finishedRuns = history.filter((run) => {
    const timestamp = Date.parse(run.endedAt ?? run.startedAt);
    return (
      Number.isFinite(timestamp) &&
      timestamp >= start &&
      timestamp < end &&
      (run.status === "completed" || run.status === "failed")
    );
  });
  const failed = finishedRuns.filter((run) => run.status === "failed").length;
  return {
    failed,
    finished: finishedRuns.length,
    rate: finishedRuns.length === 0 ? 0 : (failed / finishedRuns.length) * 100,
  };
}

function pointsFor(values: number[], width: number, height: number): string {
  const max = Math.max(...values, 1);
  return values
    .map((value, index) => {
      const x = 2 + (index / Math.max(values.length - 1, 1)) * (width - 4);
      const y = height - 4 - (value / max) * (height - 8);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function lastPointFor(values: number[], width: number, height: number): { x: number; y: number } {
  const max = Math.max(...values, 1);
  const value = values.at(-1) ?? 0;
  return {
    x: width - 2,
    y: height - 4 - (value / max) * (height - 8),
  };
}
