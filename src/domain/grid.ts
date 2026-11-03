export function snapMinutes(minutes: number, step = 5): number {
  return Math.round(minutes / step) * step;
}

/** Pointer held at least 150ms becomes a drag; earlier release is a click. */
export function pointerIntent(elapsedMs: number): "click" | "drag" {
  return elapsedMs >= 150 ? "drag" : "click";
}

export function resolveDrop(input: { outside: boolean; staffId: string | null; hardInvalid: boolean }): "cancel" | "reject" | "commit" {
  if (input.outside || !input.staffId) return "cancel";
  if (input.hardInvalid) return "reject";
  return "commit";
}

export type GridColumn = { staffId: string; x: number; width: number; hidden?: boolean };

/** Hidden columns are excluded from drag hit-testing. */
export function hitTestColumn(columns: GridColumn[], x: number): string | null {
  const visible = columns.filter((column) => !column.hidden);
  const found = visible.find((column) => x >= column.x && x < column.x + column.width);
  return found?.staffId ?? null;
}

export type Density = "comfortable" | "compact";

export function resolveDensity(pref: "auto" | Density, columns: number): Density {
  if (pref === "comfortable" || pref === "compact") return pref;
  return columns > 12 ? "compact" : "comfortable";
}

export function journalHotkey(key: string, targetTag: string): "new" | "search" | "close" | null {
  const tag = targetTag.toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select";
  if (key === "Escape") return "close";
  if (typing) return null;
  if (key === "n" || key === "N" || key === "т" || key === "Т") return "new";
  if (key === "/") return "search";
  return null;
}
