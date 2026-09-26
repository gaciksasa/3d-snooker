/**
 * Playing-surface collision geometry, measured from the visible table model
 * (public/snooker.obj, used 1:1 in world space — see loadTableModel). Physics,
 * the aim guide, the AI and pot animations all use this, so a pocket mouth
 * behaves exactly as wide as it looks.
 *
 * Plan view (x across, z along the table), metres:
 * - Cushion noses sit on the WPBSA playing area (±0.889, ±1.7845).
 * - Each cushion ends in an angled jaw running back 50 mm into the rail:
 *   45° off the cushion line (open, blunt jaws) at every pocket.
 * - Pocket wells are the round holes in the bed: a ball drops once its
 *   centre is over the hole.
 */

export interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface PocketHole {
  name: string;
  x: number;
  z: number;
  /** Hole radius; the ball drops when its centre is inside it. */
  r: number;
}

const NOSE_X = 0.889;
const NOSE_Z = 1.7845;
/** Rail-side edge of the cushion rubber (nose + 50 mm). */
const BACK_X = 0.939;
const BACK_Z = 1.8345;
/** Long cushion: nose runs z ∈ [MID_NOSE_END, CORNER_NOSE_END_Z]. */
const MID_NOSE_END = 0.09717;
const MID_BACK_END = 0.04717;
const CORNER_NOSE_END_Z = 1.693165;
const CORNER_BACK_END_Z = 1.74317;
/** Short cushion: nose runs x ∈ ±CORNER_NOSE_END_X. */
const CORNER_NOSE_END_X = 0.797665;
const CORNER_BACK_END_X = 0.84767;

export const POCKET_HOLES: PocketHole[] = [
  { name: "bottom-left", x: -0.899, z: -1.7945, r: 0.05225 },
  { name: "bottom-right", x: 0.899, z: -1.7945, r: 0.05225 },
  { name: "top-left", x: -0.899, z: 1.7945, r: 0.05225 },
  { name: "top-right", x: 0.899, z: 1.7945, r: 0.05225 },
  { name: "mid-left", x: -0.921, z: 0, r: 0.057 },
  { name: "mid-right", x: 0.921, z: 0, r: 0.057 },
];

function buildSegments(): Seg[] {
  const segs: Seg[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Long cushion half (mid pocket → corner pocket): nose + both jaws
      segs.push({ ax: sx * NOSE_X, az: sz * MID_NOSE_END, bx: sx * NOSE_X, bz: sz * CORNER_NOSE_END_Z });
      segs.push({ ax: sx * NOSE_X, az: sz * CORNER_NOSE_END_Z, bx: sx * BACK_X, bz: sz * CORNER_BACK_END_Z });
      segs.push({ ax: sx * NOSE_X, az: sz * MID_NOSE_END, bx: sx * BACK_X, bz: sz * MID_BACK_END });
      // Short cushion jaw at this corner
      segs.push({
        ax: sx * CORNER_NOSE_END_X,
        az: sz * NOSE_Z,
        bx: sx * CORNER_BACK_END_X,
        bz: sz * BACK_Z,
      });
    }
  }
  for (const sz of [-1, 1]) {
    segs.push({ ax: -CORNER_NOSE_END_X, az: sz * NOSE_Z, bx: CORNER_NOSE_END_X, bz: sz * NOSE_Z });
  }
  return segs;
}

export const CUSHION_SEGMENTS: Seg[] = buildSegments();

/** Closest point on a segment to (px, pz). */
export function closestOnSeg(s: Seg, px: number, pz: number): { x: number; z: number } {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / len2)) : 0;
  return { x: s.ax + dx * t, z: s.az + dz * t };
}

/** Smallest t ≥ 0 at which a point moving o + d·t is within `rad` of (cx, cz). */
function rayCircle(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, rad: number): number {
  const fx = ox - cx;
  const fz = oz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - rad * rad;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

export interface SegHit {
  t: number;
  /** Unit contact normal (from the cushion toward the ball centre). */
  nx: number;
  nz: number;
}

/**
 * First contact of a ball (radius `rad`, centre moving o + d·t, |d| = 1) with
 * any cushion nose or jaw — including the rounded jaw tips.
 */
export function castBallVsCushions(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  rad: number,
  minT = 1e-4,
): SegHit | null {
  let best: SegHit | null = null;
  const consider = (t: number, qx: number, qz: number) => {
    if (!(t >= minT) || (best && t >= best.t)) return;
    const cx = ox + dx * t - qx;
    const cz = oz + dz * t - qz;
    const l = Math.hypot(cx, cz) || 1;
    best = { t, nx: cx / l, nz: cz / l };
  };
  for (const s of CUSHION_SEGMENTS) {
    const ex = s.bx - s.ax;
    const ez = s.bz - s.az;
    const len = Math.hypot(ex, ez);
    if (len < 1e-9) continue;
    // Face normal on the side the ball starts from
    let nx = -ez / len;
    let nz = ex / len;
    const side = (ox - s.ax) * nx + (oz - s.az) * nz;
    if (side < 0) {
      nx = -nx;
      nz = -nz;
    }
    const approach = dx * nx + dz * nz;
    if (approach < 0) {
      const t = (rad - Math.abs(side)) / approach;
      const hx = ox + dx * t - nx * rad;
      const hz = oz + dz * t - nz * rad;
      const u = ((hx - s.ax) * ex + (hz - s.az) * ez) / (len * len);
      if (u >= 0 && u <= 1) consider(t, hx, hz);
    }
    consider(rayCircle(ox, oz, dx, dz, s.ax, s.az, rad), s.ax, s.az);
    consider(rayCircle(ox, oz, dx, dz, s.bx, s.bz, rad), s.bx, s.bz);
  }
  return best;
}

/** First pocket whose hole the ball centre enters along o + d·t (|d| = 1). */
export function castBallVsPockets(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
): { t: number; hole: PocketHole } | null {
  let best: { t: number; hole: PocketHole } | null = null;
  for (const h of POCKET_HOLES) {
    const t = rayCircle(ox, oz, dx, dz, h.x, h.z, h.r);
    if (t < (best?.t ?? Infinity)) best = { t, hole: h };
  }
  return best;
}

export function holeAt(x: number, z: number, extra = 0): PocketHole | null {
  for (const h of POCKET_HOLES) {
    const r = h.r + extra;
    if ((x - h.x) ** 2 + (z - h.z) ** 2 < r * r) return h;
  }
  return null;
}
