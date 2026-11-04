import type { PoolClient } from "pg";
import type { Interval } from "@/domain/schedule";
import { isoWeekday } from "@/domain/time";
import { many } from "./db";

export async function loadWorkingIntervals(
  db: PoolClient,
  branchId: string,
  staffId: string,
  date: string,
): Promise<{ dayOff: boolean; intervals: Interval[] }> {
  const exceptions = await many<{
    kind: string;
    start_min: number | null;
    end_min: number | null;
  }>(
    db,
    `SELECT kind, start_min, end_min
     FROM schedule_exceptions
     WHERE branch_id = $1 AND staff_id = $2 AND starts_on <= $3::date AND ends_on >= $3::date`,
    [branchId, staffId, date],
  );
  if (exceptions.some((row) => row.kind === "day_off" || row.kind === "vacation")) {
    return { dayOff: true, intervals: [] };
  }
  const specials = exceptions.filter((row) => row.kind === "special_hours" && row.start_min != null && row.end_min != null);
  if (specials.length > 0) {
    return {
      dayOff: false,
      intervals: specials.map((row) => ({
        startMin: Number(row.start_min),
        endMin: Number(row.end_min),
        kind: "work" as const,
      })),
    };
  }
  const template = await many<{ start_min: number; end_min: number; kind: "work" | "break" }>(
    db,
    `SELECT start_min, end_min, kind
     FROM schedule_templates
     WHERE branch_id = $1 AND staff_id = $2 AND weekday = $3
     ORDER BY start_min`,
    [branchId, staffId, isoWeekday(date)],
  );
  return {
    dayOff: false,
    intervals: template.map((row) => ({
      startMin: Number(row.start_min),
      endMin: Number(row.end_min),
      kind: row.kind,
    })),
  };
}
