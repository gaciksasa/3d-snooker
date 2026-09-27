import * as THREE from "three";
import type { BallState } from "./balls";
import { getSpotPositions } from "./balls";
import { BALL, PHYSICS, TABLE, ballCentreY } from "./constants";
import { getPockets, type Pocket } from "./table";
import { CUSHION_SEGMENTS, closestOnSeg, holeAt } from "./tableGeometry";

/** A collision event for audio: speed (m/s) and where on the table it happened. */
export interface Impact {
  speed: number;
  x: number;
  z: number;
}

export interface ShotResult {
  pocketed: BallState[];
  firstContact: BallState | null;
  cuePocketed: boolean;
  cushionHits: number;
  /** Approach speeds (m/s) of ball–ball impacts this step, for audio. */
  ballImpacts: Impact[];
  /** Approach speeds (m/s) of ball–cushion impacts this step, for audio. */
  cushionImpacts: Impact[];
  /** Speeds (m/s) of balls the moment they dropped, for audio. */
  pocketImpacts: Impact[];
}

export class PhysicsWorld {
  balls: BallState[];
  pockets: Pocket[];
  private halfL = TABLE.length / 2;
  private halfW = TABLE.width / 2;
  /** Cushion nose = playing-area boundary (WPBSA face-to-face). */
  /** Balls that already took a ball–ball impulse in the current substep. */
  private hitThisStep = new Set<BallState>();

  constructor(balls: BallState[]) {
    this.balls = balls;
    this.pockets = getPockets();
  }

  isSettled(): boolean {
    return this.balls.every(
      (b) => b.pocketed || b.velocity.lengthSq() < PHYSICS.minSpeed ** 2,
    );
  }

  stopAll(): void {
    for (const b of this.balls) {
      b.velocity.set(0, 0, 0);
      b.angularVelocity.set(0, 0, 0);
    }
  }

  step(dt: number): ShotResult {
    const pocketed: BallState[] = [];
    let firstContact: BallState | null = null;
    let cuePocketed = false;
    let cushionHits = 0;
    const ballImpacts: Impact[] = [];
    const cushionImpacts: Impact[] = [];
    const pocketImpacts: Impact[] = [];

    const active = this.balls.filter((b) => !b.pocketed);
    // Fine substeps: at least 480 Hz, and never more than ~6 mm of travel per
    // substep for the fastest ball, so a ball can't skip past a grazing contact
    // with a jaw tip (at 8.5 m/s a 480 Hz step alone is ~18 mm).
    let maxSpeed = 0;
    for (const b of active) maxSpeed = Math.max(maxSpeed, b.velocity.length());
    const substeps = Math.max(1, Math.ceil(dt / (1 / 480)), Math.ceil((maxSpeed * dt) / 0.006));
    const h = dt / substeps;
    const collisionPasses = 4;

    for (let s = 0; s < substeps; s++) {
      this.hitThisStep.clear();
      for (const ball of active) {
        if (ball.pocketed) continue;
        this.integrateBall(ball, h);
      }

      for (const ball of active) {
        if (ball.pocketed) continue;
        // Cushions / jaws first: the rubber overhangs the edge of the hole, so
        // a ball grazing a jaw is deflected even as its centre reaches the hole.
        const cushionSpeed = this.resolveCushions(ball);
        if (cushionSpeed > 0) {
          cushionHits++;
          cushionImpacts.push({ speed: cushionSpeed, x: ball.position.x, z: ball.position.z });
        }
        if (this.checkPocket(ball)) {
          ball.pocketed = true;
          pocketImpacts.push({
            speed: ball.velocity.length(),
            x: ball.position.x,
            z: ball.position.z,
          });
          ball.velocity.set(0, 0, 0);
          pocketed.push(ball);
          if (ball.color === "cue") cuePocketed = true;
          continue;
        }
        this.containOnTable(ball);
      }

      for (let pass = 0; pass < collisionPasses; pass++) {
        for (let i = 0; i < active.length; i++) {
          const a = active[i];
          if (a.pocketed) continue;
          for (let j = i + 1; j < active.length; j++) {
            const b = active[j];
            if (b.pocketed) continue;
            const impact = this.resolveBallCollision(a, b, h);
            if (impact > 0) {
              ballImpacts.push({
                speed: impact,
                x: (a.position.x + b.position.x) / 2,
                z: (a.position.z + b.position.z) / 2,
              });
              if (!firstContact) {
                if (a.color === "cue") firstContact = b;
                else if (b.color === "cue") firstContact = a;
              }
            }
          }
        }
      }
    }

    return {
      pocketed,
      firstContact,
      cuePocketed,
      cushionHits,
      ballImpacts,
      cushionImpacts,
      pocketImpacts,
    };
  }

  private integrateBall(ball: BallState, h: number): void {
    const speed = ball.velocity.length();
    if (speed > PHYSICS.minSpeed) {
      // Constant rolling drag + light quadratic air term (snooker cloth)
      const drag = PHYSICS.friction + PHYSICS.rollingResistance * speed;
      const newSpeed = Math.max(0, speed - drag * h);
      ball.velocity.multiplyScalar(newSpeed / speed);
    } else {
      ball.velocity.set(0, 0, 0);
    }

    ball.position.addScaledVector(ball.velocity, h);
    ball.position.y = ballCentreY();
    // Visual roll is applied from displacement in syncBallMesh (balls.ts).
  }

  /** Potted once the ball centre is over a pocket hole (as drawn). */
  private checkPocket(ball: BallState): boolean {
    return holeAt(ball.position.x, ball.position.z) !== null;
  }


  /** Returns the approach speed (m/s) if the ball rebounded, else 0. */
  /**
   * Ball against cushion noses and the angled pocket jaws (segments measured
   * from the table model; segment ends act as rounded jaw tips).
   */
  private resolveCushions(ball: BallState): number {
    const r = BALL.radius;
    let impact = 0;
    for (const seg of CUSHION_SEGMENTS) {
      const q = closestOnSeg(seg, ball.position.x, ball.position.z);
      const dx = ball.position.x - q.x;
      const dz = ball.position.z - q.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      ball.position.x = q.x + nx * r;
      ball.position.z = q.z + nz * r;
      const vn = ball.velocity.x * nx + ball.velocity.z * nz;
      if (vn < 0) {
        impact = Math.max(impact, -vn);
        const tx = ball.velocity.x - vn * nx;
        const tz = ball.velocity.z - vn * nz;
        const vnOut = -vn * PHYSICS.cushionRestitution;
        ball.velocity.x = tx * PHYSICS.cushionFriction + nx * vnOut;
        ball.velocity.z = tz * PHYSICS.cushionFriction + nz * vnOut;
      }
    }
    return impact;
  }

  /** Hard failsafe so balls never leave the rails except via pockets. */
  private containOnTable(ball: BallState): void {
    if (this.isInPocketMouth(ball.position.x, ball.position.z, BALL.radius * 1.1)) {
      return;
    }
    const limitX = this.halfW + TABLE.cushionWidth * 0.35;
    const limitZ = this.halfL + TABLE.cushionWidth * 0.35;
    if (Math.abs(ball.position.x) > limitX || Math.abs(ball.position.z) > limitZ) {
      ball.position.x = THREE.MathUtils.clamp(
        ball.position.x,
        -this.halfW + BALL.radius,
        this.halfW - BALL.radius,
      );
      ball.position.z = THREE.MathUtils.clamp(
        ball.position.z,
        -this.halfL + BALL.radius,
        this.halfL - BALL.radius,
      );
      ball.velocity.multiplyScalar(0.5);
    }
  }

  private isInPocketMouth(x: number, z: number, extra = 0): boolean {
    return holeAt(x, z, extra) !== null;
  }


  /**
   * Equal-mass 2D elastic collision.
   * Normal n points from a → b. Relative velocity (va−vb)·n > 0 means approaching.
   */
  private resolveBallCollision(a: BallState, b: BallState, h: number): number {
    let dx = b.position.x - a.position.x;
    let dz = b.position.z - a.position.z;
    const distSq = dx * dx + dz * dz;
    const minDist = BALL.radius * 2;
    const minSq = minDist * minDist;
    if (distSq < 1e-14) return 0;

    // Time of impact. Overlap is only seen after a substep, by which point a
    // fast ball can be ~18 mm deep — using that overlapped line of centres as
    // the contact normal skewed cut shots by up to ~10°, and a thin cut could
    // pass right through (the overlap chord is shorter than one substep of
    // travel). So solve for the moment the centres were exactly 2R apart
    // during this substep, rewind both balls there, resolve, then replay.
    const rvx0 = b.velocity.x - a.velocity.x;
    const rvz0 = b.velocity.z - a.velocity.z;
    const vv = rvx0 * rvx0 + rvz0 * rvz0;
    const dv = dx * rvx0 + dz * rvz0;
    const overlapping = distSq < minSq;
    let rewind = 0;
    if (vv > 1e-12) {
      const disc = dv * dv - vv * (distSq - minSq);
      if (disc >= 0) rewind = (dv + Math.sqrt(disc)) / vv;
    }
    if (!overlapping) {
      // Swept check: they touched and separated again within this substep.
      // Only valid with the velocities the balls actually had during it.
      if (dv <= 0 || rewind <= 0 || rewind > h) return 0;
      if (this.hitThisStep.has(a) || this.hitThisStep.has(b)) return 0;
    }
    rewind = overlapping ? THREE.MathUtils.clamp(rewind, 0, h * 1.5) : rewind;
    if (rewind > 0) {
      a.position.x -= a.velocity.x * rewind;
      a.position.z -= a.velocity.z * rewind;
      b.position.x -= b.velocity.x * rewind;
      b.position.z -= b.velocity.z * rewind;
      dx = b.position.x - a.position.x;
      dz = b.position.z - a.position.z;
    }

    const dist = Math.hypot(dx, dz) || minDist;
    const nx = dx / dist;
    const nz = dz / dist;

    // Separate any remaining overlap (resting contacts, Baumgarte-style, with slop)
    const overlap = minDist - dist;
    const corr = (Math.max(overlap - PHYSICS.collisionSlop, 0) * PHYSICS.collisionPercent) / 2;
    a.position.x -= nx * corr;
    a.position.z -= nz * corr;
    b.position.x += nx * corr;
    b.position.z += nz * corr;

    const rvx = a.velocity.x - b.velocity.x;
    const rvz = a.velocity.z - b.velocity.z;
    const velAlongNormal = rvx * nx + rvz * nz;

    // Already separating — positional fix only
    if (velAlongNormal <= 0) {
      this.replay(a, b, rewind);
      return 0;
    }

    const e = PHYSICS.ballRestitution;
    const j = (-(1 + e) * velAlongNormal) / 2;
    a.velocity.x += j * nx;
    a.velocity.z += j * nz;
    b.velocity.x -= j * nx;
    b.velocity.z -= j * nz;

    // Tangential friction → throw / cut feel
    const tvx = rvx - velAlongNormal * nx;
    const tvz = rvz - velAlongNormal * nz;
    const tLen = Math.hypot(tvx, tvz);
    if (tLen > 1e-8) {
      const tx = tvx / tLen;
      const tz = tvz / tLen;
      const jtMax = Math.abs(j) * PHYSICS.ballFriction;
      let jt = -tLen / 2;
      if (jt > jtMax) jt = jtMax;
      if (jt < -jtMax) jt = -jtMax;
      a.velocity.x += jt * tx;
      a.velocity.z += jt * tz;
      b.velocity.x -= jt * tx;
      b.velocity.z -= jt * tz;
    }

    this.hitThisStep.add(a);
    this.hitThisStep.add(b);
    this.replay(a, b, rewind);
    return velAlongNormal;
  }

  /** Advance a rewound pair by the time taken back in resolveBallCollision. */
  private replay(a: BallState, b: BallState, time: number): void {
    if (time <= 0) return;
    a.position.x += a.velocity.x * time;
    a.position.z += a.velocity.z * time;
    b.position.x += b.velocity.x * time;
    b.position.z += b.velocity.z * time;
  }

  /** The colour's own spot, if nothing is on it. */
  ownSpotIfFree(color: BallState["color"]): THREE.Vector3 | null {
    if (color === "cue" || color === "red") return null;
    const spot = getSpotPositions()[color as keyof ReturnType<typeof getSpotPositions>].clone();
    return this.isPositionFree(spot) ? spot : null;
  }

  findRespot(color: BallState["color"]): THREE.Vector3 | null {
    if (color === "cue" || color === "red") return null;
    const spots = getSpotPositions();
    const preferred = [
      color as keyof typeof spots,
      "black",
      "pink",
      "blue",
      "brown",
      "green",
      "yellow",
    ] as (keyof typeof spots)[];
    const ordered = [preferred[0], ...preferred.filter((c) => c !== preferred[0])];
    for (const key of ordered) {
      const spot = spots[key].clone();
      if (this.isPositionFree(spot)) return spot;
    }
    const origin = spots[color as keyof typeof spots];
    for (let ring = 1; ring < 20; ring++) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const p = new THREE.Vector3(
          origin.x + Math.cos(ang) * ring * BALL.radius * 2.2,
          ballCentreY(),
          origin.z + Math.sin(ang) * ring * BALL.radius * 2.2,
        );
        if (this.inPlayingArea(p) && this.isPositionFree(p)) return p;
      }
    }
    return origin.clone();
  }

  isPositionFree(pos: THREE.Vector3, ignore?: BallState): boolean {
    const min = BALL.radius * 2 + 0.001;
    for (const b of this.balls) {
      if (b.pocketed || b === ignore) continue;
      if (b.position.distanceTo(pos) < min) return false;
    }
    return true;
  }

  inPlayingArea(pos: THREE.Vector3): boolean {
    return (
      Math.abs(pos.x) < this.halfW - BALL.radius &&
      Math.abs(pos.z) < this.halfL - BALL.radius
    );
  }

  randomInD(): THREE.Vector3 {
    const baulkZ = -this.halfL + TABLE.baulkDistance;
    for (let i = 0; i < 80; i++) {
      const ang = Math.random() * Math.PI;
      const rad = Math.sqrt(Math.random()) * TABLE.dRadius * 0.92;
      const p = new THREE.Vector3(
        Math.cos(ang) * rad,
        ballCentreY(),
        baulkZ - Math.sin(ang) * rad,
      );
      if (this.isPositionFree(p)) return p;
    }
    return new THREE.Vector3(0, ballCentreY(), baulkZ - TABLE.dRadius * 0.5);
  }
}
