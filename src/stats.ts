import type { CpuLevel } from "./ai";

/** Best frame: most points the player scored in one finished frame (localStorage). */
export interface BestFrame {
  points: number;
  level: CpuLevel;
  /** Epoch ms when it was set. */
  at: number;
}

const KEY = "3d-snooker:best-frame";

export function loadBestFrame(): BestFrame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<BestFrame>;
    if (typeof d.points !== "number" || !(d.points > 0)) return null;
    const level = d.level === 2 || d.level === 3 ? d.level : 1;
    return { points: d.points, level, at: typeof d.at === "number" ? d.at : 0 };
  } catch {
    return null;
  }
}

/** Record a finished frame; returns the (possibly new) best and whether it was beaten. */
export function recordFrame(points: number, level: CpuLevel): { best: BestFrame | null; isNew: boolean } {
  const prev = loadBestFrame();
  if (points <= 0 || (prev && points <= prev.points)) return { best: prev, isNew: false };
  const best: BestFrame = { points, level, at: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(best));
  } catch {
    // Storage blocked — the record just won't persist.
  }
  return { best, isNew: true };
}
