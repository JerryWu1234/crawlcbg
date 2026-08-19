import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  Agent,
  assertJsonSerializable,
  buildSessionContext,
  compact,
  convertToLlm,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  ok,
  prepareCompaction,
  Session,
  SessionError,
  shouldCompact,
  type AgentEvent,
  type AgentMessage,
  type Entry,
  type LogItem,
  type NewRecord,
  type ProvisionedEntry,
  type SessionStats,
} from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  createNodeSqliteFactory,
  SqliteSessionRepository,
  type SqliteSessionMetadata,
} from "@earendil-works/pi-session-backend-sqlite-node";

import type { TableSnapshot } from "./database-registry.js";
import {
  getApiKey,
  getConfiguredModels,
  getModelCatalog,
  getPiModel,
  resolveModelChoice,
} from "./model-config.js";
import { WorkspaceSandbox } from "./sandbox-tools.js";
import {
  buildDataContext,
  deleteWorkspace,
  getWorkspace,
  getWorkspacesRoot,
  readSnapshotsFromWorkspace,
  type SnapshotManifest,
  type WorkspaceInfo,
} from "./workspace-manager.js";

const APPLICATION_ID = "crawlcbg-pi-agent";
const METADATA_VERSION = 1;
const THINKING_LEVEL = "medium" as const;

export { ModelValidationError } from "./model-config.js";

export interface ContextEstimate {
  estimatedTokens: number;
  contextWindow: number;
  reserveTokens: number;
  effectiveWindow: number;
}

export interface SnapshotSummary {
  totalRows: number;
  totalBytes: number;
  tables: SnapshotManifest["tables"];
}

export interface SessionInfo {
  sessionId: string;
  runId: string;
  databaseId: string;
  databaseName: string;
  tableNames: string[];
  /** Catalog alias, stable across gateways. */
  modelId: string;
  createdAt: string;
  lastActiveAt: string;
  title?: string;
  snapshot: SnapshotSummary;
  context: ContextEstimate;
}

export interface AgentStreamEvent {
  type: string;
  data?: unknown;
}

export interface PromptResult {
  status: "completed" | "error" | "aborted";
  message?: string;
}

interface CrawlSessionMetadata extends Record<string, unknown> {
  application: typeof APPLICATION_ID;
  version: typeof METADATA_VERSION;
  runId: string;
  databaseId: string;
  databaseName: string;
  tableNames: string[];
  modelId: string;
  title?: string;
  snapshot: SnapshotSummary;
  context: ContextEstimate;
}

interface RunPersistenceState {
  runId: string;
  nextMessageOrdinal: number;
  nextCompactionOrdinal: number;
  finalAssistant?: AssistantMessage;
}

interface ActiveSession {
  agent: Agent;
  piSession: Session<SqliteSessionMetadata>;
  metadata: SqliteSessionMetadata;
  info: SessionInfo;
  workspace: WorkspaceInfo;
  sandbox: WorkspaceSandbox;
  systemPrompt: string;
  staticContextTokens: number;
  currentRun?: RunPersistenceState;
}

const activeSessions = new Map<string, ActiveSession>();
let sessionRepo: SqliteSessionRepository | null = null;

function sanitizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getSessionRepository(): SqliteSessionRepository {
  if (sessionRepo) return sessionRepo;
  const workspacesRoot = getWorkspacesRoot();
  fs.mkdirSync(workspacesRoot, { recursive: true, mode: 0o700 });
  sessionRepo = new SqliteSessionRepository({
    env: {
      absolutePath: async (value: string) => ok(path.resolve(value)),
      createDir: async (value: string) => {
        fs.mkdirSync(value, { recursive: true, mode: 0o700 });
        return ok(undefined);
      },
      exists: async (value: string) => ok(fs.existsSync(value)),
    },
    sqlite: createNodeSqliteFactory(),
    databasePath: path.join(workspacesRoot, "pi-sessions.sqlite"),
  });
  return sessionRepo;
}

/**
 * Normalizes a client-supplied model selector to a catalog alias. Kept as the
 * route-facing name; aliases and raw wire ids both resolve.
 */
export function resolveModelId(modelId?: string): string {
  return resolveModelChoice(modelId).alias;
}

function buildSystemPrompt(dataContext: string): string {
  return `你是一个数据分析助手（PI Agent），正在分析用户显式选择的本地 SQLite 数据。

## 隔离运行环境

你只能访问当前会话的虚拟目录：
- /workspace/input：不可变的 schema、全量数据快照和初始 Prompt，只读。
- /workspace/work：可自由创建、修改和执行文件。
- /workspace/output：保存最终报告、代码、数据库副本和导出产物。
- /workspace/logs：命令和工具日志。

文件工具使用上述虚拟绝对路径。Shell 默认工作目录是 work；macOS Seatbelt 不创建 \`/workspace\` 挂载，因此 Shell 中请使用相对路径（例如 \`../input\`、\`.\`、\`../output\`）或环境变量 \`WORKSPACE_INPUT\`、\`WORKSPACE_WORK\`、\`WORKSPACE_OUTPUT\`、\`WORKSPACE_LOGS\`。不要在 Shell 命令中直接使用 \`/workspace/...\`。

文件和 Shell 工具由操作系统沙箱约束，不能访问宿主项目、原数据库、其他会话或宿主秘密。网络保持开放。不要尝试绕过沙箱。

## 数据快照

以下是用户选择表的完整 schema 和全部数据；同样的数据保存在 /workspace/input。每行都有本会话稳定的证据标识符。

${dataContext}

## 回答要求

1. 只基于当前快照和你在当前 workspace 中生成的派生内容回答。
2. 依赖数据的事实、归纳、比较或统计结论必须就近引用证据，格式为 [表名#行号]。
3. 没有足够信息时明确说明，不得编造证据。
4. 普通问候和不涉及数据的回答无需证据。
5. 可使用 Markdown；需要产物时写入 /workspace/output。`;
}

function snapshotSummary(manifest: SnapshotManifest): SnapshotSummary {
  return {
    totalRows: manifest.totalRows,
    totalBytes: manifest.totalBytes,
    tables: manifest.tables,
  };
}

function staticContextTokenEstimate(systemPrompt: string, sandbox: WorkspaceSandbox): number {
  const toolDescription = JSON.stringify(
    sandbox.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
  return estimateTokens({
    role: "user",
    content: [{ type: "text", text: `${systemPrompt}\n\nAvailable tools:\n${toolDescription}` }],
    timestamp: 0,
  });
}

function initialContextEstimate(
  systemPrompt: string,
  sandbox: WorkspaceSandbox,
  prompt: string,
  model: Model<Api>,
): ContextEstimate {
  const pending: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
  const estimatedTokens =
    staticContextTokenEstimate(systemPrompt, sandbox) + estimateContextTokens([pending]).tokens;
  return {
    estimatedTokens,
    contextWindow: model.contextWindow,
    reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    effectiveWindow: model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens,
  };
}

export class ContextOverflowError extends Error {
  readonly estimatedTokens: number;
  readonly contextWindow: number;
  readonly reserveTokens: number;
  readonly effectiveWindow: number;
  readonly phase: "initial" | "follow_up";

  constructor(details: ContextEstimate & { phase?: "initial" | "follow_up" }) {
    super(
      `完整上下文预估 ${details.estimatedTokens.toLocaleString()} tokens，超过有效窗口 ${details.effectiveWindow.toLocaleString()} tokens（模型窗口 ${details.contextWindow.toLocaleString()}，预留 ${details.reserveTokens.toLocaleString()}）。`,
    );
    this.name = "ContextOverflowError";
    this.estimatedTokens = details.estimatedTokens;
    this.contextWindow = details.contextWindow;
    this.reserveTokens = details.reserveTokens;
    this.effectiveWindow = details.effectiveWindow;
    this.phase = details.phase ?? "initial";
  }
}

function parseCrawlMetadata(metadata: SqliteSessionMetadata): CrawlSessionMetadata | null {
  const value = metadata.metadata as Partial<CrawlSessionMetadata> | undefined;
  if (
    value?.application !== APPLICATION_ID ||
    value.version !== METADATA_VERSION ||
    typeof value.runId !== "string" ||
    typeof value.databaseId !== "string" ||
    typeof value.databaseName !== "string" ||
    !Array.isArray(value.tableNames) ||
    typeof value.modelId !== "string" ||
    !value.snapshot ||
    !value.context
  ) {
    return null;
  }
  return value as CrawlSessionMetadata;
}

async function supportedMetadata(): Promise<SqliteSessionMetadata[]> {
  return (await getSessionRepository().list()).filter((metadata) => parseCrawlMetadata(metadata));
}

async function findMetadata(sessionId: string): Promise<SqliteSessionMetadata | undefined> {
  return (await supportedMetadata()).find((metadata) => metadata.id === sessionId);
}

async function getPiSession(
  sessionId: string,
): Promise<{ session: Session<SqliteSessionMetadata>; metadata: SqliteSessionMetadata } | null> {
  const active = activeSessions.get(sessionId);
  if (active) return { session: active.piSession, metadata: active.metadata };
  const metadata = await findMetadata(sessionId);
  if (!metadata) return null;
  return { session: await getSessionRepository().open(metadata), metadata };
}

async function sessionInfoFrom(
  metadata: SqliteSessionMetadata,
  piSession?: Session<SqliteSessionMetadata>,
): Promise<SessionInfo | null> {
  const crawl = parseCrawlMetadata(metadata);
  if (!crawl) return null;
  const session = piSession ?? (await getSessionRepository().open(metadata));
  const log = await session.getLog();
  const lastItem = log.at(-1);
  const lastTimestamp =
    lastItem?.kind === "entry"
      ? lastItem.entry.timestamp
      : lastItem?.kind === "record"
        ? lastItem.record.timestamp
        : metadata.createdAt;
  return {
    sessionId: metadata.id,
    runId: crawl.runId,
    databaseId: crawl.databaseId,
    databaseName: crawl.databaseName,
    tableNames: [...crawl.tableNames],
    modelId: crawl.modelId,
    createdAt: new Date(metadata.createdAt).toISOString(),
    lastActiveAt: new Date(lastTimestamp ?? metadata.createdAt).toISOString(),
    title: crawl.title,
    snapshot: crawl.snapshot,
    context: crawl.context,
  };
}

async function appendEntryOnce(
  piSession: Session<SqliteSessionMetadata>,
  entry: ProvisionedEntry,
): Promise<string> {
  try {
    const committed = await piSession.appendEntry<Entry>(sanitizeJson(entry), "main");
    return committed.id;
  } catch (error) {
    if (error instanceof SessionError && error.code === "already_exists") return entry.id;
    throw error;
  }
}

async function appendRecordOnce(
  piSession: Session<SqliteSessionMetadata>,
  record: NewRecord,
): Promise<void> {
  try {
    await piSession.appendRecord(sanitizeJson(record));
  } catch (error) {
    if (!(error instanceof SessionError) || error.code !== "already_exists") throw error;
  }
}

function usageStopReason(
  message: AssistantMessage,
): Exclude<AssistantMessage["stopReason"], "pending"> {
  return message.stopReason === "pending" ? "error" : message.stopReason;
}

async function persistMessage(active: ActiveSession, message: AgentMessage): Promise<string> {
  const run = active.currentRun;
  if (!run) throw new Error("PI Agent emitted a message outside a durable run");
  const ordinal = run.nextMessageOrdinal++;
  const entryId = `${run.runId}:message:${ordinal}`;
  await appendEntryOnce(active.piSession, {
    id: entryId,
    type: "message",
    message: sanitizeJson(message),
  });

  if (message.role === "assistant") {
    run.finalAssistant = message;
    await appendRecordOnce(active.piSession, {
      id: `${entryId}:usage`,
      type: "usage",
      lane: "main",
      cause: "assistant",
      runId: run.runId,
      entryId,
      attempt: 1,
      stopReason: usageStopReason(message),
      usage: sanitizeJson(message.usage),
    });
  } else if (message.role === "toolResult" && message.usage) {
    await appendRecordOnce(active.piSession, {
      id: `${entryId}:usage`,
      type: "usage",
      lane: "main",
      cause: "tool",
      runId: run.runId,
      entryId,
      toolCallId: message.toolCallId,
      usage: sanitizeJson(message.usage),
    });
  }
  return entryId;
}

async function synchronizeAgentMessages(active: ActiveSession): Promise<AgentMessage[]> {
  const entries = await active.piSession.findEntriesOnBranch({ order: "oldestFirst" });
  const messages = buildSessionContext(entries).messages;
  active.agent.state.messages = messages;
  return messages;
}

async function compactContextIfRequired(
  active: ActiveSession,
  messages: AgentMessage[],
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const model = active.agent.state.model;
  const estimate = active.staticContextTokens + estimateContextTokens(messages).tokens;
  if (!shouldCompact(estimate, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return messages;

  const run = active.currentRun;
  if (!run) throw new Error("Compaction requested outside a durable run");
  const pathEntries = await active.piSession.findEntriesOnBranch({ order: "oldestFirst" });
  const prepared = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);
  if (!prepared.ok) throw prepared.error;

  if (prepared.value) {
    const generated = await compact(
      prepared.value,
      getConfiguredModels(),
      model,
      undefined,
      signal,
      active.agent.state.thinkingLevel,
    );
    if (!generated.ok) throw generated.error;
    const ordinal = run.nextCompactionOrdinal++;
    const entryId = `${run.runId}:compaction:${ordinal}`;
    const compacted = generated.value;
    await appendEntryOnce(active.piSession, {
      id: entryId,
      type: "compaction",
      summary: compacted.summary,
      retainedTail: sanitizeJson(compacted.retainedTail),
      tokensBefore: compacted.tokensBefore,
      ...(compacted.details === undefined ? {} : { details: sanitizeJson(compacted.details) }),
      ...(compacted.usage === undefined ? {} : { usage: sanitizeJson(compacted.usage) }),
    });
    if (compacted.usage) {
      await appendRecordOnce(active.piSession, {
        id: `${entryId}:usage`,
        type: "usage",
        lane: "main",
        cause: "compaction",
        runId: run.runId,
        entryId,
        attempt: 1,
        stopReason: "stop",
        usage: sanitizeJson(compacted.usage),
      });
    }
  }

  const compactedMessages = buildSessionContext(
    await active.piSession.findEntriesOnBranch({ order: "oldestFirst" }),
  ).messages;
  const afterEstimate =
    active.staticContextTokens + estimateContextTokens(compactedMessages).tokens;
  const effectiveWindow = model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  if (afterEstimate > effectiveWindow) {
    throw new ContextOverflowError({
      estimatedTokens: afterEstimate,
      contextWindow: model.contextWindow,
      reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      effectiveWindow,
      phase: "follow_up",
    });
  }
  return compactedMessages;
}

function installPersistenceListener(active: ActiveSession): void {
  active.agent.subscribe(async (event) => {
    if (event.type === "message_end") {
      await persistMessage(active, event.message);
      return;
    }
    if (event.type !== "agent_end") return;

    const run = active.currentRun;
    if (!run) return;
    const final = run.finalAssistant;
    const outcome =
      final?.stopReason === "aborted"
        ? "aborted"
        : final?.stopReason === "error"
          ? "failed"
          : "completed";
    await appendRecordOnce(active.piSession, {
      id: `${run.runId}:finished`,
      type: "operation_finished",
      lane: "main",
      runId: run.runId,
      outcome,
      ...(outcome === "failed"
        ? { error: { code: "agent_error", message: final?.errorMessage || "Agent failed" } }
        : {}),
    });
    await synchronizeAgentMessages(active);
    active.currentRun = undefined;
  });
}

function createAgentRuntime(options: {
  piSession: Session<SqliteSessionMetadata>;
  metadata: SqliteSessionMetadata;
  info: SessionInfo;
  workspace: WorkspaceInfo;
  sandbox: WorkspaceSandbox;
  systemPrompt: string;
  model: Model<Api>;
  messages: AgentMessage[];
}): ActiveSession {
  const runtimeRef: { active?: ActiveSession } = {};
  const staticTokens = staticContextTokenEstimate(options.systemPrompt, options.sandbox);
  const providerId = getModelCatalog().providerId;
  const agent = new Agent({
    sessionId: options.metadata.id,
    convertToLlm,
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: THINKING_LEVEL,
      tools: options.sandbox.tools,
      messages: options.messages,
    },
    streamFn: (model, context, streamOptions) =>
      getConfiguredModels().streamSimple(model, context, streamOptions),
    getApiKey: async (provider: string) => (provider === providerId ? getApiKey() : undefined),
    transformContext: async (messages, signal) => {
      const active = runtimeRef.active;
      if (!active) throw new Error("PI Agent runtime is not initialized");
      return compactContextIfRequired(active, messages, signal);
    },
  });

  const active: ActiveSession = {
    agent,
    piSession: options.piSession,
    metadata: options.metadata,
    info: options.info,
    workspace: options.workspace,
    sandbox: options.sandbox,
    systemPrompt: options.systemPrompt,
    staticContextTokens: staticTokens,
  };
  runtimeRef.active = active;
  installPersistenceListener(active);
  return active;
}

export async function createSession(params: {
  databaseId: string;
  databaseName: string;
  tableNames: string[];
  snapshots: Map<string, TableSnapshot>;
  prompt: string;
  modelId?: string;
  workspace: WorkspaceInfo;
  manifest: SnapshotManifest;
}): Promise<{ sessionId: string; info: SessionInfo }> {
  const modelChoice = resolveModelChoice(params.modelId);
  const model = getPiModel(modelChoice.alias);
  const sandbox = new WorkspaceSandbox(params.workspace);
  const systemPrompt = buildSystemPrompt(buildDataContext(params.snapshots));
  const context = initialContextEstimate(systemPrompt, sandbox, params.prompt, model);
  if (context.estimatedTokens > context.effectiveWindow) {
    await sandbox.cleanup();
    throw new ContextOverflowError(context);
  }

  const sessionId = crypto.randomUUID();
  const title = params.prompt.trim().slice(0, 80);
  const crawlMetadata: CrawlSessionMetadata = {
    application: APPLICATION_ID,
    version: METADATA_VERSION,
    runId: params.workspace.runId,
    databaseId: params.databaseId,
    databaseName: params.databaseName,
    tableNames: [...params.tableNames],
    modelId: modelChoice.alias,
    title,
    snapshot: snapshotSummary(params.manifest),
    context,
  };

  let piSession: Session<SqliteSessionMetadata> | undefined;
  try {
    piSession = await getSessionRepository().create({
      id: sessionId,
      cwd: params.workspace.rootDir,
      metadata: sanitizeJson(crawlMetadata),
    });
    const metadata = await piSession.getMetadata();
    const info = (await sessionInfoFrom(metadata, piSession))!;
    const active = createAgentRuntime({
      piSession,
      metadata,
      info,
      workspace: params.workspace,
      sandbox,
      systemPrompt,
      model,
      messages: [],
    });
    activeSessions.set(sessionId, active);
    return { sessionId, info };
  } catch (error) {
    await sandbox.cleanup();
    if (piSession) {
      try {
        await getSessionRepository().delete(await piSession.getMetadata());
      } catch {
        // Preserve the creation error.
      }
    }
    throw error;
  }
}

/** Falls back to the default entry so reconfiguring the catalog does not make
 *  older sessions unopenable. */
function restoredModel(alias: string): Model<Api> {
  try {
    return getPiModel(resolveModelChoice(alias).alias);
  } catch {
    const fallback = resolveModelChoice();
    console.warn(
      `[PI Agent] Session model "${alias}" is not configured; resuming with "${fallback.alias}".`,
    );
    return getPiModel(fallback.alias);
  }
}

export async function restoreSession(sessionId: string): Promise<boolean> {
  if (activeSessions.has(sessionId)) return true;
  const opened = await getPiSession(sessionId);
  if (!opened) return false;
  const crawl = parseCrawlMetadata(opened.metadata);
  if (!crawl) return false;
  const workspace = getWorkspace(crawl.runId);
  if (!workspace) return false;
  const snapshots = readSnapshotsFromWorkspace(workspace);
  if (!snapshots) return false;
  const entries = await opened.session.findEntriesOnBranch({ order: "oldestFirst" });
  const context = buildSessionContext(entries);
  const model = restoredModel(crawl.modelId);
  const sandbox = new WorkspaceSandbox(workspace);
  const info = (await sessionInfoFrom(opened.metadata, opened.session))!;
  const active = createAgentRuntime({
    piSession: opened.session,
    metadata: opened.metadata,
    info,
    workspace,
    sandbox,
    systemPrompt: buildSystemPrompt(buildDataContext(snapshots)),
    model,
    messages: context.messages,
  });
  activeSessions.set(sessionId, active);
  return true;
}

export async function promptSession(
  sessionId: string,
  message: string,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<PromptResult> {
  if (!activeSessions.has(sessionId) && !(await restoreSession(sessionId))) {
    throw new Error(`Session "${sessionId}" not found`);
  }
  const active = activeSessions.get(sessionId)!;
  if (active.agent.state.isStreaming || active.currentRun) {
    throw new SessionBusyError(sessionId);
  }

  const pending: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: message }],
    timestamp: Date.now(),
  };
  const runId = crypto.randomUUID();
  active.currentRun = { runId, nextMessageOrdinal: 0, nextCompactionOrdinal: 0 };
  const sourceLeafId = await active.piSession.getLeafId();
  await appendRecordOnce(active.piSession, {
    id: runId,
    type: "operation_started",
    lane: "main",
    sourceLeafId,
    intent: {
      kind: "run",
      originalPrompt: [sanitizeJson(pending)],
      initialMessages: [
        {
          id: `${runId}:message:0`,
          type: "message",
          message: sanitizeJson(pending),
        },
      ],
    },
  });

  let finalResult: PromptResult = { status: "completed" };
  const unsubscribe = active.agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        onEvent({ type: "agent_start" });
        break;
      case "agent_end":
        onEvent({ type: "agent_end", data: { messageCount: event.messages.length } });
        break;
      case "message_start":
        onEvent({ type: "message_start" });
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          onEvent({ type: "text_delta", data: { text: update.delta } });
        } else if (update.type === "thinking_delta") {
          onEvent({ type: "thinking_delta", data: { text: update.delta } });
        }
        break;
      }
      case "message_end":
        if (event.message.role === "assistant" && event.message.stopReason === "error") {
          // Gateways answer an unknown model id with an empty-bodied 403 that
          // the OpenAI SDK renders as "403 status code (no body)". Name the
          // endpoint and model so the cause is visible.
          finalResult = {
            status: "error",
            message: `${event.message.errorMessage || "Agent failed"} [endpoint=${getModelCatalog().baseUrl} model=${active.agent.state.model.id}]`,
          };
        } else if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
          finalResult = {
            status: "aborted",
            message: event.message.errorMessage || "Agent aborted",
          };
        }
        onEvent({ type: "message_end", data: { role: event.message.role } });
        break;
      case "tool_execution_start":
        onEvent({
          type: "tool_start",
          data: { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
        });
        break;
      case "tool_execution_update":
        onEvent({
          type: "tool_update",
          data: { toolCallId: event.toolCallId, toolName: event.toolName },
        });
        break;
      case "tool_execution_end":
        onEvent({
          type: "tool_end",
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
        });
        break;
      case "turn_start":
        onEvent({ type: "turn_start" });
        break;
      case "turn_end":
        onEvent({ type: "turn_end" });
        break;
    }
  });

  try {
    await active.agent.prompt(pending);
    return finalResult;
  } finally {
    unsubscribe();
  }
}

export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is already running`);
    this.name = "SessionBusyError";
  }
}

export async function abortSession(sessionId: string): Promise<boolean> {
  const active = activeSessions.get(sessionId);
  if (!active || !active.agent.state.isStreaming) return false;
  const runId = active.currentRun?.runId;
  if (runId) {
    await appendRecordOnce(active.piSession, {
      id: `${runId}:abort`,
      type: "abort_requested",
      lane: "main",
      runId,
    });
  }
  active.agent.abort();
  await active.agent.waitForIdle();
  return true;
}

export async function listSessions(): Promise<SessionInfo[]> {
  const sessions = await Promise.all(
    (await supportedMetadata()).map(async (metadata) => sessionInfoFrom(metadata)),
  );
  return sessions
    .filter((info): info is SessionInfo => info !== null)
    .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
}

export async function getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
  const active = activeSessions.get(sessionId);
  if (active) return (await sessionInfoFrom(active.metadata, active.piSession)) ?? undefined;
  const opened = await getPiSession(sessionId);
  return opened
    ? ((await sessionInfoFrom(opened.metadata, opened.session)) ?? undefined)
    : undefined;
}

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

export function isSessionBusy(sessionId: string): boolean {
  const active = activeSessions.get(sessionId);
  return Boolean(active && (active.agent.state.isStreaming || active.currentRun));
}

export async function getSessionMessages(sessionId: string): Promise<AgentMessage[] | null> {
  const opened = await getPiSession(sessionId);
  if (!opened) return null;
  return buildSessionContext(await opened.session.findEntriesOnBranch({ order: "oldestFirst" }))
    .messages;
}

export async function getSessionStats(
  sessionId: string,
): Promise<(SessionStats & { context: ContextEstimate; snapshot: SnapshotSummary }) | null> {
  const opened = await getPiSession(sessionId);
  if (!opened) return null;
  const crawl = parseCrawlMetadata(opened.metadata);
  if (!crawl) return null;
  return { ...(await opened.session.getStats()), context: crawl.context, snapshot: crawl.snapshot };
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const metadata = activeSessions.get(sessionId)?.metadata ?? (await findMetadata(sessionId));
  if (!metadata) return false;
  const crawl = parseCrawlMetadata(metadata);
  const active = activeSessions.get(sessionId);
  if (active) {
    active.agent.abort();
    await active.agent.waitForIdle();
    await active.sandbox.cleanup();
  }
  if (crawl) deleteWorkspace(crawl.runId);
  await getSessionRepository().delete(metadata);
  activeSessions.delete(sessionId);
  return true;
}

function logItemMutation(item: LogItem): Record<string, unknown> {
  switch (item.kind) {
    case "entry":
      return { kind: "entry", ...item.entry };
    case "record":
      return { kind: "record", ...item.record };
    case "lane":
      return { kind: "lane", seq: item.seq, lane: item.lane, leafId: item.leafId };
    case "fact":
      if (item.fact === "name") {
        return item.name === undefined
          ? { kind: "fact", seq: item.seq, fact: "name" }
          : { kind: "fact", seq: item.seq, fact: "name", name: item.name };
      }
      return item.label === undefined
        ? { kind: "fact", seq: item.seq, fact: "label", targetId: item.targetId }
        : {
            kind: "fact",
            seq: item.seq,
            fact: "label",
            targetId: item.targetId,
            label: item.label,
          };
  }
}

export async function exportSessionJsonl(
  sessionId: string,
): Promise<{ fileName: string; filePath: string }> {
  const opened = await getPiSession(sessionId);
  if (!opened) throw new Error("Session not found");
  const crawl = parseCrawlMetadata(opened.metadata);
  if (!crawl) throw new Error("Unsupported session metadata");
  const active = activeSessions.get(sessionId);
  if (active?.agent.state.isStreaming) throw new SessionBusyError(sessionId);
  const workspace = getWorkspace(crawl.runId);
  if (!workspace) throw new Error("Session workspace not found");

  const header = sanitizeJson({
    kind: "header",
    version: 4,
    id: opened.metadata.id,
    createdAt: opened.metadata.createdAt,
    cwd: opened.metadata.cwd,
    ...(opened.metadata.parentSessionId
      ? { parentSessionId: opened.metadata.parentSessionId }
      : {}),
    ...(opened.metadata.metadata ? { metadata: opened.metadata.metadata } : {}),
  });
  const log = await opened.session.getLog();
  const mutations = log.map((item) => sanitizeJson(logItemMutation(item)));
  let sequence = log.at(-1)?.seq ?? 0;
  for (const lane of await opened.session.getLanes()) {
    mutations.push({ kind: "lane", seq: ++sequence, lane: lane.lane, leafId: lane.leafId });
  }
  const rows = [header, ...mutations];
  for (const row of rows) assertJsonSerializable(row);
  const content = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const fileName = `pi-session-${sessionId}.jsonl`;
  const filePath = path.join(workspace.outputDir, fileName);
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  return { fileName, filePath };
}

export async function closePiAgentResources(): Promise<void> {
  for (const active of activeSessions.values()) {
    active.agent.abort();
  }
  await Promise.all(
    [...activeSessions.values()].map(async (active) => {
      await active.agent.waitForIdle();
      await active.sandbox.cleanup();
    }),
  );
  activeSessions.clear();
  if (sessionRepo) {
    await sessionRepo.close();
    sessionRepo = null;
  }
}
