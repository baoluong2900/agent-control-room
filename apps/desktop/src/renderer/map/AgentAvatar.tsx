import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { AgentWalker, dampAngle } from "./agent-nav";
import {
  materials,
  zoneById,
  type AgentAssignment,
  type AgentConfig,
  type AgentState,
  type ZoneConfig,
} from "./scene-config";

const patrolZones = new Set(["testing", "deployment"]);
const deskStates = new Set<AgentState>(["thinking", "working", "reviewing"]);

function shouldPatrol(assignment: AgentAssignment): boolean {
  return (
    assignment.state === "moving" ||
    (patrolZones.has(assignment.zoneId) &&
      (assignment.state === "testing" || assignment.state === "deploying" || assignment.state === "complete"))
  );
}

function isDeskState(state: AgentState): boolean {
  return deskStates.has(state);
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function hashAgentId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function setStationOffset(target: THREE.Vector3, agent: AgentConfig, zone: ZoneConfig): THREE.Vector3 {
  const seed = hashAgentId(agent.id);
  const radial = new THREE.Vector3(zone.position[0], 0, zone.position[2]);

  if (radial.lengthSq() < 1e-6) {
    const angle = (seed % 360) * THREE.MathUtils.DEG2RAD;
    radial.set(Math.cos(angle), 0, Math.sin(angle));
  } else {
    radial.normalize();
  }

  const tangent = new THREE.Vector3(-radial.z, 0, radial.x);
  const depth = ((seed % 5) - 2) * 0.16;
  const roleBias = agent.variant === "monitor" ? -0.16 : agent.variant === "deployer" ? 0.22 : 0;

  return target
    .copy(tangent)
    .multiplyScalar(agent.lane * 0.74)
    .addScaledVector(radial, 0.5 + depth + roleBias);
}

function AgentVariantKit({
  accent,
  variant,
}: {
  accent: string;
  variant: AgentConfig["variant"];
}) {
  const glowMaterial = {
    color: accent,
    emissive: accent,
    emissiveIntensity: 2.1,
    toneMapped: false,
  } as const;

  if (variant === "planner") {
    return (
      <group>
        <mesh position={[0, 0.58, -0.01]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.18, 0.012, 8, 28]} />
          <meshStandardMaterial {...glowMaterial} />
        </mesh>
        <mesh position={[0, 0.68, 0]}>
          <coneGeometry args={[0.052, 0.12, 5]} />
          <meshStandardMaterial {...glowMaterial} />
        </mesh>
      </group>
    );
  }

  if (variant === "coder") {
    return (
      <group>
        <mesh castShadow position={[0, 0.02, -0.19]}>
          <boxGeometry args={[0.24, 0.26, 0.08]} />
          <meshStandardMaterial {...materials.darkMetal} />
        </mesh>
        {[-0.15, 0.15].map((x) => (
          <mesh key={x} position={[x, -0.05, -0.18]}>
            <boxGeometry args={[0.055, 0.12, 0.04]} />
            <meshStandardMaterial {...glowMaterial} />
          </mesh>
        ))}
      </group>
    );
  }

  if (variant === "reviewer") {
    return (
      <group>
        <mesh position={[0.31, 0.1, 0.11]} rotation={[0.12, -0.34, -0.18]}>
          <boxGeometry args={[0.18, 0.26, 0.025]} />
          <meshStandardMaterial {...materials.screen} emissive={accent} emissiveIntensity={1.9} />
        </mesh>
        <mesh position={[0.31, 0.1, 0.126]} rotation={[0.12, -0.34, -0.18]}>
          <boxGeometry args={[0.11, 0.035, 0.01]} />
          <meshStandardMaterial {...glowMaterial} />
        </mesh>
      </group>
    );
  }

  if (variant === "tester") {
    return (
      <group>
        <mesh position={[0, 0.58, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.2, 0.012, 8, 32]} />
          <meshStandardMaterial {...glowMaterial} />
        </mesh>
        {[-0.19, 0.19].map((x) => (
          <mesh key={x} position={[x, 0.34, 0.09]}>
            <sphereGeometry args={[0.045, 12, 12]} />
            <meshStandardMaterial {...glowMaterial} />
          </mesh>
        ))}
      </group>
    );
  }

  if (variant === "deployer") {
    return (
      <group>
        {[-0.09, 0.09].map((x) => (
          <group key={x} position={[x, -0.02, -0.2]}>
            <mesh castShadow>
              <cylinderGeometry args={[0.04, 0.045, 0.24, 12]} />
              <meshStandardMaterial {...materials.darkMetal} />
            </mesh>
            <mesh position={[0, -0.16, 0]}>
              <coneGeometry args={[0.055, 0.11, 12]} />
              <meshStandardMaterial {...glowMaterial} />
            </mesh>
          </group>
        ))}
        <mesh position={[0, 0.16, -0.21]}>
          <boxGeometry args={[0.18, 0.08, 0.045]} />
          <meshStandardMaterial {...glowMaterial} />
        </mesh>
      </group>
    );
  }

  return (
    <group>
      <mesh position={[0.2, 0.33, -0.03]} rotation={[0.65, 0, -0.25]} scale={[1, 0.34, 1]}>
        <sphereGeometry args={[0.12, 18, 10]} />
        <meshStandardMaterial {...materials.darkMetal} emissive={accent} emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0.28, 0.4, 0.04]}>
        <sphereGeometry args={[0.032, 10, 10]} />
        <meshStandardMaterial {...glowMaterial} />
      </mesh>
    </group>
  );
}

/**
 * One agent. Position comes from the nav walker (real route, constant speed);
 * the body only adds a small stride bob while actually moving, so a parked agent
 * is visually calm. Testing and deployment agents also patrol their rooms, so
 * those zones read as staffed rather than dotted with static markers.
 */
export function AgentAvatar({
  agent,
  assignment,
  showLabel,
}: {
  agent: AgentConfig;
  assignment: AgentAssignment;
  showLabel: boolean;
}) {
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const deskRig = useRef<THREE.Group>(null);
  const chairRig = useRef<THREE.Group>(null);
  const thruster = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const scan = useRef<THREE.Mesh>(null);

  const walker = useMemo(() => {
    const zone = zoneById.get(agent.homeZone);
    const yaw = zone ? Math.atan2(-zone.position[0], -zone.position[2]) : 0;
    return new AgentWalker(agent.homeZone, agent.lane, yaw);
  }, [agent.homeZone, agent.lane]);

  const stride = useRef(0);
  const glide = useRef(0);
  const patrolAxis = useRef(new THREE.Vector3(1, 0, 0));
  const patrolPosition = useRef(new THREE.Vector3());
  const patrolYaw = useRef(0);
  const sit = useRef(0);
  const stationOffset = useRef(new THREE.Vector3());

  useFrame(({ clock }, delta) => {
    const step = THREE.MathUtils.clamp(delta, 0, 0.08);
    const time = clock.elapsedTime;

    walker.setTarget(assignment.zoneId);
    const sample = walker.update(step);

    // Smooth the moving/parked blend so animation layers cross-fade.
    glide.current = THREE.MathUtils.damp(glide.current, sample.speed, 6, step);
    const routeMotion = glide.current;
    let motion = routeMotion;
    const renderPosition = patrolPosition.current.copy(sample.position);
    const zone = zoneById.get(assignment.zoneId);
    const stationBlend = 1 - THREE.MathUtils.clamp(routeMotion / 0.28, 0, 1);

    if (zone && stationBlend > 0) {
      renderPosition.addScaledVector(setStationOffset(stationOffset.current, agent, zone), stationBlend);
    }

    let yaw = sample.yaw;
    const patrol = routeMotion < 0.08 && shouldPatrol(assignment);
    if (patrol && zone) {
      const axis = patrolAxis.current.set(-zone.position[2], 0, zone.position[0]);
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
      axis.normalize();

      const phase = time * (0.68 + Math.abs(agent.lane) * 0.08) + agent.lane * 2.7;
      const amplitude = assignment.zoneId === "deployment" ? 0.86 : 0.72;
      const direction = Math.cos(phase) >= 0 ? 1 : -1;

      renderPosition.addScaledVector(axis, Math.sin(phase) * amplitude);
      patrolYaw.current = dampAngle(
        patrolYaw.current,
        Math.atan2(axis.x * direction, axis.z * direction),
        4.8,
        step,
      );
      yaw = patrolYaw.current;
      motion = Math.max(motion, 0.38 + Math.abs(Math.cos(phase)) * 0.45);
    } else if (routeMotion < 0.08) {
      // Parked: look at the workstation on the platform, not at the camera.
      const focusX = zone ? zone.position[0] * 1.14 : 0;
      const focusZ = zone ? zone.position[2] * 1.14 : 0;
      yaw = walker.faceTowards(focusX, focusZ, step);
      patrolYaw.current = yaw;
    }

    const seated = routeMotion < 0.12 && !patrol && isDeskState(assignment.state);
    sit.current = THREE.MathUtils.damp(sit.current, seated ? 1 : 0, 8, step);
    const sitAmount = sit.current;

    if (deskRig.current) {
      deskRig.current.visible = sitAmount > 0.04;
      deskRig.current.scale.setScalar(0.72 + sitAmount * 0.28);
    }

    if (chairRig.current) {
      chairRig.current.visible = sitAmount > 0.04;
      chairRig.current.scale.setScalar(0.76 + sitAmount * 0.24);
    }

    if (root.current) {
      root.current.position.set(renderPosition.x, 0, renderPosition.z);
      root.current.rotation.y = yaw;
    }

    if (body.current) {
      stride.current += step * (2.2 + motion * 6.4);
      const bob = Math.sin(stride.current * 2) * 0.035 * motion;
      const idleFloat = Math.sin(time * 1.5 + agent.lane * 6) * 0.022 * (1 - motion);
      const typingFloat = Math.sin(time * 10 + agent.lane) * 0.006 * sitAmount;

      body.current.position.y = mix(0.34 + bob + idleFloat, 0.26 + typingFloat, sitAmount);
      // Lean into the direction of travel instead of wobbling in place.
      body.current.rotation.x = mix(motion * 0.14, 0.12, sitAmount);
      body.current.rotation.z = Math.sin(stride.current) * 0.05 * motion * (1 - sitAmount);
    }

    if (leftArm.current && rightArm.current) {
      const swing = Math.sin(stride.current) * 0.55 * motion;
      const typing =
        assignment.state === "working" || assignment.state === "reviewing"
          ? 0.5 + Math.sin(time * 7 + agent.lane) * 0.16
          : 0;
      const keyTap = Math.sin(time * 16 + agent.lane * 3) * 0.09;

      leftArm.current.position.set(mix(-0.19, -0.15, sitAmount), mix(0.1, 0.02, sitAmount), mix(0, 0.16, sitAmount));
      rightArm.current.position.set(mix(0.19, 0.15, sitAmount), mix(0.1, 0.02, sitAmount), mix(0, 0.16, sitAmount));
      leftArm.current.rotation.x = mix(swing - typing * (1 - motion), -0.52 + keyTap, sitAmount);
      rightArm.current.rotation.x = mix(-swing - typing * (1 - motion), -0.52 - keyTap, sitAmount);
      leftArm.current.rotation.z = sitAmount * 0.22;
      rightArm.current.rotation.z = sitAmount * -0.22;
    }

    if (leftLeg.current && rightLeg.current) {
      const legSwing = Math.sin(stride.current + Math.PI / 2) * 0.5 * motion;
      leftLeg.current.position.set(-0.08, mix(-0.18, -0.12, sitAmount), mix(0.02, 0.13, sitAmount));
      rightLeg.current.position.set(0.08, mix(-0.18, -0.12, sitAmount), mix(0.02, 0.13, sitAmount));
      leftLeg.current.rotation.x = mix(-legSwing, 0.9, sitAmount);
      rightLeg.current.rotation.x = mix(legSwing, 0.9, sitAmount);
    }

    if (head.current) {
      const thinking = assignment.state === "thinking" ? Math.sin(time * 1.2) * 0.18 : 0;
      head.current.rotation.z = thinking * (1 - motion) * (1 - sitAmount);
      head.current.rotation.x =
        mix((assignment.state === "working" ? 0.16 : 0) * (1 - motion) + motion * -0.06, 0.14, sitAmount);
    }

    if (thruster.current) {
      const material = thruster.current.material as THREE.MeshBasicMaterial;
      material.opacity = 0.12 + routeMotion * 0.55 + (motion - routeMotion) * 0.16;
      thruster.current.scale.setScalar(0.58 + motion * 0.55);
    }

    if (halo.current) {
      const material = halo.current.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = 1.4 + Math.sin(time * 2.2 + agent.lane * 3) * 0.5;
      halo.current.rotation.z = time * (0.4 + motion * 1.6);
    }

    if (scan.current) {
      const active = assignment.state === "testing" || assignment.state === "deploying";
      scan.current.visible = active && routeMotion < 0.4;
      if (active) {
        scan.current.rotation.z = time * 1.6;
        scan.current.scale.setScalar(0.85 + Math.sin(time * 2.6) * 0.16);
      }
    }
  });

  const blocked = assignment.state === "blocked";
  const accent = blocked ? "#FCA5A5" : agent.accent;

  return (
    <group ref={root} scale={1.55}>
      {/* ground contact glow keeps the agent anchored to the road */}
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

      <group position={[0, 0, -0.2]} ref={chairRig} visible={false}>
        <mesh castShadow position={[0, 0.17, 0]}>
          <boxGeometry args={[0.34, 0.08, 0.34]} />
          <meshStandardMaterial {...materials.robotJoint} />
        </mesh>
        <mesh castShadow position={[0, 0.4, -0.14]}>
          <boxGeometry args={[0.36, 0.4, 0.07]} />
          <meshStandardMaterial color="#D9D3EE" metalness={0.28} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.04, 0]}>
          <cylinderGeometry args={[0.04, 0.04, 0.18, 8]} />
          <meshStandardMaterial {...materials.darkMetal} />
        </mesh>
      </group>

      <group position={[0, 0, 0.52]} ref={deskRig} visible={false}>
        <mesh castShadow position={[0, 0.29, 0.19]}>
          <boxGeometry args={[0.7, 0.06, 0.4]} />
          <meshStandardMaterial {...materials.darkMetal} />
        </mesh>
        <mesh position={[0, 0.51, 0.04]} rotation={[-0.2, 0, 0]}>
          <boxGeometry args={[0.54, 0.32, 0.035]} />
          <meshStandardMaterial {...materials.screen} emissive={accent} emissiveIntensity={1.8} />
        </mesh>
        <mesh position={[0, 0.32, 0.3]}>
          <boxGeometry args={[0.46, 0.025, 0.14]} />
          <meshStandardMaterial color="#F4F8FF" emissive={accent} emissiveIntensity={0.8} />
        </mesh>
        {[-0.14, 0, 0.14].map((x) => (
          <mesh key={x} position={[x, 0.338, 0.345]}>
            <boxGeometry args={[0.08, 0.018, 0.018]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={2.4} toneMapped={false} />
          </mesh>
        ))}
      </group>

      <group position={[0, 0.34, 0]} ref={body}>
        {/* hover skirt */}
        <mesh position={[0, -0.16, 0]} ref={thruster} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.2, 20]} />
          <meshBasicMaterial color={accent} opacity={0.4} toneMapped={false} transparent />
        </mesh>

        <mesh castShadow position={[0, 0.02, 0]}>
          <capsuleGeometry args={[0.155, 0.24, 8, 18]} />
          <meshStandardMaterial {...materials.robotShell} />
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
            emissiveIntensity={1.9}
            toneMapped={false}
          />
        </mesh>

        <AgentVariantKit accent={accent} variant={agent.variant} />

        <group position={[-0.19, 0.1, 0]} ref={leftArm}>
          <mesh castShadow position={[0, -0.1, 0]}>
            <capsuleGeometry args={[0.042, 0.18, 4, 10]} />
            <meshStandardMaterial {...materials.robotShell} />
          </mesh>
          <mesh castShadow position={[0, -0.22, 0.035]}>
            <sphereGeometry args={[0.045, 12, 10]} />
            <meshStandardMaterial color="#F0C4A8" roughness={0.62} />
          </mesh>
        </group>
        <group position={[0.19, 0.1, 0]} ref={rightArm}>
          <mesh castShadow position={[0, -0.1, 0]}>
            <capsuleGeometry args={[0.042, 0.18, 4, 10]} />
            <meshStandardMaterial {...materials.robotShell} />
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
            <meshStandardMaterial {...materials.robotShell} />
          </mesh>
        </group>
        <group position={[0.08, -0.18, 0.02]} ref={rightLeg}>
          <mesh castShadow position={[0, -0.07, 0]}>
            <capsuleGeometry args={[0.035, 0.16, 4, 9]} />
            <meshStandardMaterial {...materials.robotJoint} />
          </mesh>
          <mesh castShadow position={[0, -0.17, 0.045]}>
            <boxGeometry args={[0.09, 0.035, 0.14]} />
            <meshStandardMaterial {...materials.robotShell} />
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
              emissiveIntensity={2.6}
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
              emissiveIntensity={2.3}
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

      {showLabel && (
        <Html center className="agent-tag" position={[0, 1.12, 0]} zIndexRange={[8, 5]}>
          <span className="agent-tag-inner" style={{ borderColor: `${accent}55` }}>
            <i style={{ background: accent }} />
            {agent.name}
            <small>{assignment.state}</small>
          </span>
        </Html>
      )}
    </group>
  );
}
