/**
 * Agent fleet arena.
 *
 * This scene deliberately mirrors the Overview workspace map (`map/WorkspaceMap3D`):
 * orthographic isometric camera, ACES tone mapping, floating platforms with
 * emissive edge trim, roads generated toward the core, glowing data conduits and
 * HTML signage above the canvas. The previous version used a near perspective
 * camera, a raw `gridHelper` and box-built robots, which is why it read as flat
 * and toy-like next to Overview.
 */

import { Grid, Html, RoundedBox } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Bot, MessageCircle, Play, Square, Terminal } from "lucide-react";
import type { AgentStatus } from "@contracts";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { statusLabel, statusTone } from "../stores/agents-store";
import { materials, palette } from "../map/scene-config";

export type RobotArenaNode = {
  accent: string;
  detail: string;
  id: string;
  metric: string;
  moduleLabel: string;
  name: string;
  profileId?: string;
  mode: string;
  role: string;
  status: AgentStatus | "missing";
  summary: string;
  x: number;
  y: number;
};

type RobotTone = "active" | "busy" | "done" | "error" | "idle";

/** Pod deck size in world units, scaled down from an Overview district. */
const POD_FOOTPRINT: [number, number] = [3.05, 2.7];
/** Radius of the plaza rim the spokes stop at. */
const CORE_RADIUS = 2.05;
/** Every pod shares the camera-facing orientation, exactly like Overview districts. */
const STATION_YAW = Math.PI * 0.25;

/**
 * Camera sits at [19, 16.5, 19], so its horizontal run is sqrt(19^2 + 19^2) and the
 * elevation is atan(16.5 / that). Ground distances squash by sin(elevation) on screen
 * while vertical distances keep cos(elevation); CameraFit needs both to size the ring.
 */
const ISO_ELEVATION = Math.atan(16.5 / Math.hypot(19, 19));
const ISO_SIN_ELEVATION = Math.sin(ISO_ELEVATION);
const ISO_COS_ELEVATION = Math.cos(ISO_ELEVATION);
/** Tallest thing above the deck: pod tower plus the signage sitting over it. */
const SCENE_HEIGHT = 4.4;

function ringRadius(count: number): number {
  if (count <= 3) return 4.6;
  if (count <= 5) return 5.6;
  if (count <= 6) return 6.4;
  if (count <= 8) return 7.6;
  return 8.4;
}

function podPosition(index: number, count: number): [number, number, number] {
  const radius = ringRadius(count);
  const angle = (Math.PI * 2 * index) / Math.max(count, 1) - Math.PI / 2;
  return [
    Number((Math.cos(angle) * radius).toFixed(3)),
    0,
    Number((Math.sin(angle) * radius).toFixed(3)),
  ];
}

export function AgentRobotArena({
  robots,
  selectedProfileId,
  zoom,
  onSelectProfile,
  onRunProfile,
  onStopProfile,
  onOpenTerminal,
  isRunning,
}: {
  robots: RobotArenaNode[];
  selectedProfileId: string | null;
  zoom: number;
  onSelectProfile: (profileId: string) => void;
  /** Optional: when provided the nameplate rail grows Run/Stop/Terminal quick actions. */
  onRunProfile?: (profileId: string) => void;
  onStopProfile?: (profileId: string) => void;
  onOpenTerminal?: (profileId: string) => void;
  isRunning?: (profileId: string) => boolean;
}) {
  const count = robots.length;

  return (
    <div className="agent-robot-arena" data-agent-robot-canvas="true">
      <div className="scene-atmosphere" aria-hidden="true" />

      <div className="agent-robot-world">
        <Canvas
          className="agent-robot-canvas"
          camera={{ far: 160, near: 0.1, position: [19, 16.5, 19], zoom: 38 }}
          dpr={[1, 1.2]}
          gl={{
            alpha: true,
            antialias: true,
            powerPreference: "high-performance",
            // Required: `verify:agents:ui` proves the scene is not blank via
            // gl.readPixels(), which reads zeroes once the frame is composited
            // unless the drawing buffer survives it.
            preserveDrawingBuffer: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.12,
          }}
          orthographic
        >
          <ContextLossGuard />
          <fog attach="fog" args={["#070815", 30, 58]} />
          <CameraFit radius={ringRadius(Math.max(count, 1)) + 2.2} zoom={zoom} />

          <ambientLight intensity={0.34} />
          <hemisphereLight args={[palette.blue, "#070815", 0.55]} />
          <directionalLight intensity={0.95} position={[9, 15, 7]} />
          <directionalLight color={palette.cyan} intensity={0.28} position={[-9, 9, -7]} />
          <pointLight color={palette.core} distance={16} intensity={0.52} position={[0, 5.2, 0]} />
          <pointLight color={palette.amber} distance={11} intensity={0.18} position={[0, 1.8, 0]} />


          <Suspense fallback={null}>
            <group position={[0, -0.5, 0]}>
              <Grid
                args={[40, 40]}
                cellColor="#1d2444"
                cellSize={1}
                cellThickness={0.22}
                fadeDistance={24}
                fadeStrength={2.4}
                infiniteGrid
                position={[0, -1.7, 0]}
                sectionColor="#4a6fbf"
                sectionSize={4}
                sectionThickness={0.48}
              />

              <ArenaFloorPlate count={count} />
              <ArenaFoundation />
              <FleetCore active={count > 0} />

              {robots.map((robot, index) => (
                <SpokeRoad accent={accentFor(robot)} count={count} index={index} key={`road-${robot.id}`} />
              ))}
              {robots.map((robot, index) => (
                <SpokeConduit
                  accent={accentFor(robot)}
                  count={count}
                  delay={index / Math.max(count, 1)}
                  index={index}
                  key={`conduit-${robot.id}`}
                  muted={robot.status === "missing"}
                />
              ))}

              {robots.map((robot, index) => (
                <RobotPod
                  count={count}
                  index={index}
                  key={robot.id}
                  onSelectProfile={onSelectProfile}
                  robot={robot}
                  selected={selectedProfileId === robot.profileId}
                />
              ))}
            </group>
          </Suspense>
        </Canvas>
      </div>

      <div className="agent-robot-vignette" aria-hidden="true" />

      <div className="robot-nameplate-rail" aria-label="Configured robot modules">
        {robots.map((robot) => (
          <div
            className={`robot-nameplate tone-${robotTone(robot.status)} ${
              selectedProfileId === robot.profileId ? "selected" : ""
            }`}
            key={robot.id}
            style={{ ["--robot-accent" as string]: accentFor(robot) }}
            title={robot.summary}
          >
            <button
              className="robot-nameplate-main"
              disabled={!robot.profileId}
              onClick={() => {
                if (robot.profileId) onSelectProfile(robot.profileId);
              }}
              type="button"
            >
              <strong>{robot.name}</strong>
              <small>
                {robot.moduleLabel} · {robot.mode}
              </small>
            </button>
            <span className="robot-nameplate-status">
              <MessageCircle size={11} />
              {robot.status === "missing" ? "Missing" : statusLabel[robot.status]}
            </span>
            {robot.profileId && (onRunProfile || onStopProfile || onOpenTerminal) && (
              <span className="robot-nameplate-actions">
                {onRunProfile && !isRunning?.(robot.profileId) && (
                  <button
                    aria-label={`Run ${robot.name}`}
                    onClick={() => onRunProfile(robot.profileId!)}
                    title="Run now"
                    type="button"
                  >
                    <Play size={12} />
                  </button>
                )}
                {onStopProfile && isRunning?.(robot.profileId) && (
                  <button
                    aria-label={`Stop ${robot.name}`}
                    className="danger"
                    onClick={() => onStopProfile(robot.profileId!)}
                    title="Stop"
                    type="button"
                  >
                    <Square size={12} />
                  </button>
                )}
                {onOpenTerminal && (
                  <button
                    aria-label={`Open terminal for ${robot.name}`}
                    onClick={() => onOpenTerminal(robot.profileId!)}
                    title="Terminal"
                    type="button"
                  >
                    <Terminal size={12} />
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>

      {robots.length === 0 && (
        <section className="agent-robot-empty">
          <Bot size={22} />
          <strong>No agent robots yet</strong>
          <small>Create an agent module to populate the robot floor.</small>
        </section>
      )}
    </div>
  );
}

/**
 * Electron drops the WebGL context under GPU pressure — two live canvases (this
 * arena plus the Overview map) make that easy to hit. Without this the canvas
 * freezes on its last frame forever, which reads as "the fleet stopped working".
 * Preventing the default on loss lets the browser hand back a fresh context, and
 * r3f rebuilds the scene graph on restore.
 */
function ContextLossGuard() {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const canvas = gl.domElement;

    const onLost = (event: Event) => {
      event.preventDefault();
    };
    const onRestored = () => {
      invalidate();
    };

    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);

    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, [gl, invalidate]);

  return null;
}

/** Keeps the whole pod ring inside the panel at any window size (mirrors Overview). */
function CameraFit({ radius, zoom }: { radius: number; zoom: number }) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  useEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return;

    // Project the ring's bounding cylinder through the isometric camera. The ground
    // circle keeps its width but squashes vertically by sin(elevation); pod towers
    // and signage add height, foreshortened by cos(elevation).
    const widthExtent = radius * 2;
    const heightExtent = radius * 2 * ISO_SIN_ELEVATION + SCENE_HEIGHT * ISO_COS_ELEVATION;

    const horizontal = size.width / widthExtent;
    const vertical = size.height / heightExtent;
    const fit = Math.max(12, Math.min(horizontal, vertical));

    camera.zoom = fit * clamp(zoom / 100, 0.7, 1.3);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, radius, size.height, size.width, zoom]);

  return null;
}

/* ------------------------------------------------------------------ */
/* Ground layers                                                       */
/* ------------------------------------------------------------------ */

function ArenaFloorPlate({ count }: { count: number }) {
  const radius = ringRadius(Math.max(count, 1));

  return (
    <group position={[0, -1.38, 0]}>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[radius + 4.6, 6]} />
        <meshStandardMaterial
          color="#0b1024"
          depthWrite={false}
          metalness={0.28}
          opacity={0.82}
          roughness={0.88}
          transparent
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[CORE_RADIUS, radius + 3.7, 6]} />
        <meshBasicMaterial color="#26305c" opacity={0.22} toneMapped={false} transparent />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius - 3.1, radius + 2.2, 6]} />
        <meshBasicMaterial color={palette.cyan} opacity={0.08} toneMapped={false} transparent />
      </mesh>
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.9, CORE_RADIUS + 1, 6]} />
        <meshBasicMaterial color={palette.core} opacity={0.24} toneMapped={false} transparent />
      </mesh>
    </group>
  );
}

function ArenaFoundation() {
  const rings = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (rings.current) rings.current.rotation.y = clock.elapsedTime * 0.035;
  });

  return (
    <group>
      <group position={[0, -1.62, 0]} ref={rings}>
        {[8.6, 10.4, 12.2].map((radius, index) => (
          <mesh key={radius} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[radius, radius + 0.03 + index * 0.012, 48]} />
            <meshBasicMaterial
              color={index === 1 ? palette.core : palette.cyan}
              opacity={0.085}
              toneMapped={false}
              transparent
            />
          </mesh>
        ))}
      </group>
      <mesh position={[0, -1.66, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[14, 48]} />
        <meshBasicMaterial color="#050A13" opacity={0.48} transparent />
      </mesh>
    </group>
  );
}

/** Road from the core plaza out to one pod, generated the same way Overview does. */
function SpokeRoad({ accent, count, index }: { accent: string; count: number; index: number }) {
  const segment = useMemo(() => {
    const pod = podPosition(index, count);
    const length = Math.hypot(pod[0], pod[2]) || 1;
    const inner = new THREE.Vector3((pod[0] / length) * CORE_RADIUS, 0, (pod[2] / length) * CORE_RADIUS);
    const outer = new THREE.Vector3(
      (pod[0] / length) * (length - POD_FOOTPRINT[1] * 0.42),
      0,
      (pod[2] / length) * (length - POD_FOOTPRINT[1] * 0.42),
    );
    const middle = inner.clone().lerp(outer, 0.5);
    const span = inner.distanceTo(outer);

    return {
      angle: Math.atan2(outer.x - inner.x, outer.z - inner.z),
      markerCount: Math.max(2, Math.round(span / 1.4)),
      position: [middle.x, 0.012, middle.z] as [number, number, number],
      span,
    };
  }, [count, index]);

  if (segment.span < 0.1) return null;

  return (
    <group position={segment.position} rotation-y={segment.angle}>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.62, segment.span + 0.08]} />
        <meshStandardMaterial color="#080a18" metalness={0.3} roughness={0.7} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.32, segment.span]} />
        <meshStandardMaterial {...materials.road} />
      </mesh>
      <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.08, segment.span * 0.95]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.92}
          opacity={0.42}
          toneMapped={false}
          transparent
        />
      </mesh>
      {Array.from({ length: segment.markerCount }).map((_, marker) => {
        const t = segment.markerCount <= 1 ? 0.5 : marker / (segment.markerCount - 1);
        const offset = -segment.span * 0.45 + segment.span * 0.9 * t;
        return (
          <mesh key={marker} position={[0, 0.006, offset]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.07, 0.26]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={1.45}
              opacity={0.36}
              toneMapped={false}
              transparent
            />
          </mesh>
        );
      })}
      {[-0.68, 0.68].map((x) => (
        <mesh key={x} position={[x, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.04, segment.span]} />
          <meshStandardMaterial
            color={palette.cyan}
            emissive={palette.cyan}
            emissiveIntensity={0.4}
            opacity={0.18}
            toneMapped={false}
            transparent
          />
        </mesh>
      ))}
    </group>
  );
}

/** Glowing data pulse travelling the spoke, same treatment as Overview conduits. */
function SpokeConduit({
  accent,
  count,
  delay,
  index,
  muted,
}: {
  accent: string;
  count: number;
  delay: number;
  index: number;
  muted: boolean;
}) {
  const pulse = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.MeshStandardMaterial>(null);

  const curve = useMemo(() => {
    const pod = podPosition(index, count);
    const length = Math.hypot(pod[0], pod[2]) || 1;
    return new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3((pod[0] / length) * CORE_RADIUS, 0.09, (pod[2] / length) * CORE_RADIUS),
        new THREE.Vector3(pod[0] * 0.62, 0.32, pod[2] * 0.62),
        new THREE.Vector3(
          (pod[0] / length) * (length - POD_FOOTPRINT[1] * 0.42),
          0.09,
          (pod[2] / length) * (length - POD_FOOTPRINT[1] * 0.42),
        ),
      ],
      false,
      "catmullrom",
      0.3,
    );
  }, [count, index]);

  const geometry = useMemo(() => new THREE.TubeGeometry(curve, 44, 0.02, 6, false), [curve]);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    if (pulse.current) pulse.current.position.copy(curve.getPointAt((time * 0.14 + delay) % 1));
    if (glow.current) glow.current.emissiveIntensity = 1.05 + Math.sin(time * 1.8 + delay * 5) * 0.28;
  });

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={1.15}
          opacity={muted ? 0.14 : 0.32}
          ref={glow}
          toneMapped={false}
          transparent
        />
      </mesh>
      {!muted && (
        <mesh ref={pulse}>
          <sphereGeometry args={[0.07, 12, 12]} />
          <meshStandardMaterial
            color="#FFFFFF"
            emissive={accent}
            emissiveIntensity={3.2}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Fleet core                                                          */
/* ------------------------------------------------------------------ */

function FleetCore({ active }: { active: boolean }) {
  const rings = useRef<THREE.Group>(null);
  const shard = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;

    if (rings.current) {
      rings.current.rotation.y = time * 0.3;
      rings.current.children.forEach((child, index) => {
        child.position.y = 1.4 + index * 0.28 + Math.sin(time * 1.4 + index) * 0.05;
        child.rotation.z = time * (0.2 + index * 0.12);
      });
    }

    if (shard.current) {
      shard.current.rotation.y = -time * 0.6;
      shard.current.position.y = 2.3 + Math.sin(time * 1.8) * 0.06;
    }
  });

  return (
    <group>
      <mesh position={[0, 0.008, 0]} receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[CORE_RADIUS + 0.7, 6]} />
        <meshStandardMaterial {...materials.concrete} />
      </mesh>
      <mesh position={[0, 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[CORE_RADIUS + 0.42, CORE_RADIUS + 0.54, 6]} />
        <meshStandardMaterial
          color={palette.core}
          emissive={palette.core}
          emissiveIntensity={active ? 1.3 : 0.7}
          toneMapped={false}
        />
      </mesh>
      {[0.8, 1.25, 1.7].map((radius) => (
        <mesh key={radius} position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[radius, radius + 0.02, 6]} />
          <meshBasicMaterial color={palette.core} opacity={0.24} toneMapped={false} transparent />
        </mesh>
      ))}

      <mesh castShadow position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.78, 1, 1, 6]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>
      <mesh position={[0, 1.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.48, 0.74, 6]} />
        <meshStandardMaterial
          color={palette.cyan}
          emissive={palette.cyan}
          emissiveIntensity={2.1}
          toneMapped={false}
        />
      </mesh>

      <group ref={rings}>
        {[0, 1, 2].map((index) => (
          <mesh key={index} position={[0, 1.4 + index * 0.28, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.7 - index * 0.16, 0.024, 12, 56]} />
            <meshStandardMaterial
              color={index === 1 ? palette.core : palette.cyan}
              emissive={index === 1 ? palette.core : palette.cyan}
              emissiveIntensity={2.6}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      <mesh position={[0, 2.3, 0]} ref={shard}>
        <octahedronGeometry args={[0.28, 0]} />
        <meshStandardMaterial
          color="#FFFFFF"
          emissive={palette.core}
          emissiveIntensity={4.2}
          toneMapped={false}
        />
      </mesh>

      <mesh position={[0, 1.72, 0]}>
        <cylinderGeometry args={[0.15, 0.28, 2.4, 18, 1, true]} />
        <meshBasicMaterial
          color={palette.core}
          depthWrite={false}
          opacity={0.18}
          side={THREE.DoubleSide}
          toneMapped={false}
          transparent
        />
      </mesh>

      <pointLight color={palette.core} distance={8} intensity={2.2} position={[0, 2.1, 0]} />

      <Html center className="zone-signage" position={[0, 3.1, 0]} zIndexRange={[6, 4]}>
        <span
          className="zone-signage-inner engine-signage"
          style={{ borderColor: `${palette.core}55` }}
        >
          <strong style={{ color: palette.core }}>AGENT FLEET</strong>
          <small>Runtime &amp; Session Control</small>
        </span>
      </Html>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Robot pod                                                           */
/* ------------------------------------------------------------------ */

function RobotPod({
  count,
  index,
  onSelectProfile,
  robot,
  selected,
}: {
  count: number;
  index: number;
  onSelectProfile: (profileId: string) => void;
  robot: RobotArenaNode;
  selected: boolean;
}) {
  const rim = useRef<THREE.Group>(null);
  const position = useMemo(() => podPosition(index, count), [count, index]);
  const [width, depth] = POD_FOOTPRINT;
  const accent = accentFor(robot);
  const tone = robotTone(robot.status);
  const clickable = Boolean(robot.profileId);

  useFrame(({ clock }) => {
    if (!rim.current) return;
    const pulse = 0.85 + Math.sin(clock.elapsedTime * 1.5 + index) * 0.16;
    const intensity = selected ? pulse + 1.25 : tone === "active" || tone === "busy" ? pulse + 0.55 : pulse;

    for (const child of rim.current.children) {
      const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = intensity;
    }
  });

  const select = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (robot.profileId) onSelectProfile(robot.profileId);
  };

  const hoverIn = (event: ThreeEvent<PointerEvent>) => {
    if (!clickable) return;
    event.stopPropagation();
    document.body.style.cursor = "pointer";
  };

  const hoverOut = () => {
    if (clickable) document.body.style.cursor = "";
  };

  return (
    <group onClick={select} onPointerOut={hoverOut} onPointerOver={hoverIn} position={position}>
      <RoundedBox
        args={[width, 0.42, depth]}
        castShadow
        position={[0, -0.21, 0]}
        radius={0.11}
        receiveShadow
        smoothness={3}
      >
        <meshStandardMaterial {...materials.darkMetal} />
      </RoundedBox>

      {/* platform deck */}
      <mesh position={[0, 0.005, 0]} receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width - 0.16, depth - 0.16]} />
        <meshStandardMaterial {...materials.concrete} />
      </mesh>

      {/* accent floor wash gives each robot its own colour identity */}
      <mesh position={[0, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width - 0.46, depth - 0.46]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.32}
          opacity={0.12}
          toneMapped={false}
          transparent
        />
      </mesh>

      {/* thin emissive edge trim: four bars, not a full glowing slab */}
      <group position={[0, -0.012, 0]} ref={rim}>
        {[
          { args: [width + 0.06, 0.045, 0.07] as [number, number, number], position: [0, 0, depth / 2] as [number, number, number] },
          { args: [width + 0.06, 0.045, 0.07] as [number, number, number], position: [0, 0, -depth / 2] as [number, number, number] },
          { args: [0.07, 0.045, depth + 0.06] as [number, number, number], position: [width / 2, 0, 0] as [number, number, number] },
          { args: [0.07, 0.045, depth + 0.06] as [number, number, number], position: [-width / 2, 0, 0] as [number, number, number] },
        ].map((bar, barIndex) => (
          <mesh key={barIndex} position={bar.position}>
            <boxGeometry args={bar.args} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={1.1}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      {/* under-strut so the pod reads as floating */}
      <mesh position={[0, -1.1, 0]}>
        <cylinderGeometry args={[Math.min(width, depth) * 0.26, 0.28, 1.45, 6]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>

      {/* facade trim on the two camera-facing sides */}
      {[
        { args: [width, 0.03, 0.05] as [number, number, number], position: [0, -0.38, depth / 2 + 0.01] as [number, number, number] },
        { args: [0.05, 0.03, depth] as [number, number, number], position: [width / 2 + 0.01, -0.38, 0] as [number, number, number] },
      ].map((bar, barIndex) => (
        <mesh key={barIndex} position={bar.position}>
          <boxGeometry args={bar.args} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={0.6}
            toneMapped={false}
          />
        </mesh>
      ))}

      <PodInterior accent={accent} tone={tone} />

      <group rotation-y={STATION_YAW}>
        <RobotUnit accent={accent} index={index} selected={selected} tone={tone} />
      </group>
    </group>
  );
}

/** Workstation furniture so a pod reads as a staffed room, like an Overview district. */
function PodInterior({ accent, tone }: { accent: string; tone: RobotTone }) {
  return (
    <group rotation-y={STATION_YAW}>
      {/* back wall with mullions and frosted glass */}
      <mesh position={[0, 0.9, -1.16]} receiveShadow>
        <boxGeometry args={[2.5, 1.8, 0.08]} />
        <meshStandardMaterial color="#1a2142" metalness={0.3} roughness={0.62} />
      </mesh>
      <mesh position={[-1.24, 0.9, 0]} receiveShadow>
        <boxGeometry args={[0.08, 1.8, 2.2]} />
        <meshStandardMaterial color="#151a35" metalness={0.3} roughness={0.62} />
      </mesh>
      <mesh position={[0, 0.9, -1.11]}>
        <boxGeometry args={[2.34, 1.62, 0.03]} />
        <meshStandardMaterial {...materials.frostedGlass} />
      </mesh>
      {[-0.72, 0, 0.72].map((x) => (
        <mesh key={x} position={[x, 0.9, -1.08]}>
          <boxGeometry args={[0.04, 1.62, 0.05]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={0.55}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* wall monitor array */}
      {[-0.62, 0.38].map((x) => (
        <mesh key={x} position={[x, 1.18, -1.05]}>
          <boxGeometry args={[0.76, 0.46, 0.04]} />
          <meshStandardMaterial {...materials.screen} emissive={accent} emissiveIntensity={1.4} />
        </mesh>
      ))}

      {/* ceiling light strips */}
      {[-0.5, 0.5].map((z) => (
        <mesh key={z} position={[0, 1.78, z]}>
          <boxGeometry args={[2.1, 0.05, 0.08]} />
          <meshStandardMaterial
            color="#E7F1FF"
            emissive={accent}
            emissiveIntensity={1.55}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* desk + keyboard */}
      <mesh castShadow position={[0, 0.66, -0.52]}>
        <boxGeometry args={[1.5, 0.06, 0.62]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>
      {[-0.62, 0.62].map((x) => (
        <mesh key={x} position={[x, 0.42, -0.52]}>
          <boxGeometry args={[0.07, 0.42, 0.07]} />
          <meshStandardMaterial {...materials.robotJoint} />
        </mesh>
      ))}
      <mesh position={[0, 0.98, -0.74]} rotation={[-0.16, 0, 0]}>
        <boxGeometry args={[0.72, 0.44, 0.035]} />
        <meshStandardMaterial {...materials.screen} emissive={accent} emissiveIntensity={1.5} />
      </mesh>
      <mesh position={[0, 0.7, -0.28]}>
        <boxGeometry args={[0.5, 0.025, 0.16]} />
        <meshStandardMaterial color="#F4F8FF" emissive={accent} emissiveIntensity={0.8} />
      </mesh>
      <mesh position={[0.62, 0.76, -0.48]}>
        <sphereGeometry args={[0.06, 14, 14]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={2.3} toneMapped={false} />
      </mesh>

      {/* server rack + planter dress the corners */}
      <group position={[0.96, 0, -0.86]}>
        <mesh castShadow position={[0, 0.52, 0]}>
          <boxGeometry args={[0.4, 1.04, 0.36]} />
          <meshStandardMaterial color="#101326" metalness={0.5} roughness={0.55} />
        </mesh>
        {[0.24, 0.46, 0.68, 0.88].map((y) => (
          <mesh key={y} position={[0, y, 0.19]}>
            <boxGeometry args={[0.28, 0.045, 0.02]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={1.5}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      <group position={[-0.98, 0, 0.86]}>
        <mesh castShadow position={[0, 0.28, 0]}>
          <cylinderGeometry args={[0.15, 0.18, 0.22, 10]} />
          <meshStandardMaterial {...materials.concrete} />
        </mesh>
        {[0, 1, 2].map((leaf) => (
          <mesh
            key={leaf}
            position={[Math.cos(leaf * 2.1) * 0.06, 0.46 + leaf * 0.05, Math.sin(leaf * 2.1) * 0.06]}
            rotation={[0.35, leaf * 2.1, 0]}
          >
            <coneGeometry args={[0.1, 0.3, 5]} />
            <meshStandardMaterial color="#3FBF8F" emissive={accent} emissiveIntensity={0.22} roughness={0.7} />
          </mesh>
        ))}
      </group>

      {/* floor accent inlay + open-edge railing */}
      <mesh position={[0, 0.02, 0.42]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.62, 0.72, 40]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={tone === "error" ? 0.32 : 0.82}
          opacity={0.62}
          toneMapped={false}
          transparent
        />
      </mesh>
      {[-0.86, -0.29, 0.29, 0.86].map((x) => (
        <mesh key={x} position={[x, 0.26, 1.1]}>
          <boxGeometry args={[0.04, 0.52, 0.04]} />
          <meshStandardMaterial {...materials.robotJoint} />
        </mesh>
      ))}
      <mesh position={[0, 0.52, 1.1]}>
        <boxGeometry args={[2.1, 0.04, 0.04]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.85}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/**
 * The robot itself. Geometry, proportions and materials intentionally match
 * `map/AgentAvatar` (capsule torso, spherical head, emissive visor, hover skirt,
 * ground halo) so both modules read as the same character set.
 */
function RobotUnit({
  accent,
  index,
  selected,
  tone,
}: {
  accent: string;
  index: number;
  selected: boolean;
  tone: RobotTone;
}) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const thruster = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const scan = useRef<THREE.Mesh>(null);
  const stride = useRef(0);

  // active = typing at the desk, busy = patrolling the pod, error = powered down.
  const patrolling = tone === "busy";
  const seated = tone === "active" || tone === "done";
  const offline = tone === "error";

  useFrame(({ clock }, delta) => {
    const step = THREE.MathUtils.clamp(delta, 0, 0.08);
    const time = clock.elapsedTime + index * 0.83;
    const motion = offline ? 0 : patrolling ? 0.72 : 0;

    stride.current += step * (2.2 + motion * 6.4);

    if (root.current) {
      const sway = patrolling ? Math.sin(time * 0.7) * 0.44 : 0;
      root.current.position.set(sway, 0, patrolling ? Math.cos(time * 0.52) * 0.16 : 0.12);
      root.current.rotation.y = patrolling ? Math.sin(time * 0.7) * 0.5 : 0;
    }

    if (body.current) {
      const bob = Math.sin(stride.current * 2) * 0.035 * motion;
      const idleFloat = Math.sin(time * 1.5) * 0.022 * (1 - motion);
      const typing = seated ? Math.sin(time * 10) * 0.006 : 0;
      body.current.position.y = 0.34 + bob + idleFloat + typing;
      body.current.rotation.x = motion * 0.14 + (seated ? 0.1 : 0);
      body.current.rotation.z = Math.sin(stride.current) * 0.05 * motion;
    }

    if (leftArm.current && rightArm.current) {
      const swing = Math.sin(stride.current) * 0.55 * motion;
      const keyTap = seated ? Math.sin(time * 16) * 0.09 : 0;
      const reach = seated ? -0.5 : 0;
      leftArm.current.rotation.x = swing + reach + keyTap;
      rightArm.current.rotation.x = -swing + reach - keyTap;
      leftArm.current.rotation.z = seated ? 0.2 : 0;
      rightArm.current.rotation.z = seated ? -0.2 : 0;
    }

    if (leftLeg.current && rightLeg.current) {
      const legSwing = Math.sin(stride.current + Math.PI / 2) * 0.5 * motion;
      leftLeg.current.rotation.x = -legSwing;
      rightLeg.current.rotation.x = legSwing;
    }

    if (head.current) {
      head.current.rotation.z = offline ? 0.22 : Math.sin(time * 1.2) * 0.1 * (1 - motion);
      head.current.rotation.x = seated ? 0.14 : motion * -0.06;
    }

    if (thruster.current) {
      const material = thruster.current.material as THREE.MeshBasicMaterial;
      material.opacity = offline ? 0.04 : 0.12 + motion * 0.55;
      thruster.current.scale.setScalar(0.58 + motion * 0.55);
    }

    if (halo.current) {
      const material = halo.current.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = offline ? 0.5 : 1.4 + Math.sin(time * 2.2) * 0.5;
      halo.current.rotation.z = time * (0.4 + motion * 1.6);
    }

    if (scan.current) {
      scan.current.visible = tone === "done";
      if (scan.current.visible) {
        scan.current.rotation.z = time * 1.6;
        scan.current.scale.setScalar(0.85 + Math.sin(time * 2.6) * 0.16);
      }
    }
  });

  const shellColor = offline ? "#9aa2bb" : materials.robotShell.color;

  return (
    <group ref={root} scale={selected ? 1.62 : 1.5}>
      {/* ground contact glow keeps the robot anchored to the deck */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.32, 28]} />
        <meshBasicMaterial color="#DCD6EE" opacity={0.3} transparent />
      </mesh>
      <mesh position={[0, 0.03, 0]} ref={halo} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.3, 0.4, 32]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={1.6}
          opacity={0.75}
          toneMapped={false}
          transparent
        />
      </mesh>

      <group position={[0, 0.34, 0]} ref={body}>
        {/* hover skirt */}
        <mesh position={[0, -0.16, 0]} ref={thruster} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.2, 20]} />
          <meshBasicMaterial color={accent} opacity={0.4} toneMapped={false} transparent />
        </mesh>

        <mesh castShadow position={[0, 0.02, 0]}>
          <capsuleGeometry args={[0.155, 0.24, 8, 18]} />
          <meshStandardMaterial
            color={shellColor}
            metalness={materials.robotShell.metalness}
            roughness={materials.robotShell.roughness}
          />
        </mesh>
        <mesh castShadow position={[0, 0.19, 0]}>
          <boxGeometry args={[0.34, 0.08, 0.18]} />
          <meshStandardMaterial color="#EEF6FF" metalness={0.18} roughness={0.36} />
        </mesh>
        <mesh position={[0, 0.02, 0.13]}>
          <boxGeometry args={[0.14, 0.14, 0.03]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={offline ? 0.4 : 1.9}
            toneMapped={false}
          />
        </mesh>

        <group position={[-0.19, 0.1, 0]} ref={leftArm}>
          <mesh castShadow position={[0, -0.1, 0]}>
            <capsuleGeometry args={[0.042, 0.18, 4, 10]} />
            <meshStandardMaterial
              color={shellColor}
              metalness={materials.robotShell.metalness}
              roughness={materials.robotShell.roughness}
            />
          </mesh>
          <mesh castShadow position={[0, -0.22, 0.035]}>
            <sphereGeometry args={[0.045, 12, 10]} />
            <meshStandardMaterial color="#F0C4A8" roughness={0.62} />
          </mesh>
        </group>
        <group position={[0.19, 0.1, 0]} ref={rightArm}>
          <mesh castShadow position={[0, -0.1, 0]}>
            <capsuleGeometry args={[0.042, 0.18, 4, 10]} />
            <meshStandardMaterial
              color={shellColor}
              metalness={materials.robotShell.metalness}
              roughness={materials.robotShell.roughness}
            />
          </mesh>
          <mesh castShadow position={[0, -0.22, 0.035]}>
            <sphereGeometry args={[0.045, 12, 10]} />
            <meshStandardMaterial color="#F0C4A8" roughness={0.62} />
          </mesh>
        </group>

        <group position={[-0.08, -0.18, 0.02]} ref={leftLeg}>
          <mesh castShadow position={[0, -0.07, 0]}>
            <capsuleGeometry args={[0.035, 0.16, 4, 9]} />
            <meshStandardMaterial {...materials.robotJoint} />
          </mesh>
          <mesh castShadow position={[0, -0.17, 0.045]}>
            <boxGeometry args={[0.09, 0.035, 0.14]} />
            <meshStandardMaterial
              color={shellColor}
              metalness={materials.robotShell.metalness}
              roughness={materials.robotShell.roughness}
            />
          </mesh>
        </group>
        <group position={[0.08, -0.18, 0.02]} ref={rightLeg}>
          <mesh castShadow position={[0, -0.07, 0]}>
            <capsuleGeometry args={[0.035, 0.16, 4, 9]} />
            <meshStandardMaterial {...materials.robotJoint} />
          </mesh>
          <mesh castShadow position={[0, -0.17, 0.045]}>
            <boxGeometry args={[0.09, 0.035, 0.14]} />
            <meshStandardMaterial
              color={shellColor}
              metalness={materials.robotShell.metalness}
              roughness={materials.robotShell.roughness}
            />
          </mesh>
        </group>

        <group position={[0, 0.34, 0]} ref={head}>
          <mesh castShadow position={[0, 0.02, 0]}>
            <sphereGeometry args={[0.18, 24, 18]} />
            <meshStandardMaterial color="#F0C4A8" metalness={0.04} roughness={0.58} />
          </mesh>
          <mesh castShadow position={[0, 0.11, -0.05]} scale={[1, 0.42, 0.82]}>
            <sphereGeometry args={[0.19, 18, 12]} />
            <meshStandardMaterial color="#16182B" metalness={0.18} roughness={0.44} />
          </mesh>
          <mesh position={[0, 0.025, 0.158]}>
            <boxGeometry args={[0.23, 0.075, 0.026]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={offline ? 0.5 : 2.6}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0.18, 0.025, 0.025]}>
            <sphereGeometry args={[0.035, 10, 10]} />
            <meshStandardMaterial color="#22253B" emissive={accent} emissiveIntensity={0.55} />
          </mesh>
          <mesh position={[0.21, -0.025, 0.105]} rotation={[0, 0.36, -0.2]}>
            <cylinderGeometry args={[0.01, 0.01, 0.16, 6]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={offline ? 0.4 : 2.3}
              toneMapped={false}
            />
          </mesh>
        </group>
      </group>

      <mesh position={[0, 0.06, 0]} ref={scan} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <torusGeometry args={[0.36, 0.012, 8, 40]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={2.4}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function accentFor(robot: RobotArenaNode): string {
  return robot.status === "missing" ? "#8f88aa" : robot.accent;
}

function robotTone(status: RobotArenaNode["status"]): RobotTone {
  if (status === "missing") return "error";
  return statusTone[status];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
