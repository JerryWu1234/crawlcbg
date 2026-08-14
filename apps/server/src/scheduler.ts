import crypto from "node:crypto";
import type { DbHelper } from "./db.js";

export type ScheduleRecurrenceType = "hourly" | "daily" | "weekly" | "weekdays" | "weekends";
export type ScheduleStatus = "idle" | "running" | "error";
export type ScheduleRunStatus = "completed" | "failed" | "skipped" | "interrupted";

export interface TabScheduleInput {
  id?: string;
  targetUrl: string;
  targetTitle: string;
  scriptFilename: string;
  params?: Record<string, string | number | boolean>;
  recurrenceType: ScheduleRecurrenceType;
  intervalValue?: number;
  runAt?: string;
  enabled?: boolean;
}

export interface TabSchedule {
  id: string;
  targetUrl: string;
  targetTitle: string;
  scriptFilename: string;
  params: Record<string, string | number | boolean>;
  recurrenceType: ScheduleRecurrenceType;
  intervalValue: number;
  runAt: string;
  enabled: boolean;
  status: ScheduleStatus;
  nextBaseAt: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduleRunStatus | null;
  lastError: string | null;
  runningRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledExecutionRequest {
  runId: string;
  schedule: TabSchedule;
}

export interface ScheduledExecutionResult {
  status: Exclude<ScheduleRunStatus, "interrupted">;
  error?: string;
}

interface ScheduleRow {
  id: string;
  target_url: string;
  target_title: string;
  script_filename: string;
  params_json: string;
  recurrence_type: ScheduleRecurrenceType;
  interval_value: number;
  run_at: string;
  enabled: number;
  status: ScheduleStatus;
  next_base_at: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: ScheduleRunStatus | null;
  last_error: string | null;
  running_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SchedulerLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const START_JITTER_MIN_MS = 60 * 1000;
const START_JITTER_MAX_MS = 5 * 60 * 1000;
const SCHEDULER_TICK_MS = 5_000;
const VALID_RECURRENCE_TYPES = new Set<ScheduleRecurrenceType>([
  "hourly",
  "daily",
  "weekly",
  "weekdays",
  "weekends",
]);

const parseParams = (value: string): Record<string, string | number | boolean> => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const mapScheduleRow = (row: ScheduleRow): TabSchedule => ({
  id: row.id,
  targetUrl: row.target_url,
  targetTitle: row.target_title,
  scriptFilename: row.script_filename,
  params: parseParams(row.params_json),
  recurrenceType: row.recurrence_type,
  intervalValue: row.interval_value,
  runAt: row.run_at,
  enabled: row.enabled === 1,
  status: row.status,
  nextBaseAt: row.next_base_at,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  lastRunStatus: row.last_run_status,
  lastError: row.last_error,
  runningRunId: row.running_run_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const intervalDurationMs = (type: ScheduleRecurrenceType, intervalValue: number): number => {
  if (type === "hourly") return intervalValue * HOUR_MS;
  if (type === "daily") return intervalValue * DAY_MS;
  if (type === "weekly") return intervalValue * 7 * DAY_MS;
  return DAY_MS;
};

const parseRunAt = (runAt: string): { hour: number; minute: number } => {
  const match = /^(\d{2}):(\d{2})$/.exec(runAt);
  if (!match) throw new Error("执行时间必须使用 HH:mm 格式。");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("执行时间超出有效范围。");
  return { hour, minute };
};

const isEligibleCalendarDay = (type: ScheduleRecurrenceType, day: number): boolean => {
  if (type === "weekdays") return day >= 1 && day <= 5;
  if (type === "weekends") return day === 0 || day === 6;
  return true;
};

const nextCalendarBase = (
  type: "weekdays" | "weekends",
  runAt: string,
  afterMs: number,
): number => {
  const { hour, minute } = parseRunAt(runAt);
  const localNow = new Date(afterMs + SHANGHAI_OFFSET_MS);

  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const localCandidateMs = Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate() + dayOffset,
      hour,
      minute,
    );
    const candidateMs = localCandidateMs - SHANGHAI_OFFSET_MS;
    const dayOfWeek = new Date(localCandidateMs).getUTCDay();
    if (candidateMs > afterMs && isEligibleCalendarDay(type, dayOfWeek)) return candidateMs;
  }

  throw new Error("无法计算下一次工作日/周末执行时间。");
};

const calculateInitialBase = (
  recurrenceType: ScheduleRecurrenceType,
  intervalValue: number,
  runAt: string,
  fromMs: number,
): number => {
  if (recurrenceType === "weekdays" || recurrenceType === "weekends") {
    return nextCalendarBase(recurrenceType, runAt, fromMs);
  }
  return fromMs + intervalDurationMs(recurrenceType, intervalValue);
};

const calculateFollowingBase = (schedule: TabSchedule, nowMs: number): number => {
  if (schedule.recurrenceType === "weekdays" || schedule.recurrenceType === "weekends") {
    return nextCalendarBase(schedule.recurrenceType, schedule.runAt, nowMs);
  }

  const duration = intervalDurationMs(schedule.recurrenceType, schedule.intervalValue);
  let nextBase = schedule.nextBaseAt
    ? Date.parse(schedule.nextBaseAt) + duration
    : nowMs + duration;
  while (nextBase <= nowMs) nextBase += duration;
  return nextBase;
};

const addStartJitter = (baseMs: number): number =>
  baseMs + crypto.randomInt(START_JITTER_MIN_MS, START_JITTER_MAX_MS + 1);

const validateCalendarRunAt = (runAt: string): void => {
  const { hour, minute } = parseRunAt(runAt);
  if (hour === 23 && minute > 54) {
    throw new Error("工作日/周末执行时间最晚为 23:54，以确保随机启动不会跨到下一天。");
  }
};

const normalizeInput = (input: TabScheduleInput): Required<Omit<TabScheduleInput, "id">> => {
  const targetUrl = input.targetUrl?.trim();
  const targetTitle = input.targetTitle?.trim() || targetUrl;
  const scriptFilename = input.scriptFilename?.trim();
  const recurrenceType = input.recurrenceType;
  const intervalValue = Math.trunc(Number(input.intervalValue ?? 1));
  const runAt = input.runAt?.trim() || "09:00";
  const enabled = input.enabled !== false;

  if (!targetUrl) throw new Error("目标标签页 URL 不能为空。");
  const parsedUrl = new URL(targetUrl);
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("循环任务仅支持 HTTP/HTTPS 页面。");
  if (!scriptFilename) throw new Error("请选择循环执行脚本。");
  if (!VALID_RECURRENCE_TYPES.has(recurrenceType)) throw new Error("循环类型无效。");
  if (intervalValue < 1 || intervalValue > 999) throw new Error("循环间隔必须在 1 到 999 之间。");
  if (recurrenceType === "weekdays" || recurrenceType === "weekends") {
    validateCalendarRunAt(runAt);
  }

  const params = input.params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("脚本参数格式无效。");
  }

  return {
    targetUrl,
    targetTitle,
    scriptFilename,
    params,
    recurrenceType,
    intervalValue,
    runAt,
    enabled,
  };
};

export class TabScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightScheduleIds = new Set<string>();

  constructor(
    private readonly db: DbHelper,
    private readonly execute: (
      request: ScheduledExecutionRequest,
    ) => Promise<ScheduledExecutionResult>,
    private readonly logger: SchedulerLogger = console,
  ) {}

  initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tab_schedules (
        id TEXT PRIMARY KEY,
        target_url TEXT NOT NULL UNIQUE,
        target_title TEXT NOT NULL,
        script_filename TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}',
        recurrence_type TEXT NOT NULL,
        interval_value INTEGER NOT NULL DEFAULT 1,
        run_at TEXT NOT NULL DEFAULT '09:00',
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle',
        next_base_at TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_run_status TEXT,
        last_error TEXT,
        running_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tab_schedules_due
        ON tab_schedules(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS tab_schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        error TEXT,
        FOREIGN KEY(schedule_id) REFERENCES tab_schedules(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tab_schedule_runs_schedule
        ON tab_schedule_runs(schedule_id, started_at DESC);
    `);
  }

  start(): void {
    if (this.timer) return;
    this.initializeSchema();
    this.resetAfterRestart();
    this.timer = setInterval(() => void this.tick(), SCHEDULER_TICK_MS);
    this.timer.unref?.();
    void this.tick();
    this.logger.info("[Scheduler] Tab schedule service started.");
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  list(): TabSchedule[] {
    return (
      this.db.all("SELECT * FROM tab_schedules ORDER BY created_at DESC") as ScheduleRow[]
    ).map(mapScheduleRow);
  }

  getById(id: string): TabSchedule | null {
    const row = this.db.get("SELECT * FROM tab_schedules WHERE id = ?", [id]) as
      | ScheduleRow
      | undefined;
    return row ? mapScheduleRow(row) : null;
  }

  save(input: TabScheduleInput): TabSchedule {
    this.initializeSchema();
    const normalized = normalizeInput(input);
    const existingByUrlRow = this.db.get("SELECT * FROM tab_schedules WHERE target_url = ?", [
      normalized.targetUrl,
    ]) as ScheduleRow | undefined;
    const existingByUrl = existingByUrlRow ? mapScheduleRow(existingByUrlRow) : null;
    if (!input.id && existingByUrl) {
      throw new Error("该目标 URL 已有循环任务，请编辑现有计划。");
    }
    const existing = input.id ? this.getById(input.id) : null;

    if (existing?.status === "running") throw new Error("循环任务正在执行，暂时不能修改。");

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const id = existing?.id ?? input.id ?? `schedule_${crypto.randomUUID()}`;
    const baseMs = normalized.enabled
      ? calculateInitialBase(
          normalized.recurrenceType,
          normalized.intervalValue,
          normalized.runAt,
          now,
        )
      : null;
    const nextRunMs = baseMs === null ? null : addStartJitter(baseMs);

    this.db.run(
      `INSERT INTO tab_schedules (
        id, target_url, target_title, script_filename, params_json, recurrence_type,
        interval_value, run_at, enabled, status, next_base_at, next_run_at,
        last_run_at, last_run_status, last_error, running_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_url = excluded.target_url,
        target_title = excluded.target_title,
        script_filename = excluded.script_filename,
        params_json = excluded.params_json,
        recurrence_type = excluded.recurrence_type,
        interval_value = excluded.interval_value,
        run_at = excluded.run_at,
        enabled = excluded.enabled,
        status = 'idle',
        next_base_at = excluded.next_base_at,
        next_run_at = excluded.next_run_at,
        last_error = NULL,
        running_run_id = NULL,
        updated_at = excluded.updated_at`,
      [
        id,
        normalized.targetUrl,
        normalized.targetTitle,
        normalized.scriptFilename,
        JSON.stringify(normalized.params),
        normalized.recurrenceType,
        normalized.intervalValue,
        normalized.runAt,
        normalized.enabled ? 1 : 0,
        baseMs === null ? null : new Date(baseMs).toISOString(),
        nextRunMs === null ? null : new Date(nextRunMs).toISOString(),
        existing?.lastRunAt ?? null,
        existing?.lastRunStatus ?? null,
        existing?.createdAt ?? nowIso,
        nowIso,
      ],
    );

    const saved = this.getById(id);
    if (!saved) throw new Error("循环任务保存后无法读取。");
    return saved;
  }

  delete(id: string): boolean {
    const schedule = this.getById(id);
    if (!schedule) return false;
    if (schedule.status === "running") throw new Error("循环任务正在执行，暂时不能删除。");
    this.db.run("DELETE FROM tab_schedules WHERE id = ?", [id]);
    return true;
  }

  private resetAfterRestart(): void {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const interruptionMessage = "服务重启，运行记录已中断。";
    const interruptedScheduleIds = new Set(
      (
        this.db.all(
          "SELECT DISTINCT schedule_id FROM tab_schedule_runs WHERE status = 'running'",
        ) as Array<{ schedule_id: string }>
      ).map((row) => row.schedule_id),
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.run(
        "UPDATE tab_schedule_runs SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running'",
        [nowIso, interruptionMessage],
      );

      for (const schedule of this.list()) {
        const wasInterrupted =
          schedule.status === "running" || interruptedScheduleIds.has(schedule.id);

        if (
          schedule.enabled &&
          (schedule.recurrenceType === "weekdays" || schedule.recurrenceType === "weekends")
        ) {
          try {
            validateCalendarRunAt(schedule.runAt);
          } catch (error) {
            const validationMessage =
              error instanceof Error ? error.message : "日历计划执行时间无效。";
            const interruptedHistoryFields = wasInterrupted
              ? ", last_run_at = ?, last_run_status = 'interrupted'"
              : "";
            const interruptedHistoryParams = wasInterrupted ? [nowIso] : [];
            this.db.run(
              `UPDATE tab_schedules SET enabled = 0, status = 'error', running_run_id = NULL,
                next_base_at = NULL, next_run_at = NULL, last_error = ?, updated_at = ?${interruptedHistoryFields}
              WHERE id = ?`,
              [validationMessage, nowIso, ...interruptedHistoryParams, schedule.id],
            );
            this.logger.warn(
              `[Scheduler] Disabled invalid calendar schedule ${schedule.id}: ${validationMessage}`,
            );
            continue;
          }
        }

        const interruptedFields = wasInterrupted
          ? ", last_run_at = ?, last_run_status = 'interrupted', last_error = ?"
          : "";
        const interruptedParams = wasInterrupted ? [nowIso, interruptionMessage] : [];

        if (!schedule.enabled) {
          this.db.run(
            `UPDATE tab_schedules SET status = 'idle', running_run_id = NULL,
              next_base_at = NULL, next_run_at = NULL, updated_at = ?${interruptedFields}
            WHERE id = ?`,
            [nowIso, ...interruptedParams, schedule.id],
          );
          continue;
        }

        const baseMs = calculateInitialBase(
          schedule.recurrenceType,
          schedule.intervalValue,
          schedule.runAt,
          now,
        );
        this.db.run(
          `UPDATE tab_schedules SET status = 'idle', running_run_id = NULL,
            next_base_at = ?, next_run_at = ?, updated_at = ?${interruptedFields}
          WHERE id = ?`,
          [
            new Date(baseMs).toISOString(),
            new Date(addStartJitter(baseMs)).toISOString(),
            nowIso,
            ...interruptedParams,
            schedule.id,
          ],
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async tick(): Promise<void> {
    const dueRows = this.db.all(
      "SELECT * FROM tab_schedules WHERE enabled = 1 AND status != 'running' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 20",
      [new Date().toISOString()],
    ) as ScheduleRow[];

    for (const row of dueRows) {
      const schedule = mapScheduleRow(row);
      if (this.inFlightScheduleIds.has(schedule.id)) continue;
      this.inFlightScheduleIds.add(schedule.id);
      void this.executeDueSchedule(schedule).finally(() => {
        this.inFlightScheduleIds.delete(schedule.id);
      });
    }
  }

  private async executeDueSchedule(schedule: TabSchedule): Promise<void> {
    const runId = `scheduled_${Date.now()}_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const scheduledFor = schedule.nextRunAt ?? startedAt;

    this.db.run(
      "UPDATE tab_schedules SET status = 'running', running_run_id = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status != 'running'",
      [runId, startedAt, schedule.id],
    );
    this.db.run(
      "INSERT INTO tab_schedule_runs (id, schedule_id, scheduled_for, started_at, status) VALUES (?, ?, ?, ?, 'running')",
      [runId, schedule.id, scheduledFor, startedAt],
    );

    let result: ScheduledExecutionResult;
    try {
      result = await this.execute({
        runId,
        schedule: { ...schedule, status: "running", runningRunId: runId },
      });
    } catch (error) {
      result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }

    const finishedAt = new Date().toISOString();
    const current = this.getById(schedule.id);
    if (current) {
      const now = Date.now();
      const nextBaseMs = current.enabled ? calculateFollowingBase(current, now) : null;
      const nextRunMs = nextBaseMs === null ? null : addStartJitter(nextBaseMs);
      this.db.run(
        `UPDATE tab_schedules SET
          status = ?, running_run_id = NULL, last_run_at = ?, last_run_status = ?,
          last_error = ?, next_base_at = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
        [
          result.status === "failed" ? "error" : "idle",
          finishedAt,
          result.status,
          result.error ?? null,
          nextBaseMs === null ? null : new Date(nextBaseMs).toISOString(),
          nextRunMs === null ? null : new Date(nextRunMs).toISOString(),
          finishedAt,
          schedule.id,
        ],
      );
    }

    this.db.run(
      "UPDATE tab_schedule_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?",
      [result.status, finishedAt, result.error ?? null, runId],
    );

    if (result.status === "failed") {
      this.logger.error(
        `[Scheduler] ${schedule.targetUrl} failed: ${result.error ?? "unknown error"}`,
      );
    } else if (result.status === "skipped") {
      this.logger.warn(
        `[Scheduler] ${schedule.targetUrl} skipped: ${result.error ?? "target busy"}`,
      );
    } else {
      this.logger.info(`[Scheduler] ${schedule.targetUrl} completed.`);
    }
  }
}
