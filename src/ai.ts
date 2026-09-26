import * as THREE from "three";
import type { BallState } from "./balls";
import { BALL, BALL_VALUES, COLOR_ORDER, PHYSICS, TABLE, ballCentreY, type BallColor } from "./constants";
import { predictAimGuide } from "./aimPredict";
import { PhysicsWorld } from "./physics";
import type { SnookerRules } from "./rules";
import { POCKET_HOLES } from "./tableGeometry";

export interface AiShot {
  direction: THREE.Vector3;
  power: number;
}

/** 1 = Amateur (the original AI), 2 = Club, 3 = Pro. */
export type CpuLevel = 1 | 2 | 3;

export const CPU_LEVELS: { level: CpuLevel; name: string; blurb: string }[] = [
  { level: 1, name: "Amateur", blurb: "Aims at the pocket by eye, often misses and fouls." },
  { level: 2, name: "Club", blurb: "Checks the pot line, aims for the middle of the pocket, plays safe when stuck." },
  { level: 3, name: "Pro", blurb: "Simulates its best shots and plays for position on the next ball." },
];

/**
 * Plan the CPU's shot. A generator so the Pro level can spread its physics
 * look-ahead over several frames (it yields between simulations); the other
 * levels return straight away.
 */
export function* planAiShot(
  world: PhysicsWorld,
  rules: SnookerRules,
  level: CpuLevel,
): Generator<void, AiShot, void> {
  if (level === 1) return amateurShot(world, rules);

  const cue = world.balls.find((b) => b.color === "cue" && !b.pocketed)!;
  const legal = rules.legalFirstBalls(world.balls);
  const candidates = potCandidates(world.balls, cue, legal, true);

  if (candidates.length === 0) return withNoise(safetyShot(world.balls, cue, legal), level);

  if (level === 3) {
    // Look ahead with real physics: keep shots that actually pot without an
    // in-off, and prefer the one that leaves the easiest next pot.
    let best: { shot: AiShot; score: number } | null = null;
    for (const c of candidates.slice(0, 4)) {
      for (const pw of [c.power, Math.min(0.95, c.power * 1.35)]) {
        yield;
        const sim = simulate(world.balls, c.ball.id, c.dir, pw);
        if (!sim.potted || sim.cueIn || sim.firstContact !== c.ball.id) continue;
        const next = nextPotScore(sim.balls, c.ball.color, rules);
        const score = c.score + next * 0.9;
        if (!best || score > best.score) best = { shot: { direction: c.dir.clone(), power: pw }, score };
      }
    }
    if (best) return withNoise(best.shot, level);
  }

  const top = candidates[0];
  return withNoise({ direction: top.dir.clone(), power: top.power }, level);
}

/** Synchronous plan (runs any Pro look-ahead to completion). */
export function computeAiShot(world: PhysicsWorld, rules: SnookerRules, level: CpuLevel = 1): AiShot {
  const it = planAiShot(world, rules, level);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

// ─── Levels 2–3: validated pots ────────────────────────────────────────────

interface Candidate {
  ball: BallState;
  dir: THREE.Vector3;
  power: number;
  score: number;
}

const rotate = (d: THREE.Vector3, a: number) =>
  new THREE.Vector3(d.x * Math.cos(a) - d.z * Math.sin(a), 0, d.x * Math.sin(a) + d.z * Math.cos(a));

/** Does this aim send `target` (hit first) into a pocket, per the aim guide? */
function potsInto(cue: BallState, dir: THREE.Vector3, balls: BallState[], target: BallState): boolean {
  const g = predictAimGuide(cue, dir, balls);
  if (!g || g.kind !== "ball" || !g.objectCenter) return false;
  if (g.objectCenter.distanceToSquared(target.position.clone().setY(g.objectCenter.y)) > 1e-10) return false;
  return POCKET_HOLES.some((h) => Math.abs(g.finish.x - h.x) < 1e-6 && Math.abs(g.finish.z - h.z) < 1e-6);
}

/**
 * Every (legal ball, pocket) pot the aim guide confirms, re-aimed at the middle
 * of its potting window and scored by value, ease and window width.
 */
function potCandidates(
  balls: BallState[],
  cue: BallState,
  legal: BallColor[],
  scanWindow: boolean,
): Candidate[] {
  const out: Candidate[] = [];
  const y = ballCentreY();
  for (const ball of balls) {
    if (ball.pocketed || ball.color === "cue" || !legal.includes(ball.color)) continue;
    for (const h of POCKET_HOLES) {
      const toPocket = new THREE.Vector3(h.x - ball.position.x, 0, h.z - ball.position.z);
      const distPocket = toPocket.length();
      if (distPocket < 0.01) continue;
      toPocket.normalize();
      const ghost = ball.position.clone().addScaledVector(toPocket, -BALL.radius * 2);
      ghost.y = y;
      const aim = ghost.clone().sub(cue.position).setY(0);
      const distCue = aim.length();
      if (distCue < 0.01) continue;
      aim.normalize();
      const cutCos = aim.dot(toPocket);
      if (cutCos < 0.2) continue; // thinner than ~78° — not a realistic pot

      let dir = aim;
      let window = 0;
      if (scanWindow) {
        // Find the contiguous range of aim offsets that still pots, centre on it.
        const step = 0.0012;
        const ok: number[] = [];
        for (let k = -25; k <= 25; k++) if (potsInto(cue, rotate(aim, k * step), balls, ball)) ok.push(k);
        if (ok.length === 0) continue;
        // Largest run of consecutive offsets
        let bestStart = ok[0];
        let bestLen = 1;
        let runStart = ok[0];
        for (let i = 1; i <= ok.length; i++) {
          if (i < ok.length && ok[i] === ok[i - 1] + 1) continue;
          const len = ok[i - 1] - runStart + 1;
          if (len > bestLen) {
            bestLen = len;
            bestStart = runStart;
          }
          if (i < ok.length) runStart = ok[i];
        }
        window = bestLen * step;
        dir = rotate(aim, (bestStart + (bestLen - 1) / 2) * step);
      } else if (!potsInto(cue, aim, balls, ball)) {
        continue;
      }

      const value = BALL_VALUES[ball.color as Exclude<BallColor, "cue">];
      const difficulty = distCue * 0.6 + distPocket * 0.9 + (1 - cutCos) * 2.5;
      const score = value * 0.6 - difficulty + window * 60;
      out.push({ ball, dir, power: potPower(distCue, distPocket, cutCos), score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Power that gets the object ball to the pocket with a little pace to spare,
 * from cloth drag and the speed the cut transfers to the object ball.
 */
function potPower(distCue: number, distPocket: number, cutCos: number): number {
  const drag = PHYSICS.friction + PHYSICS.rollingResistance * 1.5;
  const vObject = Math.sqrt(2 * drag * distPocket) + 0.45;
  const transfer = Math.max(0.2, cutCos) * ((1 + PHYSICS.ballRestitution) / 2);
  const vCue = Math.sqrt((vObject / transfer) ** 2 + 2 * drag * distCue) * 1.1;
  return THREE.MathUtils.clamp(vCue / PHYSICS.maxShotSpeed, 0.12, 0.95);
}

/**
 * Shot error per level: max aim error (rad, uniform ±) and power error
 * (fraction, uniform ±). Tuned so each level's pot rate stays where it was
 * before the pocket jaws were opened to 45°.
 */
export const AI_ERROR: Record<CpuLevel, { aim: number; power: number }> = {
  1: { aim: 0.065, power: 0.06 },
  2: { aim: 0.011, power: 0.07 },
  3: { aim: 0.0025, power: 0.03 },
};

function withNoise(shot: AiShot, level: CpuLevel): AiShot {
  const aimErr = AI_ERROR[level].aim;
  const powErr = AI_ERROR[level].power;
  return {
    direction: rotate(shot.direction, (Math.random() * 2 - 1) * aimErr),
    power: THREE.MathUtils.clamp(shot.power * (1 + (Math.random() * 2 - 1) * powErr), 0.08, 1),
  };
}

/**
 * No pot on: make sure a legal ball is hit (no free foul points). A gentle
 * full-ball contact if one is in sight, otherwise escape off a cushion.
 */
function safetyShot(balls: BallState[], cue: BallState, legal: BallColor[]): AiShot {
  const targets = balls.filter((b) => !b.pocketed && b.color !== "cue" && legal.includes(b.color));
  let best: { dir: THREE.Vector3; dist: number } | null = null;
  for (const b of targets) {
    const dir = b.position.clone().sub(cue.position).setY(0);
    const dist = dir.length();
    dir.normalize();
    const g = predictAimGuide(cue, dir, balls);
    if (g?.kind === "ball" && g.objectCenter && g.objectCenter.distanceTo(b.position.clone().setY(g.objectCenter.y)) < 1e-6) {
      if (!best || dist < best.dist) best = { dir, dist };
    }
  }
  if (best) return { direction: best.dir, power: THREE.MathUtils.clamp(0.22 + best.dist * 0.07, 0.22, 0.45) };

  // Snookered: find a one-cushion route whose next contact is a legal ball.
  let escape: { dir: THREE.Vector3; len: number } | null = null;
  for (let i = 0; i < 360; i++) {
    const a = (i / 360) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const g = predictAimGuide(cue, dir, balls);
    if (!g || g.kind !== "cushion") continue;
    const hit = targets.find(
      (b) => Math.abs(b.position.x - g.finish.x) < 1e-6 && Math.abs(b.position.z - g.finish.z) < 1e-6,
    );
    if (!hit) continue;
    const len = g.ghost.distanceTo(g.cueCenter) + g.ghost.distanceTo(g.finish);
    if (!escape || len < escape.len) escape = { dir, len };
  }
  if (escape) return { direction: escape.dir, power: THREE.MathUtils.clamp(0.3 + escape.len * 0.08, 0.3, 0.7) };

  return amateurFallback(targets, cue);
}

// ─── Level 3 look-ahead ────────────────────────────────────────────────────

/** Mesh-free copy of the balls for physics look-ahead. */
function cloneBalls(balls: BallState[]): BallState[] {
  return balls.map((b) => ({
    id: b.id,
    color: b.color,
    mesh: null as unknown as THREE.Mesh,
    shadow: null as unknown as THREE.Mesh,
    position: b.position.clone(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    pocketed: b.pocketed,
    needsRespot: false,
  }));
}

function simulate(
  balls: BallState[],
  targetId: string,
  dir: THREE.Vector3,
  power: number,
): { potted: boolean; cueIn: boolean; firstContact: string | null; balls: BallState[] } {
  const copy = cloneBalls(balls);
  const w = new PhysicsWorld(copy);
  const cue = copy.find((b) => b.color === "cue")!;
  const target = copy.find((b) => b.id === targetId)!;
  applyShot(cue, dir, power);
  let first: string | null = null;
  for (let i = 0; i < 400; i++) {
    const r = w.step(1 / 30);
    if (!first && r.firstContact) first = r.firstContact.id;
    if (i > 2 && w.isSettled()) break;
  }
  return { potted: target.pocketed, cueIn: cue.pocketed, firstContact: first, balls: copy };
}

/** Ease of the best pot available next, from where the cue ball stopped (0 = none). */
function nextPotScore(balls: BallState[], potted: BallColor, rules: SnookerRules): number {
  const cue = balls.find((b) => b.color === "cue" && !b.pocketed);
  if (!cue) return 0;
  let legal: BallColor[];
  if (rules.phase === "colors") {
    const next = COLOR_ORDER.find((c) => c !== potted && balls.some((b) => b.color === c && !b.pocketed));
    legal = next ? [next] : [];
  } else if (potted === "red") {
    legal = COLOR_ORDER.slice(); // colours are respotted while reds remain
  } else {
    legal = balls.some((b) => b.color === "red" && !b.pocketed) ? ["red"] : COLOR_ORDER.slice(0, 1);
  }
  const next = potCandidates(balls, cue, legal, false)[0];
  return next ? Math.max(0, next.score + 6) : 0;
}

// ─── Level 1: the original heuristic ──────────────────────────────────────

/**
 * Simple heuristic AI:
 * - Pick a legal object ball
 * - Aim cue → ball → nearest pocket
 * - Choose moderate power based on distance
 */
function amateurShot(world: PhysicsWorld, rules: SnookerRules): AiShot {
  const cue = world.balls.find((b) => b.color === "cue" && !b.pocketed)!;
  const legal = rules.legalFirstBalls(world.balls);
  const targets = world.balls.filter(
    (b) => !b.pocketed && b.color !== "cue" && legal.includes(b.color),
  );

  if (targets.length === 0) {
    // Safety: soft nudge toward pack / baulk
    return {
      direction: new THREE.Vector3(0, 0, 1).normalize(),
      power: 0.25,
    };
  }

  let best: { ball: BallState; dir: THREE.Vector3; score: number; power: number } | null =
    null;

  for (const ball of targets) {
    for (const pocket of world.pockets) {
      const pocketPos = new THREE.Vector3(pocket.position.x, ballCentreY(), pocket.position.y);
      const toPocket = pocketPos.clone().sub(ball.position);
      const distBallPocket = toPocket.length();
      if (distBallPocket < 0.01) continue;
      toPocket.normalize();

      // Ghost ball position: where cue centre should be at contact
      const ghost = ball.position.clone().addScaledVector(toPocket, -BALL.radius * 2);
      const aim = ghost.clone().sub(cue.position);
      aim.y = 0;
      const distCue = aim.length();
      if (distCue < 0.01) continue;
      aim.normalize();

      // Line-of-sight: cue to ghost roughly clear
      if (!isPathClear(world, cue, ghost, ball)) continue;

      // Cut angle quality
      const toBall = ball.position.clone().sub(cue.position).setY(0).normalize();
      const cut = toBall.dot(aim);
      if (cut < 0.15) continue;

      const difficulty = distCue + distBallPocket * 1.2 + (1 - cut) * 2;
      const value = BALL_VALUES[ball.color as Exclude<BallColor, "cue">] ?? 1;

      // Prefer easier high-value pots
      const score = value * 2 - difficulty;

      // Power: enough to reach pocket with friction margin
      const travel = distCue + distBallPocket;
      const power = THREE.MathUtils.clamp(0.22 + travel * 0.12, 0.2, 0.78);

      if (!best || score > best.score) {
        best = { ball, dir: aim.clone(), score, power };
      }
    }
  }

  if (best) {
    // Slight inaccuracy so AI isn't perfect
    const noise = (Math.random() * 2 - 1) * AI_ERROR[1].aim;
    const noisy = best.dir.clone();
    const perp = new THREE.Vector3(-noisy.z, 0, noisy.x);
    noisy.addScaledVector(perp, noise).normalize();
    return { direction: noisy, power: best.power * (0.98 + (Math.random() * 2 - 1) * AI_ERROR[1].power) };
  }

  return amateurFallback(targets, cue);
}

/** Hit the nearest legal ball straight on. */
function amateurFallback(targets: BallState[], cue: BallState): AiShot {
  if (targets.length === 0) return { direction: new THREE.Vector3(0, 0, 1), power: 0.25 };
  const nearest = targets.reduce((a, b) =>
    a.position.distanceTo(cue.position) < b.position.distanceTo(cue.position) ? a : b,
  );
  const dir = nearest.position.clone().sub(cue.position).setY(0).normalize();
  return { direction: dir, power: 0.4 };
}

function isPathClear(
  world: PhysicsWorld,
  cue: BallState,
  ghost: THREE.Vector3,
  target: BallState,
): boolean {
  const from = cue.position;
  const to = ghost;
  const seg = to.clone().sub(from);
  const len = seg.length();
  if (len < 1e-4) return false;
  const dir = seg.clone().normalize();

  for (const b of world.balls) {
    if (b.pocketed || b === cue || b === target) continue;
    // Distance from ball centre to segment
    const toBall = b.position.clone().sub(from);
    const t = THREE.MathUtils.clamp(toBall.dot(dir), 0, len);
    const closest = from.clone().addScaledVector(dir, t);
    if (closest.distanceTo(b.position) < BALL.radius * 2.05) return false;
  }

  // Stay within cushions roughly
  const halfL = TABLE.length / 2;
  const halfW = TABLE.width / 2;
  if (Math.abs(ghost.x) > halfW - BALL.radius || Math.abs(ghost.z) > halfL - BALL.radius) {
    return false;
  }

  return true;
}

export function applyShot(cue: BallState, direction: THREE.Vector3, power01: number): void {
  const speed = THREE.MathUtils.clamp(power01, 0.05, 1) * PHYSICS.maxShotSpeed;
  cue.velocity.copy(direction).setY(0).normalize().multiplyScalar(speed);
}
