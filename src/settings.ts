import type { CpuLevel } from "./ai";

/** Player preferences kept across sessions (localStorage). */
export interface Settings {
  cpuLevel: CpuLevel;
}

const KEY = "3d-snooker:settings";
const DEFAULTS: Settings = { cpuLevel: 1 };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const d = JSON.parse(raw) as Partial<Settings>;
    const lvl = d.cpuLevel;
    return { cpuLevel: lvl === 1 || lvl === 2 || lvl === 3 ? lvl : DEFAULTS.cpuLevel };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked — the choice just won't persist.
  }
}
