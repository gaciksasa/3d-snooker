/** WPBSA / official snooker dimensions (metres). */

export const TABLE = {
  /** Playing area length (baulk → top). */
  length: 3.569,
  /** Playing area width. */
  width: 1.778,
  /**
   * Floor → top of cushion rail (WPBSA: 2 ft 10 in = 864 mm).
   * Playing cloth sits just below the cushion nose.
   */
  height: 0.864,
  cushionHeight: 0.042,
  cushionWidth: 0.055,
  railWidth: 0.12,
  /** Playing surface (cloth) height above the room floor. */
  clothY: 0.864 - 0.04,
  baulkDistance: 0.737,
  dRadius: 0.292,
  blackSpotFromTop: 0.324,
  // Pocket holes, jaws and cushion ends: see tableGeometry.ts (measured
  // from the table model so physics matches what is drawn).
} as const;

/**
 * Playing room (interior, metres). Sized like a real snooker room: roughly a
 * cue's length of space around the table, with a normal ceiling height.
 */
export const ROOM = {
  halfX: 3.0,
  halfZ: 4.0,
  height: 3.4,
  /** Keep cameras this far off walls / ceiling. */
  margin: 0.25,
} as const;

/** Keep a camera / player position inside the room. */
export function clampToRoom<T extends { x: number; y: number; z: number }>(p: T): T {
  const m = ROOM.margin;
  p.x = Math.max(-ROOM.halfX + m, Math.min(ROOM.halfX - m, p.x));
  p.z = Math.max(-ROOM.halfZ + m, Math.min(ROOM.halfZ - m, p.z));
  p.y = Math.min(ROOM.height - m, p.y);
  return p;
}

export const BALL = {
  diameter: 0.0525,
  radius: 0.0525 / 2,
  mass: 0.14,
} as const;

/** Centre height of a ball resting on the cloth. */
export function ballCentreY(): number {
  return TABLE.clothY + BALL.radius;
}

export type BallColor =
  | "cue"
  | "red"
  | "yellow"
  | "green"
  | "brown"
  | "blue"
  | "pink"
  | "black";

export const BALL_VALUES: Record<Exclude<BallColor, "cue">, number> = {
  red: 1,
  yellow: 2,
  green: 3,
  brown: 4,
  blue: 5,
  pink: 6,
  black: 7,
};

export const BALL_HEX: Record<BallColor, number> = {
  cue: 0xf7f4ec,
  // Hues kept well apart so red / pink / brown read clearly under the lamp:
  // red = pure deep red (no blue), pink = light pastel, brown = dark chocolate.
  red: 0xc80a0a,
  yellow: 0xffc400,
  green: 0x0c9a3c,
  brown: 0x5c2a0a,
  blue: 0x1646e0,
  pink: 0xff8cc6,
  black: 0x141414,
};

export const COLOR_ORDER: Exclude<BallColor, "cue" | "red">[] = [
  "yellow",
  "green",
  "brown",
  "blue",
  "pink",
  "black",
];

export const PHYSICS = {
  /** Linear drag (m/s²-ish) while rolling on cloth. */
  friction: 0.22,
  rollingResistance: 0.08,
  cushionRestitution: 0.78,
  /** Tangential speed kept after cushion hit (1 = none lost). */
  cushionFriction: 0.88,
  /** Snooker balls are very elastic, not perfectly. */
  ballRestitution: 0.92,
  /** Keep low so object-ball path matches the geometric aim line. */
  ballFriction: 0.02,
  /** Positional correction for overlaps. */
  collisionSlop: 0.00008,
  collisionPercent: 0.9,
  spinTransfer: 0.15,
  minSpeed: 0.008,
  maxShotSpeed: 8.5,
  gravity: 9.81,
} as const;

export const CONTROLS = {
  walkSpeed: 2.4,
  lookSensitivity: 0.0022,
  /**
   * Cue swing per pixel of mouse movement (rad/px). Browsers report whole
   * pixels, so this is the smallest aim step: 0.0009 ≈ 2.7 mm at 3 m.
   */
  aimSensitivity: 0.0009,
  /** Multiplier while Shift is held for fine aiming (≈ 0.5 mm per px at 3 m). */
  aimFineFactor: 0.2,
  /** Cue swing per px of finger drag (rad/px) — coarser than the mouse. */
  touchAimSensitivity: 0.003,
  touchPitchSensitivity: 0.0016,
  /** Pinch: zoom delta per px change in finger spread. */
  touchZoomFactor: 3,
  /** Arrow-key aim rotation (rad/s); Shift = fine. */
  aimKeySpeed: 1.4,
  aimKeyFineSpeed: 0.18,
  /** Vertical cue swing — much lower than yaw so pitch feels controllable. */
  aimPitchSensitivity: 0.00055,
  minAimPitch: -0.28,
  maxAimPitch: 0.12,
  cueLength: 1.45, // ~57" typical snooker cue (WPBSA min 3 ft / 0.914 m)
  cueTipRadius: 0.0055,
  cueButtRadius: 0.016,
  /** Standing eye height above the room floor. */
  eyeHeight: 1.65,
  /** Horizontal body radius used to block walking through the table. */
  playerRadius: 0.12,
  /** Aim-camera distance behind the cue ball (metres). */
  aimDistanceDefault: 1.65,
  aimDistanceMin: 0.35,
  aimDistanceMax: 3.8,
  /** Extra height of the player's aim camera (metres). */
  aimCameraLift: 0.1,
  /** Horizontal pull-in of the aim camera toward the cue ball (metres). */
  aimCameraPullIn: 0.2,
  /** CPU-turn side camera height above the cushion rail (metres). */
  spectatorHeight: 1.75,
  /**
   * CPU-turn side camera distance from the table's long centre line (metres).
   * Set directly: it used to be 3.41 m but was held at 2.75 m by the room wall.
   */
  spectatorDistance: 2.55,
  walkFovDefault: 60,
  walkFovMin: 28,
  walkFovMax: 75,
  zoomSensitivity: 0.0018,
} as const;
