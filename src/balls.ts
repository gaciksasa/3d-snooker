import * as THREE from "three";
import { BALL, BALL_HEX, ballCentreY, type BallColor, TABLE } from "./constants";
import { getPockets } from "./table";
import { createCueBallTexture } from "./textures";

export interface BallState {
  id: string;
  color: BallColor;
  mesh: THREE.Mesh;
  /** Soft contact blob on the cloth. */
  shadow: THREE.Mesh;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  pocketed: boolean;
  /** True while colour ball awaits respot after pot during reds phase. */
  needsRespot: boolean;
}

/**
 * Round soft contact shadow: a clean circular radial gradient that fades to
 * fully transparent at the rim so it reads as a diffuse patch on the cloth.
 */
function createShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.5;

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, "rgba(0,0,0,0.6)");
  g.addColorStop(0.55, "rgba(0,0,0,0.42)");
  g.addColorStop(0.85, "rgba(0,0,0,0.14)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ballShadowTexture = createShadowTexture();

function createBallShadow(): THREE.Mesh {
  // Tight contact-occlusion patch; the soft cast shadow comes from the key light.
  const geo = new THREE.PlaneGeometry(BALL.radius * 2.6, BALL.radius * 2.6);
  const mat = new THREE.MeshBasicMaterial({
    map: ballShadowTexture,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(geo, mat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = TABLE.clothY + 0.004;
  shadow.renderOrder = 2;
  return shadow;
}

let cueBallMap: THREE.Texture | null = null;
const ballGeometry = new THREE.SphereGeometry(BALL.radius, 48, 32);

export function createBallMesh(color: BallColor): THREE.Mesh {
  // Phenolic resin: saturated base under a hard, glossy lacquer coat.
  const material = new THREE.MeshPhysicalMaterial({
    color: color === "cue" ? 0xe4e1d8 : BALL_HEX[color],
    map: color === "cue" ? (cueBallMap ??= createCueBallTexture()) : null,
    // Toned-down gloss: softer, smaller highlights and weaker reflections.
    roughness: color === "black" ? 0.45 : 0.52,
    specularIntensity: 0.4,
    clearcoat: 0.2,
    clearcoatRoughness: 0.25,
    envMapIntensity: 0.45,
  });
  const mesh = new THREE.Mesh(ballGeometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  // Random initial orientation so the cue-ball dots aren't all axis aligned.
  mesh.quaternion.setFromEuler(
    new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28),
  );
  return mesh;
}

export function makeBall(
  id: string,
  color: BallColor,
  x: number,
  z: number,
): BallState {
  const mesh = createBallMesh(color);
  const shadow = createBallShadow();
  const position = new THREE.Vector3(x, ballCentreY(), z);
  mesh.position.copy(position);
  shadow.position.x = x;
  shadow.position.z = z;
  return {
    id,
    color,
    mesh,
    shadow,
    position,
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    pocketed: false,
    needsRespot: false,
  };
}

/** Spot positions on the longitudinal centre line (x = 0). z: baulk negative. */
export function getSpotPositions() {
  const halfL = TABLE.length / 2;
  const baulkZ = -halfL + TABLE.baulkDistance;
  const y = ballCentreY();
  return {
    brown: new THREE.Vector3(0, y, baulkZ),
    yellow: new THREE.Vector3(TABLE.dRadius, y, baulkZ),
    green: new THREE.Vector3(-TABLE.dRadius, y, baulkZ),
    blue: new THREE.Vector3(0, y, 0),
    pink: new THREE.Vector3(0, y, halfL / 2),
    black: new THREE.Vector3(0, y, halfL - TABLE.blackSpotFromTop),
  };
}

/** Pack 15 reds in a triangle pointing toward the black (positive z). */
export function getRedPackPositions(pinkSpot: THREE.Vector3): THREE.Vector3[] {
  const r = BALL.radius;
  const gap = r * 2 * 1.002;
  const y = ballCentreY();
  const apex = pinkSpot.clone();
  // Apex sits just clear of the pink ball toward black.
  apex.z += r * 2 + 0.002;
  const positions: THREE.Vector3[] = [];
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i <= row; i++) {
      const x = (i - row / 2) * gap;
      const z = apex.z + row * gap * Math.sin(Math.PI / 3);
      positions.push(new THREE.Vector3(x, y, z));
    }
  }
  return positions;
}

/** Opening layout: cue ball in the D, colours on their spots, reds racked. */
export function initialLayout(): { id: string; color: BallColor; x: number; z: number }[] {
  const spots = getSpotPositions();
  const layout: { id: string; color: BallColor; x: number; z: number }[] = [
    // Cue ball starts in the D (right side of D, common break position).
    { id: "cue", color: "cue", x: TABLE.dRadius * 0.45, z: spots.brown.z - TABLE.dRadius * 0.35 },
  ];
  for (const c of ["yellow", "green", "brown", "blue", "pink", "black"] as const) {
    layout.push({ id: c, color: c, x: spots[c].x, z: spots[c].z });
  }
  getRedPackPositions(spots.pink).forEach((p, i) => {
    layout.push({ id: `red-${i}`, color: "red", x: p.x, z: p.z });
  });
  return layout;
}

export function createInitialBalls(): BallState[] {
  return initialLayout().map((l) => makeBall(l.id, l.color, l.x, l.z));
}

const pockets = getPockets();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
/** Seconds for a potted ball to drop out of sight. */
const DROP_TIME = 0.32;

interface BallAnim {
  last: THREE.Vector3;
  /** Drop animation progress after a pot (null = on the table). */
  drop: number | null;
  dropFrom: THREE.Vector3;
  dropTo: THREE.Vector3;
}

function anim(ball: BallState): BallAnim {
  const ud = ball.mesh.userData as { anim?: BallAnim };
  return (ud.anim ??= {
    last: ball.position.clone(),
    drop: null,
    dropFrom: new THREE.Vector3(),
    dropTo: new THREE.Vector3(),
  });
}

/**
 * Snap a ball's visuals to a restored position (saved frame): no roll from the
 * jump, and already-potted balls stay hidden instead of replaying the drop.
 */
export function markRestored(ball: BallState): void {
  const a = anim(ball);
  a.last.copy(ball.position);
  if (ball.pocketed) {
    a.drop = DROP_TIME;
    a.dropFrom.copy(ball.position);
    a.dropTo.copy(ball.position);
  } else {
    a.drop = null;
  }
}

export function syncBallMesh(ball: BallState, dt = 0): void {
  const a = anim(ball);

  if (ball.pocketed) {
    ball.shadow.visible = false;
    if (a.drop === null) {
      // Start the fall: slide toward the pocket centre and sink below the cloth.
      a.drop = 0;
      a.dropFrom.copy(a.last);
      let best = pockets[0];
      let bestD = Infinity;
      for (const p of pockets) {
        const d = (p.position.x - a.last.x) ** 2 + (p.position.y - a.last.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      a.dropTo.set(best.position.x, TABLE.clothY - BALL.radius * 3, best.position.y);
    }
    a.drop += dt;
    const t = Math.min(1, a.drop / DROP_TIME);
    ball.mesh.position.lerpVectors(a.dropFrom, a.dropTo, t);
    ball.mesh.position.y = a.dropFrom.y + (a.dropTo.y - a.dropFrom.y) * t * t;
    ball.mesh.visible = t < 1;
    return;
  }

  // Rolling: rotate about (up × travel) by distance / radius.
  const dx = ball.position.x - a.last.x;
  const dz = ball.position.z - a.last.z;
  const dist = Math.hypot(dx, dz);
  if (a.drop === null && dist > 1e-6 && dist < 0.5) {
    _axis.set(dx, 0, dz).cross(UP).negate().normalize();
    _q.setFromAxisAngle(_axis, dist / BALL.radius);
    ball.mesh.quaternion.premultiply(_q);
  }
  a.drop = null;
  a.last.copy(ball.position);

  ball.mesh.position.copy(ball.position);
  ball.mesh.visible = true;
  ball.shadow.visible = true;
  ball.shadow.position.x = ball.position.x;
  ball.shadow.position.z = ball.position.z;
  ball.shadow.position.y = TABLE.clothY + 0.004;
}
