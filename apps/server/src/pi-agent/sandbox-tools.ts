import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";

import { validateWorkspace, type WorkspaceInfo } from "./workspace-manager.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_RETURNED_OUTPUT = 200_000;
const VIRTUAL_ROOT = "/workspace";
const WRITABLE_ROOTS = ["/workspace/work", "/workspace/output", "/workspace/logs"];

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}

function assertSandboxAvailable(): void {
  if (process.platform !== "darwin" || !fs.existsSync(SANDBOX_EXEC)) {
    throw new SandboxUnavailableError(
      "PI Agent requires macOS sandbox-exec for OS-level workspace isolation",
    );
  }
}

function buildProfile(workspace: WorkspaceInfo): string {
  const home = os.homedir();
  const runtimeBin = path.dirname(fs.realpathSync(process.execPath));
  const systemReadRoots = [
    "/System",
    "/Library/Apple",
    "/usr",
    "/bin",
    "/sbin",
    "/private/var/db/timezone",
    "/private/var/run/resolv.conf",
    runtimeBin,
  ];
  const readable = [...systemReadRoots, workspace.rootDir]
    .filter((entry) => fs.existsSync(entry))
    .map((entry) => `  (subpath ${schemeString(entry)})`)
    .join("\n");
  const writable = [workspace.workDir, workspace.outputDir, workspace.logsDir]
    .map((entry) => `  (subpath ${schemeString(entry)})`)
    .join("\n");

  return `(version 1)
(deny default)
(import "system.sb")
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow network*)
(deny file-read* (subpath ${schemeString(home)}))
(deny file-read* (subpath "/opt/homebrew"))
(deny file-read* (subpath "/usr/local"))
(deny file-read* (subpath "/private/etc"))
(allow file-read* file-read-metadata file-test-existence file-map-executable
${readable})
(deny file-write* (subpath "/"))
(allow file-write* file-read* file-read-metadata file-test-existence
${writable})
(allow file-read* file-read-metadata file-test-existence
  (subpath ${schemeString(workspace.inputDir)}))
(deny file-write* (subpath ${schemeString(workspace.inputDir)}))
(deny file-link file-mount file-unmount)
`;
}

function normalizeVirtualPath(input: string, defaultDirectory = "/workspace/work"): string {
  if (input.includes("\0")) throw new Error("Path contains a NUL byte");
  const candidate = input.trim() || ".";
  const absolute = candidate.startsWith("/")
    ? path.posix.normalize(candidate)
    : path.posix.resolve(defaultDirectory, candidate);
  if (absolute !== VIRTUAL_ROOT && !absolute.startsWith(`${VIRTUAL_ROOT}/`)) {
    throw new Error("Path must stay inside /workspace");
  }
  return absolute;
}

function mapVirtualPath(workspace: WorkspaceInfo, virtualPath: string): string {
  const relative = path.posix.relative(VIRTUAL_ROOT, virtualPath);
  const hostPath = path.resolve(workspace.rootDir, ...relative.split("/").filter(Boolean));
  if (hostPath !== workspace.rootDir && !hostPath.startsWith(`${workspace.rootDir}${path.sep}`)) {
    throw new Error("Path escaped the current workspace");
  }
  return hostPath;
}

function isWritableVirtualPath(virtualPath: string): boolean {
  return WRITABLE_ROOTS.some((root) => virtualPath === root || virtualPath.startsWith(`${root}/`));
}

function assertNoSymlinkPath(
  workspace: WorkspaceInfo,
  hostPath: string,
  allowMissingLeaf: boolean,
): void {
  const relative = path.relative(workspace.rootDir, hostPath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Path escaped workspace");
  let current = workspace.rootDir;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${current}`);
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === segments.length - 1 &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

function resolveToolPath(
  workspaceInput: WorkspaceInfo,
  input: string,
  options: { write?: boolean; allowMissingLeaf?: boolean } = {},
): { virtualPath: string; hostPath: string } {
  const workspace = validateWorkspace(workspaceInput);
  const virtualPath = normalizeVirtualPath(input);
  if (options.write && !isWritableVirtualPath(virtualPath)) {
    throw new Error(
      "Writes are allowed only in /workspace/work, /workspace/output, or /workspace/logs",
    );
  }
  const hostPath = mapVirtualPath(workspace, virtualPath);
  assertNoSymlinkPath(workspace, hostPath, options.allowMissingLeaf === true);
  return { virtualPath, hostPath };
}

function ensureSafeParent(workspace: WorkspaceInfo, hostPath: string): void {
  const parent = path.dirname(hostPath);
  const relative = path.relative(workspace.rootDir, parent);
  let current = workspace.rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe parent directory: ${current}`);
    }
  }
  if (fs.realpathSync(parent) !== parent) throw new Error("Parent directory contains a symlink");
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_RETURNED_OUTPUT) return value;
  return `${value.slice(0, MAX_RETURNED_OUTPUT)}\n...[tool output truncated; complete output remains in logs]`;
}

function shellEnvironment(workspace: WorkspaceInfo): Record<string, string> {
  const home = path.join(workspace.workDir, ".home");
  const temporary = path.join(workspace.workDir, ".tmp");
  const cache = path.join(workspace.workDir, ".cache");
  for (const directory of [home, temporary, cache, path.join(workspace.workDir, ".local")]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const runtimeBin = path.dirname(fs.realpathSync(process.execPath));
  return {
    PATH: `${runtimeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: temporary,
    WORKSPACE_ROOT: workspace.rootDir,
    WORKSPACE_INPUT: workspace.inputDir,
    WORKSPACE_WORK: workspace.workDir,
    WORKSPACE_OUTPUT: workspace.outputDir,
    WORKSPACE_LOGS: workspace.logsDir,
    XDG_CONFIG_HOME: path.join(workspace.workDir, ".config"),
    XDG_CACHE_HOME: cache,
    npm_config_cache: path.join(cache, "npm"),
    npm_config_prefix: path.join(workspace.workDir, ".local"),
    PNPM_HOME: path.join(workspace.workDir, ".local/pnpm"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    PIP_CONFIG_FILE: "/dev/null",
    PYTHONNOUSERSITE: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
}

export class WorkspaceSandbox {
  readonly workspace: WorkspaceInfo;
  readonly tools: AgentTool<any, any>[];
  private readonly profile: string;
  private readonly childProcessGroups = new Set<number>();

  constructor(workspaceInput: WorkspaceInfo) {
    assertSandboxAvailable();
    this.workspace = validateWorkspace(workspaceInput);
    this.profile = buildProfile(this.workspace);
    this.tools = this.createTools();
  }

  private createTools(): AgentTool<any, any>[] {
    const pathParameter = Type.String({
      description: "Path inside /workspace. Relative paths resolve from /workspace/work.",
    });

    const readTool: AgentTool<any, any> = {
      name: "read_file",
      label: "Read file",
      description: "Read a UTF-8 file from the current isolated workspace.",
      parameters: Type.Object({ path: pathParameter }),
      execute: async (_id, params) => {
        const input = params as { path: string };
        const resolved = resolveToolPath(this.workspace, input.path);
        const stat = fs.lstatSync(resolved.hostPath);
        if (!stat.isFile()) throw new Error("Path is not a regular file");
        return {
          content: [
            { type: "text", text: truncateOutput(fs.readFileSync(resolved.hostPath, "utf8")) },
          ],
          details: { path: resolved.virtualPath, size: stat.size },
        };
      },
    };

    const writeTool: AgentTool<any, any> = {
      name: "write_file",
      label: "Write file",
      description: "Create, overwrite, or append a UTF-8 file in work, output, or logs.",
      parameters: Type.Object({
        path: pathParameter,
        content: Type.String(),
        mode: Type.Optional(StringEnum(["overwrite", "append"] as const)),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const input = params as {
          path: string;
          content: string;
          mode?: "overwrite" | "append";
        };
        const resolved = resolveToolPath(this.workspace, input.path, {
          write: true,
          allowMissingLeaf: true,
        });
        ensureSafeParent(this.workspace, resolved.hostPath);
        if (fs.existsSync(resolved.hostPath)) {
          const stat = fs.lstatSync(resolved.hostPath);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("Target is not a regular file");
        }
        fs.writeFileSync(resolved.hostPath, input.content, {
          encoding: "utf8",
          mode: 0o600,
          flag: input.mode === "append" ? "a" : "w",
        });
        return {
          content: [
            {
              type: "text",
              text: `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${resolved.virtualPath}`,
            },
          ],
          details: {
            path: resolved.virtualPath,
            bytes: Buffer.byteLength(input.content, "utf8"),
          },
        };
      },
    };

    const listTool: AgentTool<any, any> = {
      name: "list_files",
      label: "List files",
      description: "List direct children of a directory in the current workspace.",
      parameters: Type.Object({ path: Type.Optional(pathParameter) }),
      execute: async (_id, params) => {
        const input = params as { path?: string };
        const resolved = resolveToolPath(this.workspace, input.path || "/workspace/work");
        const stat = fs.lstatSync(resolved.hostPath);
        if (!stat.isDirectory()) throw new Error("Path is not a directory");
        const entries = fs.readdirSync(resolved.hostPath, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          kind: entry.isSymbolicLink()
            ? "symlink"
            : entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
        }));
        return {
          content: [
            {
              type: "text",
              text:
                entries.map((entry) => `${entry.kind}\t${entry.name}`).join("\n") ||
                "(empty directory)",
            },
          ],
          details: { path: resolved.virtualPath, entries },
        };
      },
    };

    const moveTool: AgentTool<any, any> = {
      name: "move_path",
      label: "Move path",
      description: "Move or rename a file or directory inside writable workspace directories.",
      parameters: Type.Object({ source: pathParameter, destination: pathParameter }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const input = params as { source: string; destination: string };
        const source = resolveToolPath(this.workspace, input.source, { write: true });
        const destination = resolveToolPath(this.workspace, input.destination, {
          write: true,
          allowMissingLeaf: true,
        });
        ensureSafeParent(this.workspace, destination.hostPath);
        fs.renameSync(source.hostPath, destination.hostPath);
        return {
          content: [
            { type: "text", text: `Moved ${source.virtualPath} to ${destination.virtualPath}` },
          ],
          details: { source: source.virtualPath, destination: destination.virtualPath },
        };
      },
    };

    const deleteTool: AgentTool<any, any> = {
      name: "delete_path",
      label: "Delete path",
      description: "Delete a file or directory below a writable workspace directory.",
      parameters: Type.Object({ path: pathParameter, recursive: Type.Optional(Type.Boolean()) }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const input = params as { path: string; recursive?: boolean };
        const resolved = resolveToolPath(this.workspace, input.path, { write: true });
        if (WRITABLE_ROOTS.includes(resolved.virtualPath)) {
          throw new Error("Cannot delete a workspace root directory");
        }
        const stat = fs.lstatSync(resolved.hostPath);
        if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
        fs.rmSync(resolved.hostPath, {
          recursive: input.recursive === true,
          force: false,
        });
        return {
          content: [{ type: "text", text: `Deleted ${resolved.virtualPath}` }],
          details: { path: resolved.virtualPath },
        };
      },
    };

    const shellTool: AgentTool<any, any> = {
      name: "shell",
      label: "Sandbox shell",
      description:
        "Execute a shell command in the OS-isolated workspace. The shell starts in work; use relative paths or WORKSPACE_INPUT/WORKSPACE_WORK/WORKSPACE_OUTPUT/WORKSPACE_LOGS. Network is available; input is read-only.",
      parameters: Type.Object({
        command: Type.String(),
        cwd: Type.Optional(pathParameter),
      }),
      executionMode: "sequential",
      execute: async (toolCallId, params, signal, onUpdate) => {
        const input = params as { command: string; cwd?: string };
        return this.executeShell(toolCallId, input.command, input.cwd, signal, onUpdate);
      },
    };

    return [readTool, writeTool, listTool, moveTool, deleteTool, shellTool];
  }

  private async executeShell(
    toolCallId: string,
    command: string,
    cwdInput: string | undefined,
    signal: AbortSignal | undefined,
    onUpdate: ((result: any) => void) | undefined,
  ): Promise<any> {
    const cwd = resolveToolPath(this.workspace, cwdInput || "/workspace/work");
    if (!fs.lstatSync(cwd.hostPath).isDirectory()) throw new Error("Shell cwd is not a directory");

    const safeToolCallId = toolCallId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    const logPath = path.join(this.workspace.logsDir, `shell-${safeToolCallId}.log`);
    const log = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
    log.write(`$ ${command}\n`);

    return await new Promise((resolve, reject) => {
      const child = spawn(
        SANDBOX_EXEC,
        ["-p", this.profile, "/bin/bash", "--noprofile", "--norc", "-c", command],
        {
          cwd: cwd.hostPath,
          env: shellEnvironment(this.workspace),
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (child.pid) this.childProcessGroups.add(child.pid);
      let stdout = "";
      let stderr = "";
      let settled = false;

      const killGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const onAbort = () => killGroup();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        log.write(chunk);
        if (stdout.length < MAX_RETURNED_OUTPUT) stdout += chunk;
        onUpdate?.({
          content: [{ type: "text", text: truncateOutput(chunk) }],
          details: { stream: "stdout" },
        });
      });
      child.stderr.on("data", (chunk: string) => {
        log.write(chunk);
        if (stderr.length < MAX_RETURNED_OUTPUT) stderr += chunk;
        onUpdate?.({
          content: [{ type: "text", text: truncateOutput(chunk) }],
          details: { stream: "stderr" },
        });
      });
      child.once("error", (error) => {
        settled = true;
        log.end();
        signal?.removeEventListener("abort", onAbort);
        if (child.pid) this.childProcessGroups.delete(child.pid);
        reject(error);
      });
      child.once("close", (code, closeSignal) => {
        if (settled) return;
        settled = true;
        log.end(`\n[exit ${code ?? "unknown"}${closeSignal ? ` signal ${closeSignal}` : ""}]\n`);
        signal?.removeEventListener("abort", onAbort);
        if (child.pid) this.childProcessGroups.delete(child.pid);
        if (signal?.aborted) {
          reject(new Error("Shell command aborted"));
          return;
        }
        const text = [stdout, stderr].filter(Boolean).join("\n");
        resolve({
          content: [{ type: "text", text: truncateOutput(text || `(exit ${code ?? 1})`) }],
          details: {
            command,
            cwd: cwd.virtualPath,
            exitCode: code ?? 1,
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            log: `/workspace/logs/${path.basename(logPath)}`,
          },
        });
      });
    });
  }

  async cleanup(): Promise<void> {
    for (const pid of this.childProcessGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }
    this.childProcessGroups.clear();
  }
}
