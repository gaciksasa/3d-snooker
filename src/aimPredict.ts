import * as THREE from "three";
import type { BallState } from "./balls";
import { BALL, PHYSICS, ballCentreY } from "./constants";
import { castBallVsCushions, castBallVsPockets } from "./tableGeometry";

export interface AimGuide {
  /** Cue-ball centre. */
  cueCenter: THREE.Vector3;
  /** Cue-ball centre at the moment of contact (ghost). */
  ghost: THREE.Vector3;
  /** First contact on object ball surface or cushion nose. */
  impact: THREE.Vector3;
  /** Object-ball centre (ball hits only). */
  objectCenter: THREE.Vector3 | null;
  /** Where the struck ball (or cue after cushion) heads next. */
  finish: THREE.Vector3;
  kind: "ball" | "cushion" | "pocket";
}

/**
 * Aim assist matching physics collision response (incl. ball friction).
 */
export function predictAimGuide(
  cue: BallState,
  aimDir: THREE.Vector3,
  balls: BallState[],
): AimGuide | null {
  const d = aimDir.clone().setY(0);
  if (d.lengthSq() < 1e-10) return null;
  d.normalize();

  const ox = cue.position.x;
  const oz = cue.position.z;
  const r = BALL.radius;
  const y = ballCentreY();
  const cueCenter = new THREE.Vector3(ox, y, oz);

  let bestT = Infinity;
  let bestBall: BallState | null = null;
  let bestGhostX = 0;
  let bestGhostZ = 0;
  let bestImpact: THREE.Vector3 | null = null;
  let bestKind: "ball" | "cushion" | "pocket" | null = null;
  let cushionNormal: THREE.Vector3 | null = null;

  for (const b of balls) {
    if (b.pocketed || b === cue || b.color === "cue") continue;

    const ex = b.position.x - ox;
    const ez = b.position.z - oz;
    const f = ex * d.x + ez * d.z;
    const c = ex * ex + ez * ez - 4 * r * r;
    const disc = f * f - c;
    if (disc < 0) continue;
    const t = f - Math.sqrt(disc);
    if (t < 0.002 || t >= bestT) continue;

    const gx = ox + d.x * t;
    const gz = oz + d.z * t;
    // Normal from cue → object (same as physics)
    const nx = b.position.x - gx;
    const nz = b.position.z - gz;
    const nLen = Math.hypot(nx, nz) || 1;
    const nnx = nx / nLen;
    const nnz = nz / nLen;

    bestT = t;
    bestBall = b;
    bestGhostX = gx;
    bestGhostZ = gz;
    bestKind = "ball";
    cushionNormal = null;
    // Contact on object surface facing the cue
    bestImpact = new THREE.Vector3(
      b.position.x - nnx * r,
      y,
      b.position.z - nnz * r,
    );
  }

  // Cushion noses / pocket jaws (same segments as physics)
  const hit = castBallVsCushions(ox, oz, d.x, d.z, r, 0.002);
  if (hit && hit.t < bestT) {
    bestT = hit.t;
    bestBall = null;
    bestKind = "cushion";
    cushionNormal = new THREE.Vector3(hit.nx, 0, hit.nz);
    bestGhostX = ox + d.x * hit.t;
    bestGhostZ = oz + d.z * hit.t;
    bestImpact = new THREE.Vector3(bestGhostX - hit.nx * r, y, bestGhostZ - hit.nz * r);
  }

  // Cue ball heading straight into a pocket
  const drop = castBallVsPockets(ox, oz, d.x, d.z);
  if (drop && drop.t < bestT) {
    bestT = drop.t;
    bestBall = null;
    bestKind = "pocket";
    cushionNormal = null;
    bestGhostX = ox + d.x * drop.t;
    bestGhostZ = oz + d.z * drop.t;
    bestImpact = new THREE.Vector3(bestGhostX, y, bestGhostZ);
  }

  if (!bestKind || !bestImpact) return null;

  const ghost = new THREE.Vector3(bestGhostX, y, bestGhostZ);
  let finish: THREE.Vector3;
  let objectCenter: THREE.Vector3 | null = null;

  if (bestKind === "ball" && bestBall) {
    objectCenter = new THREE.Vector3(bestBall.position.x, y, bestBall.position.z);
    const nx = bestBall.position.x - bestGhostX;
    const nz = bestBall.position.z - bestGhostZ;
    const nLen = Math.hypot(nx, nz) || 1;
    const leave = objectLeaveDirection(d.x, d.z, nx / nLen, nz / nLen);
    finish = castBallPath(
      bestBall.position.x,
      bestBall.position.z,
      leave.x,
      leave.z,
      y,
      balls,
      bestBall,
      cue,
    );
  } else if (bestKind === "cushion") {
    // Bounce exactly as physics does: normal speed × restitution, tangential
    // speed × cushion friction (not a pure mirror).
    const n = cushionNormal!;
    const vn = d.dot(n);
    const rd = d
      .clone()
      .addScaledVector(n, -vn)
      .multiplyScalar(PHYSICS.cushionFriction)
      .addScaledVector(n, -vn * PHYSICS.cushionRestitution);
    rd.setY(0);
    if (rd.lengthSq() < 1e-10) rd.copy(d).multiplyScalar(-1);
    rd.normalize();
    finish = castBallPath(bestGhostX, bestGhostZ, rd.x, rd.z, y, balls, cue, null);
  } else {
    finish = ghost.clone();
  }

  return {
    cueCenter,
    ghost,
    impact: bestImpact,
    objectCenter,
    finish,
    kind: bestKind,
  };
}

/**
 * Object-ball leave direction after the cue ball hits a still ball: the line
 * of centres at contact, plus the small "throw" that ball–ball friction in
 * physics adds (object ball dragged toward the cue ball's travel).
 * Mirrors PhysicsWorld.resolveBallCollision: tangential impulse is
 * min(tangential slip / 2, μ·normal impulse), normal speed is (1+e)/2·vn.
 */
function objectLeaveDirection(
  aimX: number,
  aimZ: number,
  nx: number,
  nz: number,
): THREE.Vector3 {
  const vn = aimX * nx + aimZ * nz;
  // Tangent = component of travel across the line of centres
  let tx = aimX - vn * nx;
  let tz = aimZ - vn * nz;
  const vt = Math.hypot(tx, tz);
  if (vt < 1e-9 || vn <= 0) return new THREE.Vector3(nx, 0, nz);
  tx /= vt;
  tz /= vt;
  const e = PHYSICS.ballRestitution;
  const normal = ((1 + e) / 2) * vn;
  const tangential = Math.min(vt / 2, PHYSICS.ballFriction * normal);
  return new THREE.Vector3(nx * normal + tx * tangential, 0, nz * normal + tz * tangential).normalize();
}

/** First stop for a rolling ball centre: pocket, other ball, or cushion. */
function castBallPath(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  y: number,
  balls: BallState[],
  self: BallState,
  ignore: BallState | null,
): THREE.Vector3 {
  const r = BALL.radius;
  let bestT = Infinity;
  let best = new THREE.Vector3(ox + dx * 3, y, oz + dz * 3);

  for (const b of balls) {
    if (b.pocketed || b === self || b === ignore) continue;
    const ex = b.position.x - ox;
    const ez = b.position.z - oz;
    const f = ex * dx + ez * dz;
    const c = ex * ex + ez * ez - 4 * r * r;
    const disc = f * f - c;
    if (disc < 0) continue;
    const t = f - Math.sqrt(disc);
    if (t < 0.01 || t >= bestT) continue;
    bestT = t;
    // End at this ball's centre — clearer “where it finishes” toward next ball
    best = new THREE.Vector3(b.position.x, y, b.position.z);
  }

  const drop = castBallVsPockets(ox, oz, dx, dz);
  if (drop && drop.t > 0.01 && drop.t < bestT) {
    bestT = drop.t;
    best = new THREE.Vector3(drop.hole.x, y, drop.hole.z);
  }

  const hit = castBallVsCushions(ox, oz, dx, dz, r, 0.01);
  if (hit && hit.t < bestT) {
    bestT = hit.t;
    // Centre position at cushion / jaw contact
    best = new THREE.Vector3(ox + dx * hit.t, y, oz + dz * hit.t);
  }

  return best;
}
