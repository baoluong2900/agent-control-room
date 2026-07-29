import { Grid } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { AgentStatus } from "@contracts";
import { findRoute } from "./agent-nav";
import { AgentAvatar } from "./AgentAvatar";
import { EnginePlaza, RoadNetwork, ZoneModule } from "./WorkspaceCity";
import {
  agents,
  dockNodeId,
  navNodeById,
  palette,
  statusAssignments,
  workflowPaths,
  zoneById,
  zones,
} from "./scene-config";

/** Low-profile data flow above the physical roads. */
function DataConduit({
  accent,
  curve,
  delay,
}: {
  accent: string;
  curve: THREE.CatmullRomCurve3;
  delay: number;
}) {
  const pulse = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.MeshStandardMaterial>(null);
  const geometry = useMemo(() => new THREE.TubeGeometry(curve, 44, 0.02, 6, false), [curve]);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;
    if (pulse.current) pulse.current.position.copy(curve.getPointAt((time * 0.12 + delay) % 1));
    if (glow.current) glow.current.emissiveIntensity = 1.05 + Math.sin(time * 1.8 + delay * 5) * 0.28;
  });

  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={1.15}
          opacity={0.32}
          ref={glow}
          toneMapped={false}
          transparent
        />
      </mesh>
      <mesh ref={pulse}>
        <sphereGeometry args={[0.075, 12, 12]} />
        <meshStandardMaterial
          color="#FFFFFF"
          emissive={accent}
          emissiveIntensity={3.2}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function DataFlowLayer() {
  const curves = useMemo(
    () =>
      workflowPaths.flatMap((path) => {
        const from = zoneById.get(path.from);
        const to = zoneById.get(path.to);
        if (!from || !to) return [];

        // Follow the road graph so conduits trace the streets, not the rooftops.
        const route = findRoute(dockNodeId(path.from), dockNodeId(path.to));
        const points = route.map((id) => {
          const node = navNodeById.get(id);
          return new THREE.Vector3(node?.position[0] ?? 0, 0.09, node?.position[2] ?? 0);
        });

        if (points.length < 2) return [];

        return [
          {
            accent: path.accent,
            curve: new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.3),
            key: `${path.from}-${path.to}`,
          },
        ];
      }),
    [],
  );

  return (
    <group>
      {curves.map((item, index) => (
        <DataConduit
          accent={item.accent}
          curve={item.curve}
          delay={index / curves.length}
          key={item.key}
        />
      ))}
    </group>
  );
}

function CircuitFloorPlate() {
  const floorNodes = useMemo(
    () =>
      zones
        .filter((zone) => zone.id !== "engine")
        .map((zone) => {
          const distance = Math.hypot(zone.position[0], zone.position[2]) || 1;
          const angle = Math.atan2(zone.position[0], zone.position[2]);
          return {
            accent: zone.accent,
            angle,
            distance,
            key: zone.id,
          };
        }),
    [],
  );

  return (
    <group position={[0, -1.38, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[11.8, 6]} />
        <meshStandardMaterial
          color="#0A1727"
          depthWrite={false}
          metalness={0.28}
          opacity={0.52}
          roughness={0.88}
          transparent
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.05, 10.85, 6]} />
        <meshBasicMaterial color="#18385F" opacity={0.22} toneMapped={false} transparent />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[3.85, 9.35, 6]} />
        <meshBasicMaterial color={palette.cyan} opacity={0.08} toneMapped={false} transparent />
      </mesh>

      {floorNodes.map((node) => (
        <group key={node.key} rotation-y={node.angle}>
          <mesh position={[0, 0.01, node.distance * 0.41]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.12, node.distance * 0.82]} />
            <meshBasicMaterial color={node.accent} opacity={0.18} toneMapped={false} transparent />
          </mesh>
          <mesh position={[0, 0.018, node.distance * 0.42]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.06, 0.15, 12]} />
            <meshBasicMaterial color={node.accent} opacity={0.8} toneMapped={false} transparent />
          </mesh>
        </group>
      ))}

      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.9, 3.2, 6]} />
        <meshBasicMaterial color={palette.core} opacity={0.24} toneMapped={false} transparent />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[4.4, 10.2, 6]} />
        <meshBasicMaterial color="#274C7E" opacity={0.12} toneMapped={false} transparent />
      </mesh>
    </group>
  );
}

/** Floating substructure beneath the map adds depth without blocking the walkways. */
function CityFoundation() {
  const rings = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (rings.current) rings.current.rotation.y = clock.elapsedTime * 0.035;
  });

  return (
    <group>
      <group position={[0, -1.62, 0]} ref={rings}>
        {[8.8, 10.8, 12.6].map((radius, index) => (
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
        <circleGeometry args={[14.4, 48]} />
        <meshBasicMaterial color="#050A13" opacity={0.48} transparent />
      </mesh>
    </group>
  );
}

export function WorkspaceScene({
  activeStatus,
  onSelectZone,
  selectedZone,
}: {
  activeStatus: AgentStatus;
  onSelectZone: (zone: string) => void;
  selectedZone: string;
}) {
  const assignments = statusAssignments[activeStatus] ?? statusAssignments.idle;
  const activeZoneIds = useMemo(
    () => new Set(Object.values(assignments).map((assignment) => assignment.zoneId)),
    [assignments],
  );

  return (
    <group position={[0, -0.55, 0]}>
      <Grid
        args={[40, 40]}
        cellColor="#163A5E"
        cellSize={1}
        cellThickness={0.22}
        fadeDistance={24}
        fadeStrength={2.4}
        infiniteGrid
        position={[0, -1.7, 0]}
        sectionColor="#2A87D4"
        sectionSize={4}
        sectionThickness={0.48}
      />

      <CircuitFloorPlate />
      <CityFoundation />
      <RoadNetwork />
      <DataFlowLayer />

      <EnginePlaza
        isSelected={selectedZone === "engine"}
        onSelect={() => onSelectZone("engine")}
      />

      {zones
        .filter((zone) => zone.id !== "engine")
        .map((zone) => (
          <ZoneModule
            isActive={activeZoneIds.has(zone.id)}
            isSelected={selectedZone === zone.id}
            key={zone.id}
            onSelect={() => onSelectZone(zone.id)}
            zone={zone}
          />
        ))}

      {agents.map((agent) => (
        <AgentAvatar
          agent={agent}
          assignment={assignments[agent.id] ?? {
            state: agent.state,
            zoneId: agent.homeZone,
          }}
          key={agent.id}
          showLabel={activeStatus !== "idle"}
        />
      ))}
    </group>
  );
}
