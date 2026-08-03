/**
 * Agent navigation.
 *
 * Agents used to be animated with raw sine waves, which read as a nervous
 * back-and-forth twitch. Instead they now walk a real route: Dijkstra over the
 * road graph declared in scene-config, converted into an arc-length
 * parameterised curve, traversed at constant speed with eased departure and
 * arrival, and with the body yaw damped toward the path tangent.
 */

import * as THREE from "three";
import {
  dockNodeId,
  navEdges,
  navNodeById,
  navNodes,
  type NavNodeId,
  type ZoneId,
} from "./scene-config";

type Adjacency = Map<NavNodeId, Array<{ cost: number; id: NavNodeId }>>;

const adjacency: Adjacency = (() => {
  const graph: Adjacency = new Map();
  for (const node of navNodes) graph.set(node.id, []);

  for (const [a, b] of navEdges) {
    const nodeA = navNodeById.get(a);
    const nodeB = navNodeById.get(b);
    if (!nodeA || !nodeB) continue;

    const cost = Math.hypot(
      nodeA.position[0] - nodeB.position[0],
      nodeA.position[2] - nodeB.position[2],
    );

    graph.get(a)?.push({ id: b, cost });
    graph.get(b)?.push({ id: a, cost });
  }

  return graph;
})();

/** Shortest road route between two graph nodes, inclusive of both ends. */
export function findRoute(from: NavNodeId, to: NavNodeId): NavNodeId[] {
  if (from === to) return [from];
  if (!adjacency.has(from) || !adjacency.has(to)) return [to];

  const distance = new Map<NavNodeId, number>([[from, 0]]);
  const previous = new Map<NavNodeId, NavNodeId>();
  const pending = new Set<NavNodeId>(adjacency.keys());

  while (pending.size > 0) {
    let current: NavNodeId | null = null;
    let best = Number.POSITIVE_INFINITY;

    for (const candidate of pending) {
      const value = distance.get(candidate) ?? Number.POSITIVE_INFINITY;
      if (value < best) {
        best = value;
        current = candidate;
      }
    }

    if (!current || best === Number.POSITIVE_INFINITY) break;
    if (current === to) break;

    pending.delete(current);

    for (const edge of adjacency.get(current) ?? []) {
      if (!pending.has(edge.id)) continue;
      const next = best + edge.cost;
      if (next < (distance.get(edge.id) ?? Number.POSITIVE_INFINITY)) {
        distance.set(edge.id, next);
        previous.set(edge.id, current);
      }
    }
  }

  const route: NavNodeId[] = [to];
  let cursor: NavNodeId | undefined = to;
  while (cursor && cursor !== from) {
    cursor = previous.get(cursor);
    if (!cursor) break;
    route.unshift(cursor);
  }

  return route[0] === from ? route : [from, to];
}

function nodeVector(id: NavNodeId): THREE.Vector3 {
  const node = navNodeById.get(id);
  return new THREE.Vector3(...(node?.position ?? [0, 0, 0]));
}

/**
 * Turns a node route into a smooth curve, pushing each waypoint sideways by
 * `lane` so several agents can share a road without clipping through each other.
 */
export function routeCurve(route: NavNodeId[], lane: number): THREE.CatmullRomCurve3 {
  const raw = route.map(nodeVector);

  const points = raw.map((point, index) => {
    const previous = raw[index - 1] ?? point;
    const next = raw[index + 1] ?? point;

    const direction = next.clone().sub(previous);
    direction.y = 0;

    if (direction.lengthSq() < 1e-6) return point.clone();

    direction.normalize();
    const side = new THREE.Vector3(direction.z, 0, -direction.x);
    // Endpoints are standing spots, so keep the spread tighter there.
    const isEnd = index === 0 || index === raw.length - 1;
    return point.clone().add(side.multiplyScalar(lane * (isEnd ? 0.55 : 1)));
  });

  if (points.length === 1) {
    const only = points[0];
    points.push(only.clone().add(new THREE.Vector3(0.001, 0, 0.001)));
  }

  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.35);
  curve.arcLengthDivisions = 240;
  return curve;
}

/** Smoothstep, used to ease speed in and out of a walk. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Shortest-arc angle damping so a turn never snaps 350 degrees the wrong way. */
export function dampAngle(current: number, target: number, lambda: number, delta: number): number {
  let difference = target - current;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return current + difference * (1 - Math.exp(-lambda * delta));
}

export type WalkSample = {
  /** 0..1 progress along the current route. */
  progress: number;
  /** True on the frame the walker reaches its destination. */
  justArrived: boolean;
  /** Current world position. */
  position: THREE.Vector3;
  /** Normalised speed, 0 while parked, 1 at cruise. */
  speed: number;
  /** Facing angle in radians. */
  yaw: number;
};

const CRUISE_SPEED = 2.15;
const EASE_DISTANCE = 1.35;

/**
 * Stateful walker for one agent. Movement is time-based, not frame-based, so it
 * looks identical on a 60Hz and a 120Hz display.
 */
export class AgentWalker {
  private curve: THREE.CatmullRomCurve3;
  private curveLength: number;
  private lane: number;
  private nodeId: NavNodeId;
  private route: NavNodeId[];
  private travelled = 0;
  private yaw: number;

  readonly position = new THREE.Vector3();
  readonly tangent = new THREE.Vector3();

  constructor(zoneId: ZoneId, lane: number, initialYaw = 0) {
    this.lane = lane;
    this.nodeId = dockNodeId(zoneId);
    this.route = [this.nodeId];
    this.curve = routeCurve(this.route, lane);
    this.curveLength = 0;
    this.yaw = initialYaw;
    this.position.copy(this.curve.getPoint(0));
  }

  get currentNode(): NavNodeId {
    return this.nodeId;
  }

  get isTravelling(): boolean {
    return this.travelled < this.curveLength;
  }

  /** Re-targets the walker. Ignored when already heading to the same dock. */
  setTarget(zoneId: ZoneId): void {
    const target = dockNodeId(zoneId);
    const destination = this.route[this.route.length - 1];
    if (destination === target && this.isTravelling) return;
    if (this.nodeId === target && !this.isTravelling) return;

    // Start a new route from the body itself. Replacing the curve's first
    // control point prevents a visible teleport if status changes mid-walk.
    const wasTravelling = this.isTravelling;
    const start = wasTravelling ? this.nearestNode() : this.nodeId;
    this.route = findRoute(start, target);
    const nextCurve = routeCurve(this.route, this.lane);

    if (wasTravelling) {
      const points = nextCurve.points.map((point) => point.clone());
      points[0] = this.position.clone();
      if (points.length === 1) points.push(nodeVector(target));
      this.curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.35);
      this.curve.arcLengthDivisions = 240;
    } else {
      this.curve = nextCurve;
    }

    this.curveLength = this.curve.getLength();
    this.travelled = 0;
    this.nodeId = target;
  }

  private nearestNode(): NavNodeId {
    let best = this.route[0];
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const id of this.route) {
      const node = navNodeById.get(id);
      if (!node) continue;
      const distance = Math.hypot(
        node.position[0] - this.position.x,
        node.position[2] - this.position.z,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = id;
      }
    }

    return best;
  }

  update(delta: number): WalkSample {
    const step = THREE.MathUtils.clamp(delta, 0, 0.08);
    let justArrived = false;

    if (this.curveLength > 0.001 && this.travelled < this.curveLength) {
      const ramp =
        smoothstep(0, EASE_DISTANCE, this.travelled) *
        smoothstep(0, EASE_DISTANCE, this.curveLength - this.travelled);
      const speed = CRUISE_SPEED * (0.18 + 0.82 * ramp);

      this.travelled = Math.min(this.curveLength, this.travelled + speed * step);
      const u = this.travelled / this.curveLength;

      this.position.copy(this.curve.getPointAt(u));
      this.curve.getTangentAt(u, this.tangent);
      this.yaw = dampAngle(this.yaw, Math.atan2(this.tangent.x, this.tangent.z), 7, step);

      if (this.travelled >= this.curveLength) justArrived = true;

      return {
        justArrived,
        position: this.position,
        progress: u,
        speed: THREE.MathUtils.clamp(speed / CRUISE_SPEED, 0, 1),
        yaw: this.yaw,
      };
    }

    return {
      justArrived: false,
      position: this.position,
      progress: 1,
      speed: 0,
      yaw: this.yaw,
    };
  }

  /** Rotates a parked agent toward a world point (its desk, the plaza, ...). */
  faceTowards(x: number, z: number, delta: number): number {
    const target = Math.atan2(x - this.position.x, z - this.position.z);
    this.yaw = dampAngle(this.yaw, target, 3.2, THREE.MathUtils.clamp(delta, 0, 0.08));
    return this.yaw;
  }

  get facing(): number {
    return this.yaw;
  }
}
