import type { CpuLevel } from "./ai";

/** Best frame: most points the player scored in one finished frame. */
export interface BestFrame {
  points: number;
  /** Epoch ms when it was set. */
  at: number;
}

/** One record per CPU level, kept in localStorage. */
export type BestFrames = Partial<Record<CpuLevel, BestFrame>>;

const KEY = "3d-snooker:best-frames";
/** Earlier single record ({ points, level, at }); moved into its level on first load. */
const LEGACY_KEY = "3d-snooker:best-frame";

function parseRecord(v: unknown): BestFrame | null {
  const d = v as Partial<BestFrame> | null;
  if (!d || typeof d.points !== "number" || !(d.points > 0)) return null;
  return { points: d.points, at: typeof d.at === "number" ? d.at : 0 };
}

export function loadBestFrames(): BestFrames {
  const out: BestFrames = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Record<string, unknown>;
      for (const level of [1, 2, 3] as const) {
        const r = parseRecord(d[level]);
        if (r) out[level] = r;
      }
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const d = JSON.parse(legacy) as { level?: unknown };
      const level: CpuLevel = d.level === 2 || d.level === 3 ? d.level : 1;
      const r = parseRecord(d);
      if (r && !(out[level] && out[level]!.points >= r.points)) out[level] = r;
      localStorage.setItem(KEY, JSON.stringify(out));
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    // Storage blocked or corrupt — start with no records.
  }
  return out;
}

/** Record a finished frame for `level`; returns that level's best and whether it was beaten. */
export function recordFrame(points: number, level: CpuLevel): { best: BestFrame | null; isNew: boolean } {
  const all = loadBestFrames();
  const prev = all[level] ?? null;
  if (points <= 0 || (prev && points <= prev.points)) return { best: prev, isNew: false };
  const best: BestFrame = { points, at: Date.now() };
  all[level] = best;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked — the record just won't persist.
  }
  return { best, isNew: true };
}
