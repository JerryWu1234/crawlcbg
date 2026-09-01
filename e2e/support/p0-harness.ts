import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http, { type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createP0Scripts, P0_SCRIPT_NAMES } from "../fixtures/p0-scripts";
import { fixturePopupHtml, fixtureRootHtml, fixtureStaleHtml } from "../fixtures/p0-site";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_MARKER = ".crawlcbg-p0-e2e";
const PROCESS_OUTPUT_LIMIT = 250;
const PUBLIC_ALPHA = "P0_PUBLIC_ALPHA";
const PUBLIC_BETA = "P0_PUBLIC_BETA";

interface OwnedProcess {
  child: ChildProcess;
  name: string;
  output: string[];
}

interface FixtureState {
  abortedGates: Record<string, number>;
  gateRequests: Record<string, number>;
  marks: Record<string, number>;
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  openerId?: string;
}

interface P0Endpoints {
  apiBaseUrl: string;
  fixtureUrl: string;
  websiteUrl: string;
}

interface BrowserTargetSnapshot {
  baselineCount: number;
  extraTargets: Array<{
    targetId: string;
    title: string;
    url: string;
    windowId: number | null;
    windowState: string;
  }>;
}

const emptyFixtureState = (): FixtureState => ({
  abortedGates: {},
  gateRequests: {},
  marks: {},
});

const increment = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1;
};

const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配本地 E2E 端口。"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const waitForHttp = async (url: string, label: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} 未在 ${timeoutMs}ms 内就绪：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};

const appendOutput = (owned: OwnedProcess, chunk: Buffer | string): void => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue;
    owned.output.push(line);
  }
  if (owned.output.length > PROCESS_OUTPUT_LIMIT) {
    owned.output.splice(0, owned.output.length - PROCESS_OUTPUT_LIMIT);
  }
};

const spawnOwned = (
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): OwnedProcess => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const owned: OwnedProcess = { child, name, output: [] };
  child.stdout?.on("data", (chunk) => appendOutput(owned, chunk));
  child.stderr?.on("data", (chunk) => appendOutput(owned, chunk));
  return owned;
};

const ownedProcessIsRunning = (owned: OwnedProcess): boolean => {
  if (process.platform === "win32" || !owned.child.pid) {
    return owned.child.exitCode === null && owned.child.signalCode === null;
  }
  try {
    process.kill(-owned.child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const signalOwned = (owned: OwnedProcess, signal: NodeJS.Signals): void => {
  try {
    if (process.platform !== "win32" && owned.child.pid) {
      process.kill(-owned.child.pid, signal);
    } else if (owned.child.exitCode === null && owned.child.signalCode === null) {
      owned.child.kill(signal);
    }
  } catch {
    // The process group may have exited between the liveness check and the signal.
  }
};

const stopOwned = async (owned: OwnedProcess | null, timeoutMs = 5_000): Promise<void> => {
  if (!owned || !ownedProcessIsRunning(owned)) return;

  signalOwned(owned, "SIGTERM");
  const gracefulDeadline = Date.now() + timeoutMs;
  while (ownedProcessIsRunning(owned) && Date.now() < gracefulDeadline) {
    await delay(50);
  }
  if (!ownedProcessIsRunning(owned)) return;

  signalOwned(owned, "SIGKILL");
  const forcedDeadline = Date.now() + 2_000;
  while (ownedProcessIsRunning(owned) && Date.now() < forcedDeadline) {
    await delay(50);
  }
  if (ownedProcessIsRunning(owned)) {
    throw new Error(`无法终止 ${owned.name} 的测试进程组。`);
  }
};

const killOwnedImmediately = (owned: OwnedProcess | null): void => {
  if (owned) signalOwned(owned, "SIGKILL");
};

class CdpClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void; timer: NodeJS.Timeout }
  >();

  constructor(readonly url: string) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(
          new Error(`CDP ${message.error.code ?? "error"}: ${message.error.message ?? "unknown"}`),
        );
      } else {
        request.resolve(message.result);
      }
    });

    socket.addEventListener("close", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("CDP 连接已关闭。"));
      }
      this.pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        socket.removeEventListener("error", handleError);
        resolve();
      };
      const handleError = () => {
        socket.removeEventListener("open", handleOpen);
        reject(new Error(`无法连接 CDP WebSocket：${this.url}`));
      };
      socket.addEventListener("open", handleOpen, { once: true });
      socket.addEventListener("error", handleError, { once: true });
    });
  }

  send<Result = Record<string, never>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Result> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP 连接尚未建立。"));
    }
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, 15_000);
      this.pending.set(id, {
        reject,
        resolve: (value) => resolve(value as Result),
        timer,
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

class P0Harness {
  private apiBaseUrl = "";
  private websiteUrl = "";
  private fixtureBaseUrl = "";
  private fixtureUrl = "";
  private runRoot = "";
  private caseRoot = "";
  private runtimeDir = "";
  private caseNumber = 0;
  private fixtureState = emptyFixtureState();
  private fixtureServer: http.Server | null = null;
  private gateResponses = new Map<string, Set<ServerResponse>>();
  private websiteProcess: OwnedProcess | null = null;
  private serverProcess: OwnedProcess | null = null;
  private chromeProcess: OwnedProcess | null = null;
  private cdp: CdpClient | null = null;
  private baselineTargetIds = new Set<string>();
  private serverPort = 0;
  private websitePort = 0;
  private stopPromise: Promise<void> | null = null;
  private emergencyHandlersInstalled = false;
  private signalCleanupStarted = false;
  private readonly processExitHandler = (): void => {
    this.emergencyKillOwnedProcesses();
    try {
      this.safeRemoveRunRoot();
    } catch {
      // Exit handlers cannot wait; marker-protected cleanup remains best effort.
    }
  };
  private readonly processInterruptHandler = (): void => {
    this.handleTerminationSignal("SIGINT");
  };
  private readonly processTerminateHandler = (): void => {
    this.handleTerminationSignal("SIGTERM");
  };
  private readonly processDisconnectHandler = (): void => {
    const forceTimer = setTimeout(() => {
      this.emergencyKillOwnedProcesses();
    }, 1_000);

    void this.stop()
      .catch(() => {
        this.emergencyKillOwnedProcesses();
      })
      .finally(() => {
        clearTimeout(forceTimer);
      });
  };

  private installEmergencyCleanupHandlers(): void {
    if (this.emergencyHandlersInstalled) return;
    this.emergencyHandlersInstalled = true;
    process.once("exit", this.processExitHandler);
    process.once("SIGINT", this.processInterruptHandler);
    process.once("SIGTERM", this.processTerminateHandler);
    process.once("disconnect", this.processDisconnectHandler);
  }

  private removeEmergencyCleanupHandlers(): void {
    if (!this.emergencyHandlersInstalled) return;
    this.emergencyHandlersInstalled = false;
    process.removeListener("exit", this.processExitHandler);
    process.removeListener("SIGINT", this.processInterruptHandler);
    process.removeListener("SIGTERM", this.processTerminateHandler);
    process.removeListener("disconnect", this.processDisconnectHandler);
  }

  private emergencyKillOwnedProcesses(): void {
    killOwnedImmediately(this.websiteProcess);
    killOwnedImmediately(this.serverProcess);
    killOwnedImmediately(this.chromeProcess);
  }

  private handleTerminationSignal(signal: "SIGINT" | "SIGTERM"): void {
    if (this.signalCleanupStarted) return;
    this.signalCleanupStarted = true;
    const forceTimer = setTimeout(() => {
      this.emergencyKillOwnedProcesses();
      this.removeEmergencyCleanupHandlers();
      process.kill(process.pid, "SIGKILL");
    }, 25_000);

    void this.stop()
      .catch(() => {
        this.emergencyKillOwnedProcesses();
      })
      .finally(() => {
        clearTimeout(forceTimer);
        this.removeEmergencyCleanupHandlers();
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exitCode = signal === "SIGINT" ? 130 : 143;
        }
      });
  }

  async start(): Promise<P0Endpoints> {
    this.installEmergencyCleanupHandlers();
    try {
      this.runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crawlcbg-p0-e2e-"));
      fs.writeFileSync(path.join(this.runRoot, RUN_MARKER), "crawlcbg p0 e2e\n", "utf8");
      fs.writeFileSync(
        path.join(this.runRoot, ".env"),
        "LLM_API_KEY=e2e-not-used\nLLM_UTILITY_MODEL=e2e-not-used\n",
        "utf8",
      );
      fs.mkdirSync(path.join(this.runRoot, "home"));
      fs.mkdirSync(path.join(this.runRoot, "tmp"));

      await this.startFixtureServer();
      this.serverPort = await getFreePort();
      this.websitePort = await getFreePort();
      this.apiBaseUrl = `http://127.0.0.1:${this.serverPort}`;
      this.websiteUrl = `http://127.0.0.1:${this.websitePort}`;

      await this.reset();
      await this.startWebsite();

      return {
        apiBaseUrl: this.apiBaseUrl,
        fixtureUrl: this.fixtureUrl,
        websiteUrl: this.websiteUrl,
      };
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "P0 E2E harness 启动失败，且资源回滚未完整完成。",
        );
      }
      throw error;
    }
  }

  tasks(): Record<string, (argument?: unknown) => unknown> {
    return {
      "p0:backgroundSnapshot": () => this.browserSnapshot(),
      "p0:createDuplicateTab": () => this.createDuplicateTab(),
      "p0:fixtureState": () => this.getFixtureState(),
      "p0:manualClick": (label) => this.clickManualOverlayButton(String(label)),
      "p0:manualFill": (canary) => this.fillManualSecret(String(canary)),
      "p0:manualOverlayVisible": () => this.manualOverlayVisible(),
      "p0:navigateTargetStale": () => this.navigateTargetStale(),
      "p0:privacySnapshot": (canary) => this.privacySnapshot(String(canary)),
      "p0:recordingActions": (canary) => this.performRecordingActions(String(canary)),
      "p0:recordingPaginationActions": async (requestedMode) => {
        const mode = String(requestedMode);
        if (mode !== "button-loop" && mode !== "same-tab-anchor") {
          throw new Error("分页录制任务只支持 button-loop 或 same-tab-anchor。");
        }
        const sessionId = await this.attachToFixtureTarget();
        await this.evaluate(
          sessionId,
          `(() => {
            const fixture = document.querySelector('.pagination-fixture');
            if (!(fixture instanceof HTMLElement)) throw new Error("missing pagination fixture");
            fixture.style.display = "grid";
          })()`,
        );
        const clickWithoutScrolling = async (selector: string): Promise<void> => {
          await this.evaluate(
            sessionId,
            `(() => {
              const element = document.querySelector(${JSON.stringify(selector)});
              if (!(element instanceof HTMLElement)) throw new Error("missing pagination control");
              element.click();
            })()`,
          );
        };

        if (mode === "button-loop") {
          await clickWithoutScrolling('[data-testid="pagination-entry"]');
          await this.evaluate(
            sessionId,
            `(() => {
              const input = document.querySelector('[data-testid="pagination-body"]');
              if (!(input instanceof HTMLInputElement)) throw new Error("missing pagination input");
              input.value = "";
              input.focus();
            })()`,
          );
          if (!this.cdp) throw new Error("CDP 未连接。");
          await this.cdp.send("Input.insertText", { text: "P0 pagination body" }, sessionId);
          await delay(450);
        } else {
          await clickWithoutScrolling('[data-testid="pagination-anchor"]');
          await delay(100);
        }
        await clickWithoutScrolling('[data-testid="pagination-next"]');
        await delay(300);
        return { completed: true };
      },
      "p0:releaseGate": (name) => this.releaseGate(String(name)),
      "p0:reset": () => this.reset(),
      "p0:runtimeState": () => this.runtimeState(),
    };
  }

  async stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    const captureCleanupError = async (action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    const websiteProcess = this.websiteProcess;
    await captureCleanupError(() => stopOwned(websiteProcess));
    if (!websiteProcess || !ownedProcessIsRunning(websiteProcess)) this.websiteProcess = null;

    await captureCleanupError(() => this.stopManagedStack());
    await captureCleanupError(() => this.stopFixtureServer());

    const ownedProcessRemains = [this.websiteProcess, this.serverProcess, this.chromeProcess].some(
      (owned) => owned && ownedProcessIsRunning(owned),
    );
    if (ownedProcessRemains) {
      cleanupErrors.push(new Error("仍有 P0 E2E 子进程存活，保留 marker-protected 临时目录。"));
    } else {
      try {
        this.safeRemoveRunRoot();
      } catch (error) {
        cleanupErrors.push(error);
      }
      this.removeEmergencyCleanupHandlers();
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "P0 E2E harness 资源清理失败。");
    }
  }

  private async reset(): Promise<P0Endpoints> {
    await this.stopManagedStack();
    this.resetFixtureState();
    this.safeRemoveCaseRoot();

    this.caseNumber += 1;
    this.caseRoot = path.join(this.runRoot, `case-${this.caseNumber}`);
    this.runtimeDir = path.join(this.caseRoot, "runtime");
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(this.caseRoot, RUN_MARKER), "crawlcbg p0 case\n", "utf8");
    this.seedRuntime();

    await this.startChrome();
    await this.startServer();

    return {
      apiBaseUrl: this.apiBaseUrl,
      fixtureUrl: this.fixtureUrl,
      websiteUrl: this.websiteUrl,
    };
  }

  private async startFixtureServer(): Promise<void> {
    const port = await getFreePort();
    this.fixtureBaseUrl = `http://127.0.0.1:${port}`;
    this.fixtureUrl = `${this.fixtureBaseUrl}/`;

    this.fixtureServer = http.createServer((request, response) => {
      const url = new URL(request.url || "/", this.fixtureBaseUrl);
      if (request.method === "POST" && url.pathname.startsWith("/mark/")) {
        const name = decodeURIComponent(url.pathname.slice("/mark/".length));
        increment(this.fixtureState.marks, name);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/gate/")) {
        const name = decodeURIComponent(url.pathname.slice("/gate/".length));
        increment(this.fixtureState.gateRequests, name);
        const responses = this.gateResponses.get(name) ?? new Set<ServerResponse>();
        this.gateResponses.set(name, responses);
        responses.add(response);
        let released = false;
        response.once("close", () => {
          responses.delete(response);
          if (!released && !response.writableEnded) increment(this.fixtureState.abortedGates, name);
        });
        response.once("finish", () => {
          released = true;
          responses.delete(response);
        });
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "P0 E2E blocks all LLM calls." }));
        return;
      }
      if (url.pathname === "/popup") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(fixturePopupHtml);
        return;
      }
      if (url.pathname === "/stale") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(fixtureStaleHtml);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(fixtureRootHtml);
        return;
      }
      response.writeHead(404).end("Not found");
    });

    await new Promise<void>((resolve, reject) => {
      this.fixtureServer?.once("error", reject);
      this.fixtureServer?.listen(port, "127.0.0.1", resolve);
    });
  }

  private async stopFixtureServer(): Promise<void> {
    this.resetFixtureState();
    const server = this.fixtureServer;
    this.fixtureServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private resetFixtureState(): void {
    for (const responses of this.gateResponses.values()) {
      for (const response of responses) {
        if (!response.writableEnded) response.writeHead(503).end();
      }
    }
    this.gateResponses.clear();
    this.fixtureState = emptyFixtureState();
  }

  private releaseGate(name: string): { released: number } {
    if (!/^[a-z0-9-]{1,40}$/i.test(name)) throw new Error("无效的 fixture gate 名称。");
    const responses = this.gateResponses.get(name);
    let released = 0;
    for (const response of responses ?? []) {
      if (!response.writableEnded) {
        response.writeHead(204).end();
        released += 1;
      }
    }
    this.gateResponses.delete(name);
    return { released };
  }

  private getFixtureState(): FixtureState & { waitingGates: Record<string, number> } {
    return {
      abortedGates: { ...this.fixtureState.abortedGates },
      gateRequests: { ...this.fixtureState.gateRequests },
      marks: { ...this.fixtureState.marks },
      waitingGates: Object.fromEntries(
        [...this.gateResponses].map(([name, responses]) => [name, responses.size]),
      ),
    };
  }

  private seedRuntime(): void {
    const scriptsDir = path.join(this.runtimeDir, "scripts");
    const historyDir = path.join(scriptsDir, ".history", P0_SCRIPT_NAMES.deleteTarget);
    const localDir = path.join(scriptsDir, ".local");
    const tracesDir = path.join(this.runtimeDir, "traces");
    const dataDir = path.join(this.runtimeDir, "data");
    for (const directory of [scriptsDir, historyDir, localDir, tracesDir, dataDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }

    for (const [filename, content] of Object.entries(createP0Scripts(this.fixtureBaseUrl))) {
      fs.writeFileSync(path.join(scriptsDir, filename), content, "utf8");
    }

    const historyItems = [
      ["1700000000001", "P0 history single target"],
      ["1700000000002", "P0 history batch target"],
      ["1700000000003", "P0 history sentinel"],
    ] as const;
    for (const [id, label] of historyItems) {
      fs.writeFileSync(path.join(historyDir, `${id}.mjs`), `// ${label}\n`, "utf8");
      fs.writeFileSync(
        path.join(historyDir, `${id}.json`),
        JSON.stringify(
          {
            id,
            filename: P0_SCRIPT_NAMES.deleteTarget,
            label,
            runId: null,
            timestamp: `2026-01-01 00:00:0${id.at(-1)}`,
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    const traceItems = [
      ["run_1700000000001", "P0 trace single target"],
      ["run_1700000000002", "P0 trace batch target"],
      ["run_1700000000003", "P0 trace sentinel"],
    ] as const;
    for (const [runId, label] of traceItems) {
      const runDir = path.join(tracesDir, runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "trace.json"),
        JSON.stringify(
          {
            filename: P0_SCRIPT_NAMES.deleteTarget,
            frames: [],
            logs: [{ message: label, time: "00:00:00", type: "log" }],
            runId,
            targetUrl: this.fixtureUrl,
            timestamp: label,
            totalFrames: 0,
            totalLogs: 1,
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    fs.writeFileSync(
      path.join(localDir, "pinned_tabs.json"),
      JSON.stringify(
        [
          {
            created_at: "2026-01-01T00:00:00.000Z",
            id: "p0-pin-delete",
            scriptFilename: P0_SCRIPT_NAMES.visible,
            title: "P0 pinned delete target",
            url: this.fixtureUrl,
          },
          {
            created_at: "2026-01-01T00:00:01.000Z",
            id: "p0-pin-keep",
            scriptFilename: P0_SCRIPT_NAMES.keep,
            title: "P0 pinned sentinel",
            url: `${this.fixtureBaseUrl}/stale`,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const database = new DatabaseSync(path.join(dataDir, "cbg_data.db"));
    try {
      database.exec(`
        CREATE TABLE e2e_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO e2e_rows (id, value) VALUES (1, 'P0 row delete target');
        INSERT INTO e2e_rows (id, value) VALUES (2, 'P0 row sentinel');
        CREATE TABLE e2e_clear (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO e2e_clear (id, value) VALUES (1, 'P0 clear target one');
        INSERT INTO e2e_clear (id, value) VALUES (2, 'P0 clear target two');
        CREATE TABLE e2e_keep (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO e2e_keep (id, value) VALUES (1, 'P0 database sentinel');
      `);
    } finally {
      database.close();
    }
  }

  private async startWebsite(): Promise<void> {
    if (!process.env.PATH) throw new Error("P0 website 启动需要 PATH。");
    const env: NodeJS.ProcessEnv = {
      HOME: path.join(this.runRoot, "home"),
      LANG: process.env.LANG ?? "en_US.UTF-8",
      NODE_ENV: "test",
      PATH: process.env.PATH,
      TMPDIR: path.join(this.runRoot, "tmp"),
      VITE_API_BASE_URL: this.apiBaseUrl,
    };
    for (const name of ["CI", "COLORTERM", "FORCE_COLOR", "NO_COLOR", "TERM"] as const) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }

    this.websiteProcess = spawnOwned(
      "website",
      "vp",
      [
        "run",
        "--filter",
        "./apps/website",
        "dev",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.websitePort),
        "--strictPort",
      ],
      { cwd: REPO_ROOT, env },
    );
    try {
      await waitForHttp(this.websiteUrl, "P0 website");
    } catch (error) {
      throw this.withProcessOutput(error, this.websiteProcess);
    }
  }

  private async startChrome(): Promise<void> {
    const chromePath = this.resolveChromePath();
    const profileDir = path.join(this.caseRoot, "chrome-profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const cdpPort = await getFreePort();

    const env: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    };
    this.chromeProcess = spawnOwned(
      "managed Chrome",
      chromePath,
      [
        `--remote-debugging-port=${cdpPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-popup-blocking",
        "--disable-sync",
        "--metrics-recording-only",
        "--new-window",
        this.fixtureUrl,
      ],
      { cwd: this.caseRoot, env },
    );

    const versionUrl = `http://127.0.0.1:${cdpPort}/json/version`;
    try {
      await waitForHttp(versionUrl, "managed Chrome CDP");
      const version = (await (await fetch(versionUrl)).json()) as {
        webSocketDebuggerUrl?: string;
      };
      if (!version.webSocketDebuggerUrl) throw new Error("Chrome 未返回 CDP WebSocket URL。");
      this.cdp = new CdpClient(version.webSocketDebuggerUrl);
      await this.cdp.connect();
      const fixtureTarget = await this.waitForTarget((target) => target.url === this.fixtureUrl);
      const targets = await this.pageTargets();
      for (const target of targets) {
        if (target.targetId !== fixtureTarget.targetId) {
          await this.cdp
            .send("Target.closeTarget", { targetId: target.targetId })
            .catch(() => null);
        }
      }
      await this.waitForTarget((target) => target.url === this.fixtureUrl);
      this.baselineTargetIds = new Set((await this.pageTargets()).map((target) => target.targetId));
    } catch (error) {
      throw this.withProcessOutput(error, this.chromeProcess);
    }
  }

  private async startServer(): Promise<void> {
    const serverEntry = path.join(REPO_ROOT, "apps/server/dist/index.mjs");
    if (!fs.existsSync(serverEntry)) {
      throw new Error("缺少 apps/server/dist/index.mjs；请先运行 server build。 ");
    }
    if (!this.cdp) throw new Error("managed Chrome 尚未就绪。");

    const env: NodeJS.ProcessEnv = {
      CBG_E2E: "1",
      CBG_PUBLIC_API_URL: this.apiBaseUrl,
      CBG_RUNTIME_DIR: this.runtimeDir,
      CDP_URL: this.cdp.url,
      HOME: this.caseRoot,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LLM_API_KEY: "e2e-not-used",
      LLM_BASE_URL: `${this.fixtureBaseUrl}/v1`,
      LLM_UTILITY_MODEL: "e2e-not-used",
      NODE_ENV: "test",
      PATH: process.env.PATH,
      PORT: String(this.serverPort),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    };
    this.serverProcess = spawnOwned("server", process.execPath, [serverEntry], {
      cwd: this.runtimeDir,
      env,
    });
    try {
      await waitForHttp(`${this.apiBaseUrl}/health`, "P0 server", 40_000);
    } catch (error) {
      throw this.withProcessOutput(error, this.serverProcess);
    }
  }

  private async stopManagedStack(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    const serverProcess = this.serverProcess;
    try {
      await stopOwned(serverProcess);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!serverProcess || !ownedProcessIsRunning(serverProcess)) this.serverProcess = null;

    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      await cdp.send("Browser.close").catch(() => null);
      cdp.close();
    }

    const chromeProcess = this.chromeProcess;
    try {
      await stopOwned(chromeProcess);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!chromeProcess || !ownedProcessIsRunning(chromeProcess)) this.chromeProcess = null;
    this.baselineTargetIds.clear();

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "P0 managed server/Chrome 清理失败。");
    }
  }

  private resolveChromePath(): string {
    const candidates = [
      process.env.E2E_CHROME_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter((candidate): candidate is string => Boolean(candidate));
    const chromePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!chromePath) {
      throw new Error("未找到可用于 P0 E2E 的 Chrome；可通过 E2E_CHROME_PATH 指定。");
    }
    return chromePath;
  }

  private async pageTargets(): Promise<CdpTargetInfo[]> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const result = await this.cdp.send<{ targetInfos: CdpTargetInfo[] }>("Target.getTargets");
    return result.targetInfos.filter((target) => target.type === "page");
  }

  private async waitForTarget(
    predicate: (target: CdpTargetInfo) => boolean,
    timeoutMs = 10_000,
  ): Promise<CdpTargetInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const target = (await this.pageTargets()).find(predicate);
      if (target) return target;
      await delay(50);
    }
    throw new Error("未在 managed Chrome 中找到预期 target。");
  }

  private async attachToFixtureTarget(): Promise<string> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const target = await this.waitForTarget((candidate) => candidate.url === this.fixtureUrl);
    const attached = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      flatten: true,
      targetId: target.targetId,
    });
    await this.cdp.send("Runtime.enable", {}, attached.sessionId);
    await this.cdp.send("Page.enable", {}, attached.sessionId);
    return attached.sessionId;
  }

  private async evaluate<Result>(sessionId: string, expression: string): Promise<Result> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const response = await this.cdp.send<{
      exceptionDetails?: { text?: string };
      result?: { value?: Result };
    }>(
      "Runtime.evaluate",
      { awaitPromise: true, expression, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (response.exceptionDetails) {
      throw new Error(
        `managed Chrome evaluate 失败：${response.exceptionDetails.text ?? "unknown"}`,
      );
    }
    return response.result?.value as Result;
  }

  private async clickSelector(sessionId: string, selector: string): Promise<void> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const rect = await this.evaluate<{
      height: number;
      width: number;
      x: number;
      y: number;
    } | null>(
      sessionId,
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.scrollIntoView({ block: "center", inline: "center" });
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
    );
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`managed Chrome 中找不到可点击元素：${selector}`);
    }
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { button: "left", clickCount: 1, type: "mousePressed", x, y },
      sessionId,
    );
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { button: "left", clickCount: 1, type: "mouseReleased", x, y },
      sessionId,
    );
  }

  private async typeSelector(sessionId: string, selector: string, value: string): Promise<void> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    await this.clickSelector(sessionId, selector);
    await this.evaluate(
      sessionId,
      `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error("missing input");
        element.value = "";
        element.focus();
      })()`,
    );
    await this.cdp.send("Input.insertText", { text: value }, sessionId);
  }

  private assertCanary(canary: string): void {
    if (!/^E2E_SECRET_CANARY_[A-Za-z0-9_-]{1,80}$/.test(canary)) {
      throw new Error("P0 privacy canary 格式无效。");
    }
  }

  private async performRecordingActions(canary: string): Promise<{ popupOpened: boolean }> {
    this.assertCanary(canary);
    const sessionId = await this.attachToFixtureTarget();
    await this.typeSelector(sessionId, '[data-testid="public-alpha"]', PUBLIC_ALPHA);
    await delay(450);
    await this.typeSelector(sessionId, '[data-testid="public-beta"]', PUBLIC_BETA);
    await delay(450);
    await this.typeSelector(sessionId, '[data-testid="secret-input"]', canary);
    await delay(100);
    await this.clickSelector(sessionId, '[data-testid="open-popup"]');
    const popup = await this.waitForTarget(
      (target) => target.url === `${this.fixtureBaseUrl}/popup`,
    );
    return { popupOpened: Boolean(popup) };
  }

  private async fillManualSecret(canary: string): Promise<{ filled: true }> {
    this.assertCanary(canary);
    const sessionId = await this.attachToFixtureTarget();
    await this.typeSelector(sessionId, '[data-testid="secret-input"]', canary);
    return { filled: true };
  }

  private async clickManualOverlayButton(label: string): Promise<{ clicked: true }> {
    if (label !== "完成并继续" && label !== "取消执行") {
      throw new Error("只允许点击固定的 manual-step 操作按钮。");
    }
    if (!this.cdp) throw new Error("CDP 未连接。");
    const sessionId = await this.attachToFixtureTarget();
    await this.cdp.send("Accessibility.enable", {}, sessionId);
    const tree = await this.cdp.send<{
      nodes: Array<{
        backendDOMNodeId?: number;
        name?: { value?: string };
        role?: { value?: string };
      }>;
    }>("Accessibility.getFullAXTree", {}, sessionId);
    const button = tree.nodes.find(
      (node) => node.role?.value === "button" && node.name?.value === label,
    );
    if (!button?.backendDOMNodeId) throw new Error(`找不到 manual-step 按钮：${label}`);
    const box = await this.cdp.send<{ model?: { border?: number[]; content?: number[] } }>(
      "DOM.getBoxModel",
      { backendNodeId: button.backendDOMNodeId },
      sessionId,
    );
    const quad = box.model?.border ?? box.model?.content;
    if (!quad || quad.length < 8) throw new Error(`无法取得 manual-step 按钮坐标：${label}`);
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { button: "left", clickCount: 1, type: "mousePressed", x, y },
      sessionId,
    );
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { button: "left", clickCount: 1, type: "mouseReleased", x, y },
      sessionId,
    );
    return { clicked: true };
  }

  private async manualOverlayVisible(): Promise<boolean> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const sessionId = await this.attachToFixtureTarget();
    await this.cdp.send("Accessibility.enable", {}, sessionId);
    const tree = await this.cdp.send<{
      nodes: Array<{ name?: { value?: string }; role?: { value?: string } }>;
    }>("Accessibility.getFullAXTree", {}, sessionId);
    return tree.nodes.some(
      (node) =>
        node.role?.value === "button" &&
        (node.name?.value === "完成并继续" || node.name?.value === "取消执行"),
    );
  }

  private async navigateTargetStale(): Promise<{ url: string }> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const sessionId = await this.attachToFixtureTarget();
    const url = `${this.fixtureBaseUrl}/stale`;
    await this.cdp.send("Page.navigate", { url }, sessionId);
    await this.waitForTarget((target) => target.url === url);
    return { url };
  }

  private async createDuplicateTab(): Promise<{ targetId: string }> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const result = await this.cdp.send<{ targetId: string }>("Target.createTarget", {
      background: false,
      url: this.fixtureUrl,
    });
    await this.waitForTarget(
      (target) => target.targetId === result.targetId && target.url === this.fixtureUrl,
    );
    return result;
  }

  private async browserSnapshot(): Promise<BrowserTargetSnapshot> {
    if (!this.cdp) throw new Error("CDP 未连接。");
    const targets = await this.pageTargets();
    const extraTargets = await Promise.all(
      targets
        .filter((target) => !this.baselineTargetIds.has(target.targetId))
        .map(async (target) => {
          try {
            const info = await this.cdp!.send<{
              bounds?: { windowState?: string };
              windowId?: number;
            }>("Browser.getWindowForTarget", { targetId: target.targetId });
            return {
              targetId: target.targetId,
              title: target.title,
              url: target.url,
              windowId: info.windowId ?? null,
              windowState: info.bounds?.windowState ?? "unknown",
            };
          } catch {
            return {
              targetId: target.targetId,
              title: target.title,
              url: target.url,
              windowId: null,
              windowState: "closed",
            };
          }
        }),
    );
    return { baselineCount: this.baselineTargetIds.size, extraTargets };
  }

  private privacySnapshot(canary: string): { canaryHits: string[]; frameCount: number } {
    this.assertCanary(canary);
    const canaryBytes = Buffer.from(canary, "utf8");
    const canaryHits: string[] = [];
    let frameCount = 0;
    const walk = (directory: string): void => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const fileBytes = fs.readFileSync(absolutePath);
        if (entry.name.endsWith(".jpg")) frameCount += 1;
        if (fileBytes.includes(canaryBytes)) {
          canaryHits.push(path.relative(this.runtimeDir, absolutePath));
        }
      }
    };
    walk(this.runtimeDir);
    return { canaryHits, frameCount };
  }

  private runtimeState(): {
    dbCounts: Record<string, number>;
    historyIds: string[];
    pinnedIds: string[];
    scripts: string[];
    traces: string[];
  } {
    const scriptsDir = path.join(this.runtimeDir, "scripts");
    const historyDir = path.join(scriptsDir, ".history", P0_SCRIPT_NAMES.deleteTarget);
    const tracesDir = path.join(this.runtimeDir, "traces");
    const pinnedPath = path.join(scriptsDir, ".local", "pinned_tabs.json");
    const scripts = fs
      .readdirSync(scriptsDir)
      .filter((name) => name.endsWith(".mjs") || name.endsWith(".js"))
      .sort();
    const historyIds = fs.existsSync(historyDir)
      ? fs
          .readdirSync(historyDir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.replace(/\.json$/, ""))
          .sort()
      : [];
    const traces = fs.existsSync(tracesDir)
      ? fs
          .readdirSync(tracesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];
    const pinnedIds = fs.existsSync(pinnedPath)
      ? (JSON.parse(fs.readFileSync(pinnedPath, "utf8")) as Array<{ id: string }>).map(
          (item) => item.id,
        )
      : [];

    const database = new DatabaseSync(path.join(this.runtimeDir, "data", "cbg_data.db"), {
      readOnly: true,
    });
    const dbCounts: Record<string, number> = {};
    try {
      for (const table of ["e2e_rows", "e2e_clear", "e2e_keep"]) {
        const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number | bigint;
        };
        dbCounts[table] = Number(row.count);
      }
    } finally {
      database.close();
    }

    return { dbCounts, historyIds, pinnedIds, scripts, traces };
  }

  private withProcessOutput(error: unknown, owned: OwnedProcess | null): Error {
    const message = error instanceof Error ? error.message : String(error);
    const output = owned?.output.slice(-60).join("\n") || "(no process output)";
    return new Error(`${message}\n--- ${owned?.name ?? "process"} output ---\n${output}`);
  }

  private safeRemoveCaseRoot(): void {
    if (!this.caseRoot || !fs.existsSync(this.caseRoot)) return;
    const resolved = fs.realpathSync(this.caseRoot);
    const tempRoot = fs.realpathSync(os.tmpdir());
    if (!resolved.startsWith(`${tempRoot}${path.sep}`)) {
      throw new Error(`拒绝删除系统临时目录之外的 E2E case：${resolved}`);
    }
    if (!fs.existsSync(path.join(resolved, RUN_MARKER))) {
      throw new Error(`拒绝删除缺少 marker 的 E2E case：${resolved}`);
    }
    fs.rmSync(resolved, { force: true, recursive: true });
    this.caseRoot = "";
    this.runtimeDir = "";
  }

  private safeRemoveRunRoot(): void {
    if (!this.runRoot || !fs.existsSync(this.runRoot)) return;
    this.safeRemoveCaseRoot();
    const resolved = fs.realpathSync(this.runRoot);
    const tempRoot = fs.realpathSync(os.tmpdir());
    if (
      !resolved.startsWith(`${tempRoot}${path.sep}`) ||
      !path.basename(resolved).startsWith("crawlcbg-p0-e2e-") ||
      !fs.existsSync(path.join(resolved, RUN_MARKER))
    ) {
      throw new Error(`拒绝删除未经确认的 E2E run root：${resolved}`);
    }
    fs.rmSync(resolved, { force: true, recursive: true });
    this.runRoot = "";
  }
}

export const createP0Harness = (): P0Harness => new P0Harness();
