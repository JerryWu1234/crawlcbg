export type ManualExecutionMode = "visible" | "background";
export type BackgroundExecutionStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type BrowserActivityKind = "execution" | "recording";

export type ExecutionEventPayload = { type: string; [key: string]: unknown };

export interface ActiveTargetExecution {
  runId: string;
}

export interface BrowserActivityLease {
  kind: BrowserActivityKind;
  ownerId: string;
}

export interface BrowserActivityConflict {
  kind: BrowserActivityKind;
  ownerId: string;
}

export type BrowserActivityLeaseResult =
  | { acquired: true; lease: BrowserActivityLease }
  | { acquired: false; conflict: BrowserActivityConflict };

export interface BackgroundExecutionOwnership {
  rootTargetIds: Set<string>;
  targetIds: Set<string>;
  windowIds: Set<number>;
}

export interface BackgroundExecutionRecord {
  runId: string;
  mode: "background";
  status: BackgroundExecutionStatus;
  filename: string;
  targetUrl: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  nextSequence: number;
  events: Array<{ sequence: number; event: ExecutionEventPayload }>;
}

export interface SerializedBackgroundExecution {
  runId: string;
  mode: "background";
  status: BackgroundExecutionStatus;
  filename: string;
  targetUrl: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  events: Array<{ sequence: number; event: ExecutionEventPayload }>;
}

const BACKGROUND_EXECUTION_RETENTION_MS = 6 * 60 * 60 * 1_000;
const MAX_BACKGROUND_EXECUTION_EVENTS = 1_000;

export class ExecutionCoordinator {
  private readonly activeScriptExecutions = new Map<string, AbortController>();
  private readonly activeTargetExecutions = new Map<string, ActiveTargetExecution>();
  private readonly backgroundExecutionOwnerships = new Map<string, BackgroundExecutionOwnership>();
  private activeBackgroundExecutionRunId: string | null = null;
  private readonly backgroundExecutionRecords = new Map<string, BackgroundExecutionRecord>();
  private readonly activeExecutionActivities = new Set<string>();
  private activeRecordingActivityId: string | null = null;

  acquireBrowserActivity(kind: BrowserActivityKind, ownerId: string): BrowserActivityLeaseResult {
    if (kind === "execution") {
      if (this.activeRecordingActivityId) {
        return {
          acquired: false,
          conflict: { kind: "recording", ownerId: this.activeRecordingActivityId },
        };
      }
      this.activeExecutionActivities.add(ownerId);
      return { acquired: true, lease: { kind, ownerId } };
    }

    if (this.activeRecordingActivityId) {
      return {
        acquired: false,
        conflict: { kind: "recording", ownerId: this.activeRecordingActivityId },
      };
    }
    const activeExecutionId = this.activeExecutionActivities.values().next().value as
      | string
      | undefined;
    const blockingBackgroundRunId = this.getBlockingBackgroundRunId();
    const blockingExecutionId = activeExecutionId ?? blockingBackgroundRunId;
    if (blockingExecutionId) {
      return {
        acquired: false,
        conflict: { kind: "execution", ownerId: blockingExecutionId },
      };
    }

    this.activeRecordingActivityId = ownerId;
    return { acquired: true, lease: { kind, ownerId } };
  }

  releaseBrowserActivity(lease: BrowserActivityLease): void {
    if (lease.kind === "execution") {
      this.activeExecutionActivities.delete(lease.ownerId);
      return;
    }
    if (this.activeRecordingActivityId === lease.ownerId) {
      this.activeRecordingActivityId = null;
    }
  }

  hasScriptExecution(runId: string): boolean {
    return this.activeScriptExecutions.has(runId);
  }

  registerScriptExecution(runId: string, controller: AbortController): void {
    this.activeScriptExecutions.set(runId, controller);
  }

  releaseScriptExecution(runId: string, controller: AbortController): void {
    if (this.activeScriptExecutions.get(runId) === controller) {
      this.activeScriptExecutions.delete(runId);
    }
  }

  cancelScriptExecution(runId: string): boolean {
    const controller = this.activeScriptExecutions.get(runId);
    if (!controller) return false;
    if (!controller.signal.aborted) controller.abort();
    return true;
  }

  getTargetExecutionKey(url: string): string {
    return url.trim();
  }

  getTargetExecution(targetKey: string): ActiveTargetExecution | undefined {
    return this.activeTargetExecutions.get(targetKey);
  }

  setTargetExecution(targetKey: string, runId: string): void {
    this.activeTargetExecutions.set(targetKey, { runId });
  }

  releaseTargetExecution(targetKey: string, runId: string): void {
    const activeExecution = this.activeTargetExecutions.get(targetKey);
    if (activeExecution?.runId === runId) {
      this.activeTargetExecutions.delete(targetKey);
    }
  }

  getBackgroundExecutionOwnerships(): BackgroundExecutionOwnership[] {
    return [...this.backgroundExecutionOwnerships.values()];
  }

  getBlockingBackgroundRunId(): string | null | undefined {
    return (
      this.activeBackgroundExecutionRunId || this.backgroundExecutionOwnerships.keys().next().value
    );
  }

  setActiveBackgroundExecutionRunId(runId: string): void {
    this.activeBackgroundExecutionRunId = runId;
  }

  releaseActiveBackgroundExecutionRunId(runId: string): void {
    if (this.activeBackgroundExecutionRunId === runId) {
      this.activeBackgroundExecutionRunId = null;
    }
  }

  createBackgroundExecutionOwnership(runId: string): BackgroundExecutionOwnership {
    const ownership: BackgroundExecutionOwnership = {
      rootTargetIds: new Set(),
      targetIds: new Set(),
      windowIds: new Set(),
    };
    this.backgroundExecutionOwnerships.set(runId, ownership);
    return ownership;
  }

  releaseBackgroundExecutionOwnership(runId: string): void {
    this.backgroundExecutionOwnerships.delete(runId);
  }

  createBackgroundExecutionRecord(
    runId: string,
    filename: string,
    targetUrl: string,
  ): BackgroundExecutionRecord {
    this.pruneBackgroundExecutionRecords();
    const now = new Date().toISOString();
    const record: BackgroundExecutionRecord = {
      runId,
      mode: "background",
      status: "starting",
      filename,
      targetUrl,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      nextSequence: 1,
      events: [],
    };
    this.backgroundExecutionRecords.set(runId, record);
    return record;
  }

  appendBackgroundExecutionEvent(
    record: BackgroundExecutionRecord | null,
    event: ExecutionEventPayload,
  ): ExecutionEventPayload {
    if (!record) return event;

    const sequence = record.nextSequence++;
    const storedEvent = { ...event, sequence };
    record.events.push({ sequence, event: storedEvent });
    if (record.events.length > MAX_BACKGROUND_EXECUTION_EVENTS) {
      record.events.splice(0, record.events.length - MAX_BACKGROUND_EXECUTION_EVENTS);
    }

    if (event.type === "started") record.status = "running";
    if (event.type === "done") record.status = "completed";
    if (event.type === "error") record.status = "failed";
    if (event.type === "cancelled") record.status = "cancelled";

    record.updatedAt = new Date().toISOString();
    if (["done", "error", "cancelled"].includes(event.type)) {
      record.finishedAt = record.updatedAt;
    }
    return storedEvent;
  }

  getSerializedBackgroundExecution(
    runId: string,
    afterSequence: number,
  ): SerializedBackgroundExecution | null {
    this.pruneBackgroundExecutionRecords();
    const record = this.backgroundExecutionRecords.get(runId);
    if (!record) return null;
    return {
      ...this.serializeBackgroundExecution(record),
      events: record.events.filter((stored) => stored.sequence > afterSequence),
    };
  }

  private pruneBackgroundExecutionRecords(): void {
    const cutoff = Date.now() - BACKGROUND_EXECUTION_RETENTION_MS;
    for (const [runId, record] of this.backgroundExecutionRecords) {
      if (record.finishedAt && Date.parse(record.finishedAt) < cutoff) {
        this.backgroundExecutionRecords.delete(runId);
      }
    }
  }

  private serializeBackgroundExecution(
    record: BackgroundExecutionRecord,
  ): SerializedBackgroundExecution {
    return {
      runId: record.runId,
      mode: record.mode,
      status: record.status,
      filename: record.filename,
      targetUrl: record.targetUrl,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
      events: record.events,
    };
  }
}
