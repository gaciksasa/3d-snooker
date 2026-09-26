import type { PhysicsWorld } from "./physics";
import type { GamePhase, PlayerId, SnookerRules } from "./rules";
import { ballCentreY } from "./constants";
import { markRestored } from "./balls";

/**
 * Frame save / resume via localStorage. The game is saved after every shot,
 * once the balls have settled and the rules have resolved it, so a save is
 * always a clean "balls at rest, someone to play" position.
 */

const KEY = "3d-snooker:frame";
/** Bump when the format changes; older saves are then ignored. */
const VERSION = 1;

interface SavedBall {
  id: string;
  x: number;
  z: number;
  pocketed: boolean;
  needsRespot: boolean;
}

export interface FrameSave {
  v: number;
  savedAt: number;
  balls: SavedBall[];
  rules: {
    scores: Record<PlayerId, number>;
    current: PlayerId;
    phase: GamePhase;
    onColour: boolean;
    nextColourIndex: number;
    breakScore: number;
  };
}

export function saveFrame(world: PhysicsWorld, rules: SnookerRules): void {
  const data: FrameSave = {
    v: VERSION,
    savedAt: Date.now(),
    balls: world.balls.map((b) => ({
      id: b.id,
      x: b.position.x,
      z: b.position.z,
      pocketed: b.pocketed,
      needsRespot: b.needsRespot,
    })),
    rules: {
      scores: { ...rules.scores },
      current: rules.current,
      phase: rules.phase,
      onColour: rules.onColour,
      nextColourIndex: rules.nextColourIndex,
      breakScore: rules.breakScore,
    },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage full / blocked (private mode) — the game just won't resume.
  }
}

export function clearFrame(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** The saved frame, or null if there is none or it is unusable. */
export function loadFrame(): FrameSave | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as FrameSave;
    const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
    const ok =
      d?.v === VERSION &&
      Array.isArray(d.balls) &&
      d.balls.every((b) => typeof b.id === "string" && num(b.x) && num(b.z)) &&
      num(d.rules?.scores?.player) &&
      num(d.rules?.scores?.ai) &&
      (d.rules.current === "player" || d.rules.current === "ai") &&
      (d.rules.phase === "reds" || d.rules.phase === "colors");
    if (!ok) {
      clearFrame();
      return null;
    }
    return d;
  } catch {
    clearFrame();
    return null;
  }
}

/**
 * Put a saved frame back on the table. Returns false (and changes nothing) if
 * the save doesn't match this game's balls.
 */
export function applyFrame(save: FrameSave, world: PhysicsWorld, rules: SnookerRules): boolean {
  const byId = new Map(world.balls.map((b) => [b.id, b]));
  if (save.balls.length !== world.balls.length || save.balls.some((s) => !byId.has(s.id))) {
    return false;
  }
  const y = ballCentreY();
  for (const s of save.balls) {
    const b = byId.get(s.id)!;
    b.position.set(s.x, y, s.z);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.pocketed = s.pocketed;
    b.needsRespot = s.needsRespot;
    markRestored(b);
  }
  const r = save.rules;
  rules.scores = { player: r.scores.player, ai: r.scores.ai };
  rules.current = r.current;
  rules.phase = r.phase;
  rules.onColour = r.onColour;
  rules.nextColourIndex = r.nextColourIndex;
  rules.breakScore = r.breakScore;
  rules.frameOver = false;
  rules.winner = null;
  // Saves from before the colours-phase fix could be stuck in "reds" with no reds.
  rules.syncPhase(world.balls);
  return true;
}
