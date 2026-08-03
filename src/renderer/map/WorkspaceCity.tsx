import { Html, RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import {
  materials,
  navEdges,
  navNodeById,
  palette,
  zoneById,
  type ZoneConfig,
  type ZoneVariant,
} from "./scene-config";

/* ------------------------------------------------------------------ */
/* Roads                                                               */
/* ------------------------------------------------------------------ */

/** Every road segment is generated from the nav graph, so agents always walk on asphalt. */
export function RoadNetwork() {
  const segments = useMemo(
    () =>
      navEdges.flatMap(([a, b]) => {
        const from = navNodeById.get(a);
        const to = navNodeById.get(b);
        if (!from || !to) return [];

        // The plaza deck already covers the centre; drawing the spokes that end
        // at the middle produced a star-burst of overlapping strips.
        if (from.kind === "plaza" && to.kind === "plaza") return [];
        if (a === "plaza:engine" || b === "plaza:engine") return [];

        const start = new THREE.Vector3(...from.position);
        const end = new THREE.Vector3(...to.position);
        const middle = start.clone().lerp(end, 0.5);
        const length = start.distanceTo(end);
        if (length < 0.05) return [];
        const accent =
          zoneById.get(from.zoneId)?.accent ?? zoneById.get(to.zoneId)?.accent ?? palette.core;
        const markerCount = Math.max(2, Math.round(length / 1.85));

        return [
          {
            accent,
            angle: Math.atan2(end.x - start.x, end.z - start.z),
            key: `${a}->${b}`,
            length,
            markerCount,
            position: [middle.x, 0.012, middle.z] as [number, number, number],
          },
        ];
      }),
    [],
  );

  return (
    <group>
      {segments.map((segment) => (
        <group key={segment.key} position={segment.position} rotation-y={segment.angle}>
          <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.8, segment.length + 0.08]} />
            <meshStandardMaterial color="#07101C" metalness={0.3} roughness={0.7} />
          </mesh>
          <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.48, segment.length]} />
            <meshStandardMaterial {...materials.road} />
          </mesh>
          {/* glowing centre line */}
          <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.08, segment.length * 0.95]} />
            <meshStandardMaterial
              color={segment.accent}
              emissive={segment.accent}
              emissiveIntensity={0.92}
              opacity={0.42}
              toneMapped={false}
              transparent
            />
          </mesh>
          {Array.from({ length: segment.markerCount }).map((_, index) => {
            const t = segment.markerCount <= 1 ? 0.5 : index / (segment.markerCount - 1);
            const offset = -segment.length * 0.45 + segment.length * 0.9 * t;
            return (
              <mesh key={index} position={[0, 0.006, offset]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.07, 0.28]} />
                <meshStandardMaterial
                  color={segment.accent}
                  emissive={segment.accent}
                  emissiveIntensity={1.45}
                  opacity={0.36}
                  toneMapped={false}
                  transparent
                />
              </mesh>
            );
          })}
          {/* kerb glow */}
          {[-0.76, 0.76].map((x) => (
            <mesh key={x} position={[x, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[0.04, segment.length]} />
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
      ))}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Zone interiors                                                      */
/* ------------------------------------------------------------------ */

function DeskCluster({ accent, screens = 2 }: { accent: string; screens?: number }) {
  return (
    <group>
      <mesh castShadow position={[0, 0.72, -0.7]}>
        <boxGeometry args={[2, 0.07, 0.78]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>
      {[-0.85, 0.85].map((x) => (
        <mesh key={x} position={[x, 0.46, -0.7]}>
          <boxGeometry args={[0.08, 0.46, 0.08]} />
          <meshStandardMaterial {...materials.robotJoint} />
        </mesh>
      ))}
      {Array.from({ length: screens }).map((_, index) => {
        const spread = (index - (screens - 1) / 2) * 0.78;
        return (
          <mesh key={spread} position={[spread, 1.08, -1.02]} rotation={[-0.14, 0, 0]}>
            <boxGeometry args={[0.7, 0.44, 0.035]} />
            <meshStandardMaterial
              {...materials.screen}
              emissive={accent}
              emissiveIntensity={1.5}
            />
          </mesh>
        );
      })}
      <mesh position={[1.28, 0.84, -0.66]}>
        <sphereGeometry args={[0.075, 14, 14]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={2.3} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Planter({ accent, position }: { accent: string; position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh castShadow position={[0, 0.36, 0]}>
        <cylinderGeometry args={[0.17, 0.2, 0.24, 10]} />
        <meshStandardMaterial {...materials.concrete} />
      </mesh>
      {[0, 1, 2].map((index) => (
        <mesh
          key={index}
          position={[Math.cos(index * 2.1) * 0.07, 0.56 + index * 0.05, Math.sin(index * 2.1) * 0.07]}
          rotation={[0.35, index * 2.1, 0]}
        >
          <coneGeometry args={[0.11, 0.32, 5]} />
          <meshStandardMaterial color="#3FBF8F" emissive={accent} emissiveIntensity={0.22} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function Chair({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh castShadow position={[0, 0.34, 0]}>
        <boxGeometry args={[0.3, 0.05, 0.3]} />
        <meshStandardMaterial {...materials.robotJoint} />
      </mesh>
      <mesh castShadow position={[0, 0.53, -0.13]}>
        <boxGeometry args={[0.3, 0.34, 0.05]} />
        <meshStandardMaterial {...materials.robotJoint} />
      </mesh>
      <mesh position={[0, 0.16, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 0.32, 8]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.16, 0.16, 0.03, 10]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>
    </group>
  );
}

function ServerRack({ accent, position }: { accent: string; position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh castShadow position={[0, 0.62, 0]}>
        <boxGeometry args={[0.46, 1.24, 0.4]} />
        <meshStandardMaterial color="#101326" metalness={0.5} roughness={0.55} />
      </mesh>
      {[0.25, 0.5, 0.75, 1].map((y) => (
        <mesh key={y} position={[0, y, 0.21]}>
          <boxGeometry args={[0.34, 0.05, 0.02]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={1.5}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function ZoneInterior({ accent, variant }: { accent: string; variant: ZoneVariant }) {
  const spinner = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (spinner.current) spinner.current.rotation.y = clock.elapsedTime * 0.5;
  });

  const shell = (
    <group>
      {/* back and side walls with window mullions */}
      <mesh position={[0, 1.05, -1.9]} receiveShadow>
        <boxGeometry args={[4.7, 2.1, 0.1]} />
        <meshStandardMaterial color="#18253A" metalness={0.3} roughness={0.62} />
      </mesh>
      <mesh position={[-2.36, 1.05, 0]} receiveShadow>
        <boxGeometry args={[0.1, 2.1, 3.7]} />
        <meshStandardMaterial color="#132035" metalness={0.3} roughness={0.62} />
      </mesh>
      <mesh position={[0, 1.05, -1.83]}>
        <boxGeometry args={[4.5, 1.9, 0.03]} />
        <meshStandardMaterial {...materials.frostedGlass} />
      </mesh>
      {[-1.55, -0.5, 0.55, 1.6].map((x) => (
        <mesh key={x} position={[x, 1.05, -1.8]}>
          <boxGeometry args={[0.045, 1.9, 0.05]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={0.55}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* ceiling light strips */}
      {[-1.05, 0, 1.05].map((z) => (
        <mesh key={z} position={[0, 2.05, z]}>
          <boxGeometry args={[3.95, 0.05, 0.08]} />
          <meshStandardMaterial
            color="#E7F1FF"
            emissive={accent}
            emissiveIntensity={1.55}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* wall monitor array */}
      {[-1.3, -0.25, 0.8].map((x) => (
        <mesh key={x} position={[x, 1.45, -1.75]}>
          <boxGeometry args={[0.82, 0.5, 0.04]} />
          <meshStandardMaterial {...materials.screen} emissive={accent} emissiveIntensity={1.4} />
        </mesh>
      ))}

      {/* floor accent inlay */}
      <mesh position={[0, 0.02, 0.75]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.9, 1.02, 40]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.82}
          opacity={0.62}
          toneMapped={false}
          transparent
        />
      </mesh>

      {/* open-edge railing */}
      {[-1.6, -0.55, 0.5, 1.55].map((x) => (
        <mesh key={x} position={[x, 0.3, 1.82]}>
          <boxGeometry args={[0.045, 0.6, 0.045]} />
          <meshStandardMaterial {...materials.robotJoint} />
        </mesh>
      ))}
      <mesh position={[0, 0.6, 1.82]}>
        <boxGeometry args={[3.6, 0.04, 0.04]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.85}
          toneMapped={false}
        />
      </mesh>
    </group>
  );

  return (
    <group>
      {shell}
      <DeskCluster accent={accent} screens={variant === "lab" ? 3 : 2} />
      {/* second desk row so districts read as busy rooms */}
      <group position={[0, 0, 1.12]} rotation-y={Math.PI}>
        <DeskCluster accent={accent} screens={2} />
      </group>
      <Planter accent={accent} position={[1.9, 0, 1.35]} />
      <Planter accent={accent} position={[-1.95, 0, 1.4]} />
      <Chair position={[-0.6, 0, -0.15]} />
      <Chair position={[0.6, 0, -0.15]} />
      <Chair position={[-0.6, 0, 1.6]} />
      <ServerRack accent={accent} position={[1.85, 0, -1.25]} />

      {variant === "vault" && (
        <group position={[0, 0, 0.55]}>
          <mesh castShadow position={[0, 0.85, 0]}>
            <cylinderGeometry args={[0.42, 0.5, 0.9, 12]} />
            <meshStandardMaterial {...materials.darkMetal} />
          </mesh>
          <group ref={spinner}>
            <mesh position={[0, 1.6, 0]}>
              <icosahedronGeometry args={[0.3, 0]} />
              <meshStandardMaterial
                color={accent}
                emissive={accent}
                emissiveIntensity={2.4}
                toneMapped={false}
              />
            </mesh>
          </group>
          <mesh position={[0, 1.28, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.6, 8]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={1.6}
              opacity={0.5}
              toneMapped={false}
              transparent
            />
          </mesh>
        </group>
      )}

      {variant === "lab" && (
        <group position={[-1.15, 0, 0.9]}>
          {[0, 1, 2].map((index) => (
            <mesh castShadow key={index} position={[index * 0.32, 0.72 + index * 0.04, 0]}>
              <cylinderGeometry args={[0.1, 0.1, 0.44, 10]} />
              <meshStandardMaterial
                color="#BFF3FF"
                emissive={accent}
                emissiveIntensity={1.1}
                opacity={0.6}
                transparent
              />
            </mesh>
          ))}
        </group>
      )}

      {variant === "yard" && (
        <group position={[0.4, 0, 1]}>
          {[0, 1, 2, 3].map((index) => (
            <mesh
              castShadow
              key={index}
              position={[(index % 2) * 0.62 - 0.3, 0.72 + Math.floor(index / 2) * 0.5, 0]}
            >
              <boxGeometry args={[0.56, 0.46, 0.72]} />
              <meshStandardMaterial color="#172136" metalness={0.4} roughness={0.6} />
            </mesh>
          ))}
        </group>
      )}

      {variant === "ops" && (
        <group position={[0, 0, 0.7]}>
          {[-0.7, 0, 0.7].map((x, index) => (
            <mesh key={x} position={[x, 1.02 + index * 0.02, -0.2]} rotation={[-0.2, 0, 0]}>
              <boxGeometry args={[0.6, 0.36, 0.03]} />
              <meshStandardMaterial
                {...materials.screen}
                emissive={accent}
                emissiveIntensity={1.3}
              />
            </mesh>
          ))}
        </group>
      )}

      {variant === "office" && (
        <group position={[-1.4, 0, -0.2]}>
          <mesh castShadow position={[0, 0.95, 0]}>
            <boxGeometry args={[0.12, 1.5, 1.5]} />
            <meshStandardMaterial
              {...materials.screen}
              emissive={accent}
              emissiveIntensity={1.15}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Zone module                                                         */
/* ------------------------------------------------------------------ */

export function ZoneModule({
  isActive,
  isSelected,
  onSelect,
  zone,
}: {
  isActive: boolean;
  isSelected: boolean;
  onSelect: () => void;
  zone: ZoneConfig;
}) {
  const rim = useRef<THREE.Group>(null);
  const [width, depth] = zone.footprint;

  // Push signage outward, away from the plaza, so labels never sit on top of a
  // neighbouring district.
  const signOffset = useMemo<[number, number]>(() => {
    const length = Math.hypot(zone.position[0], zone.position[2]) || 1;
    return [(zone.position[0] / length) * 2.1, (zone.position[2] / length) * 2.1];
  }, [zone.position]);

  useFrame(({ clock }) => {
    if (!rim.current) return;
    const pulse = 0.85 + Math.sin(clock.elapsedTime * 1.5) * 0.16;
    const intensity = isSelected ? pulse + 1.25 : isActive ? pulse + 0.55 : pulse;

    for (const child of rim.current.children) {
      const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = intensity;
    }
  });

  return (
    <group position={zone.position} rotation-y={zone.rotationY} scale={zone.scale}>
      <RoundedBox
        args={[width, 0.44, depth]}
        castShadow
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        position={[0, -0.22, 0]}
        radius={0.12}
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

      {/* accent floor wash: gives every district its own colour identity */}
      <mesh position={[0, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width - 0.5, depth - 0.5]} />
        <meshStandardMaterial
          color={zone.accent}
          emissive={zone.accent}
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
        ].map((bar, index) => (
          <mesh key={index} position={bar.position}>
            <boxGeometry args={bar.args} />
            <meshStandardMaterial
              color={zone.accent}
              emissive={zone.accent}
              emissiveIntensity={1.1}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      {/* under-strut so the district reads as floating */}
      <mesh position={[0, -1.15, 0]}>
        <cylinderGeometry args={[Math.min(width, depth) * 0.28, 0.32, 1.5, 6]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>

      {/* facade trim on the two camera-facing sides */}
      {[
        {
          args: [width, 0.03, 0.05] as [number, number, number],
          position: [0, -0.4, depth / 2 + 0.01] as [number, number, number],
        },
        {
          args: [0.05, 0.03, depth] as [number, number, number],
          position: [width / 2 + 0.01, -0.4, 0] as [number, number, number],
        },
      ].map((bar, index) => (
        <mesh key={index} position={bar.position}>
          <boxGeometry args={bar.args} />
          <meshStandardMaterial
            color={zone.accent}
            emissive={zone.accent}
            emissiveIntensity={0.6}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* facade trim lines on the two camera-facing sides */}
      {[
        { args: [width, 0.03, 0.05] as [number, number, number], position: [0, -0.4, depth / 2 + 0.01] as [number, number, number] },
        { args: [0.05, 0.03, depth] as [number, number, number], position: [width / 2 + 0.01, -0.4, 0] as [number, number, number] },
      ].map((bar, index) => (
        <mesh key={index} position={bar.position}>
          <boxGeometry args={bar.args} />
          <meshStandardMaterial
            color={zone.accent}
            emissive={zone.accent}
            emissiveIntensity={0.6}
            toneMapped={false}
          />
        </mesh>
      ))}

      <ZoneInterior accent={zone.accent} variant={zone.variant} />

      <pointLight
        color={zone.accent}
        distance={4.6}
        intensity={1.15}
        position={[0.2, 1.55, 0.2]}
      />
      <pointLight color="#cfd9ff" distance={3.4} intensity={0.38} position={[-0.8, 1.5, -0.6]} />

      <Html
        center
        className="zone-signage"
        position={[signOffset[0], 2.95, signOffset[1]]}
        style={{ pointerEvents: "none" }}
        zIndexRange={[6, 4]}
      >
        <span
          className={`zone-signage-inner ${isSelected ? "is-selected" : ""} ${
            isActive ? "is-active" : ""
          }`}
          style={{ borderColor: `${zone.accent}44` }}
        >
          <strong style={{ color: zone.accent }}>{zone.title}</strong>
          <small>{zone.subtitle}</small>
        </span>
      </Html>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Plaza + engine core                                                 */
/* ------------------------------------------------------------------ */

export function EnginePlaza({
  isSelected,
  onSelect,
}: {
  isSelected: boolean;
  onSelect: () => void;
}) {
  const rings = useRef<THREE.Group>(null);
  const shard = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;

    if (rings.current) {
      rings.current.rotation.y = time * 0.3;
      rings.current.children.forEach((child, index) => {
        child.position.y = 1.55 + index * 0.3 + Math.sin(time * 1.4 + index) * 0.05;
        child.rotation.z = time * (0.2 + index * 0.12);
      });
    }

    if (shard.current) {
      shard.current.rotation.y = -time * 0.6;
      shard.current.position.y = 2.55 + Math.sin(time * 1.8) * 0.06;
    }
  });

  return (
    <group>
      {/* hex plaza deck */}
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        position={[0, 0.008, 0]}
        receiveShadow
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <circleGeometry args={[3.15, 6]} />
        <meshStandardMaterial {...materials.concrete} />
      </mesh>
      <mesh position={[0, 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.86, 2.98, 6]} />
        <meshStandardMaterial
          color={palette.core}
          emissive={palette.core}
          emissiveIntensity={isSelected ? 1.5 : 1}
          toneMapped={false}
        />
      </mesh>

      {/* pedestal */}
      <mesh castShadow position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.9, 1.15, 1.1, 6]} />
        <meshStandardMaterial {...materials.darkMetal} />
      </mesh>
      <mesh position={[0, 1.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.55, 0.85, 6]} />
        <meshStandardMaterial
          color={palette.cyan}
          emissive={palette.cyan}
          emissiveIntensity={2.1}
          toneMapped={false}
        />
      </mesh>

      <group ref={rings}>
        {[0, 1, 2].map((index) => (
          <mesh key={index} position={[0, 1.55 + index * 0.3, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.78 - index * 0.18, 0.026, 12, 56]} />
            <meshStandardMaterial
              color={index === 1 ? palette.core : palette.cyan}
              emissive={index === 1 ? palette.core : palette.cyan}
              emissiveIntensity={2.6}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      <mesh position={[0, 2.55, 0]} ref={shard}>
        <octahedronGeometry args={[0.3, 0]} />
        <meshStandardMaterial
          color="#FFFFFF"
          emissive={palette.core}
          emissiveIntensity={4.2}
          toneMapped={false}
        />
      </mesh>

      {/* vertical holo beam */}
      <mesh position={[0, 1.9, 0]}>
        <cylinderGeometry args={[0.16, 0.3, 2.6, 18, 1, true]} />
        <meshBasicMaterial
          color={palette.core}
          depthWrite={false}
          opacity={0.18}
          side={THREE.DoubleSide}
          toneMapped={false}
          transparent
        />
      </mesh>

      {/* plaza floor hex pattern */}
      {[1.15, 1.75, 2.35].map((radius) => (
        <mesh key={radius} position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[radius, radius + 0.02, 6]} />
          <meshBasicMaterial color={palette.core} opacity={0.24} toneMapped={false} transparent />
        </mesh>
      ))}

      <pointLight color={palette.core} distance={8} intensity={2.2} position={[0, 2.2, 0]} />

      <Html center className="zone-signage" position={[0, 3.4, 0]} zIndexRange={[6, 4]}>
        <span
          className={`zone-signage-inner engine-signage ${isSelected ? "is-selected" : ""}`}
          style={{ borderColor: `${palette.core}55` }}
        >
          <strong style={{ color: palette.core }}>WORKFLOW ENGINE</strong>
          <small>Orchestration &amp; Logic</small>
        </span>
      </Html>
    </group>
  );
}
