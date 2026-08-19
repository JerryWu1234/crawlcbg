/** Per-run immutable input snapshots and writable PI Agent workspaces. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { TableSnapshot } from "./database-registry.js";

const WORKSPACES_ROOT = path.resolve(
  process.env.PI_AGENT_WORKSPACES_ROOT?.trim() ||
    path.resolve(process.cwd(), "../../.pi-agent-workspaces"),
);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_FILE_PATTERN = /^table-\d{4}\.json$/;

export interface WorkspaceInfo {
  runId: string;
  rootDir: string;
  inputDir: string;
  workDir: string;
  outputDir: string;
  logsDir: string;
}

export interface SnapshotManifest {
  databaseId: string;
  databaseName: string;
  tables: Array<{
    name: string;
    fileName: string;
    rowCount: number;
    columnCount: number;
  }>;
  totalRows: number;
  totalBytes: number;
  createdAt: string;
}

function assertRunId(runId: string): void {
  if (!UUID_PATTERN.test(runId)) throw new Error("Invalid PI Agent runId");
}

function assertPlainDirectory(directory: string): string {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe workspace directory: ${directory}`);
  }
  return fs.realpathSync(directory);
}

function rootCanonicalPath(): string {
  ensureWorkspacesRoot();
  return assertPlainDirectory(WORKSPACES_ROOT);
}

function workspacePaths(runId: string): WorkspaceInfo {
  assertRunId(runId);
  const rootDir = path.join(WORKSPACES_ROOT, runId);
  return {
    runId,
    rootDir,
    inputDir: path.join(rootDir, "input"),
    workDir: path.join(rootDir, "work"),
    outputDir: path.join(rootDir, "output"),
    logsDir: path.join(rootDir, "logs"),
  };
}

/** Validate direct-child and symlink boundaries before a workspace is used. */
export function validateWorkspace(workspace: WorkspaceInfo): WorkspaceInfo {
  assertRunId(workspace.runId);
  const root = rootCanonicalPath();
  const expected = workspacePaths(workspace.runId);
  if (
    workspace.rootDir !== expected.rootDir ||
    path.dirname(expected.rootDir) !== WORKSPACES_ROOT
  ) {
    throw new Error("Workspace path does not match runId");
  }

  const canonicalRoot = assertPlainDirectory(expected.rootDir);
  if (path.dirname(canonicalRoot) !== root || canonicalRoot !== expected.rootDir) {
    throw new Error("Workspace escaped the configured root");
  }

  for (const directory of [
    expected.inputDir,
    expected.workDir,
    expected.outputDir,
    expected.logsDir,
  ]) {
    const canonical = assertPlainDirectory(directory);
    if (canonical !== directory || path.dirname(canonical) !== canonicalRoot) {
      throw new Error(`Unsafe workspace child directory: ${directory}`);
    }
  }
  return expected;
}

export function createWorkspace(): WorkspaceInfo {
  ensureWorkspacesRoot();
  const workspace = workspacePaths(crypto.randomUUID());
  fs.mkdirSync(workspace.rootDir, { mode: 0o700 });
  for (const directory of [
    workspace.inputDir,
    workspace.workDir,
    workspace.outputDir,
    workspace.logsDir,
  ]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  return validateWorkspace(workspace);
}

function writePrivateFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export function writeSnapshotToWorkspace(
  workspaceInput: WorkspaceInfo,
  databaseId: string,
  databaseName: string,
  snapshots: Map<string, TableSnapshot>,
  prompt: string,
): SnapshotManifest {
  const workspace = validateWorkspace(workspaceInput);
  const tableMetas: SnapshotManifest["tables"] = [];
  let totalRows = 0;
  let totalBytes = 0;
  let tableIndex = 0;

  for (const [tableName, snapshot] of snapshots) {
    const fileName = `table-${String(tableIndex++).padStart(4, "0")}.json`;
    const content = JSON.stringify(
      {
        tableName,
        schema: snapshot.schema,
        rows: snapshot.rows,
        evidenceIds: snapshot.evidenceIds,
      },
      null,
      2,
    );
    writePrivateFile(path.join(workspace.inputDir, fileName), content);
    totalRows += snapshot.rows.length;
    totalBytes += Buffer.byteLength(content, "utf8");
    tableMetas.push({
      name: tableName,
      fileName,
      rowCount: snapshot.rows.length,
      columnCount: snapshot.schema.columns.length,
    });
  }

  writePrivateFile(path.join(workspace.inputDir, "prompt.txt"), prompt);
  const manifest: SnapshotManifest = {
    databaseId,
    databaseName,
    tables: tableMetas,
    totalRows,
    totalBytes,
    createdAt: new Date().toISOString(),
  };
  writePrivateFile(
    path.join(workspace.inputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  for (const entry of fs.readdirSync(workspace.inputDir)) {
    fs.chmodSync(path.join(workspace.inputDir, entry), 0o400);
  }
  fs.chmodSync(workspace.inputDir, 0o500);
  return manifest;
}

function isManifest(value: unknown): value is SnapshotManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<SnapshotManifest>;
  return (
    typeof manifest.databaseId === "string" &&
    typeof manifest.databaseName === "string" &&
    typeof manifest.totalRows === "number" &&
    typeof manifest.totalBytes === "number" &&
    typeof manifest.createdAt === "string" &&
    Array.isArray(manifest.tables) &&
    manifest.tables.every(
      (table) =>
        table &&
        typeof table.name === "string" &&
        typeof table.fileName === "string" &&
        SNAPSHOT_FILE_PATTERN.test(table.fileName) &&
        typeof table.rowCount === "number" &&
        typeof table.columnCount === "number",
    )
  );
}

export function readManifest(workspaceInput: WorkspaceInfo): SnapshotManifest | null {
  try {
    const workspace = validateWorkspace(workspaceInput);
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(workspace.inputDir, "manifest.json"), "utf8"),
    );
    return isManifest(value) ? value : null;
  } catch {
    return null;
  }
}

export function getSnapshotFileForTable(
  workspaceInput: WorkspaceInfo,
  tableName: string,
): string | null {
  const workspace = validateWorkspace(workspaceInput);
  const manifest = readManifest(workspace);
  const table = manifest?.tables.find((candidate) => candidate.name === tableName);
  if (!table || !SNAPSHOT_FILE_PATTERN.test(table.fileName)) return null;
  const filePath = path.join(workspace.inputDir, table.fileName);
  if (path.dirname(filePath) !== workspace.inputDir) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filePath) !== filePath)
      return null;
    return filePath;
  } catch {
    return null;
  }
}

export function readSnapshotsFromWorkspace(
  workspaceInput: WorkspaceInfo,
): Map<string, TableSnapshot> | null {
  const workspace = validateWorkspace(workspaceInput);
  const manifest = readManifest(workspace);
  if (!manifest) return null;
  const snapshots = new Map<string, TableSnapshot>();

  try {
    for (const table of manifest.tables) {
      const filePath = getSnapshotFileForTable(workspace, table.name);
      if (!filePath) return null;
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        tableName?: unknown;
        schema?: unknown;
        rows?: unknown;
        evidenceIds?: unknown;
      };
      if (
        value.tableName !== table.name ||
        !value.schema ||
        !Array.isArray(value.rows) ||
        !Array.isArray(value.evidenceIds) ||
        value.rows.length !== value.evidenceIds.length
      ) {
        return null;
      }
      snapshots.set(table.name, {
        schema: value.schema as TableSnapshot["schema"],
        rows: value.rows as TableSnapshot["rows"],
        evidenceIds: value.evidenceIds as string[],
      });
    }
    return snapshots;
  } catch {
    return null;
  }
}

export function getWorkspace(runId: string): WorkspaceInfo | null {
  try {
    const workspace = workspacePaths(runId);
    if (!fs.existsSync(workspace.rootDir)) return null;
    return validateWorkspace(workspace);
  } catch {
    return null;
  }
}

/** Validate a workspace before deletion, allowing expected children to be already absent. */
function validateWorkspaceForDeletion(workspace: WorkspaceInfo): WorkspaceInfo {
  assertRunId(workspace.runId);
  const root = rootCanonicalPath();
  const expected = workspacePaths(workspace.runId);
  if (
    workspace.rootDir !== expected.rootDir ||
    path.dirname(expected.rootDir) !== WORKSPACES_ROOT
  ) {
    throw new Error("Workspace path does not match runId");
  }

  const canonicalRoot = assertPlainDirectory(expected.rootDir);
  if (path.dirname(canonicalRoot) !== root || canonicalRoot !== expected.rootDir) {
    throw new Error("Workspace escaped the configured root");
  }

  for (const directory of [
    expected.inputDir,
    expected.workDir,
    expected.outputDir,
    expected.logsDir,
  ]) {
    if (!fs.existsSync(directory)) continue;
    const canonical = assertPlainDirectory(directory);
    if (canonical !== directory || path.dirname(canonical) !== canonicalRoot) {
      throw new Error(`Unsafe workspace child directory: ${directory}`);
    }
  }
  return expected;
}

export function deleteWorkspace(runId: string): boolean {
  const workspace = workspacePaths(runId);
  if (!fs.existsSync(workspace.rootDir)) return true;
  const validated = validateWorkspaceForDeletion(workspace);
  if (fs.existsSync(validated.inputDir)) {
    fs.chmodSync(validated.inputDir, 0o700);
  }
  fs.rmSync(validated.rootDir, { recursive: true, force: true });
  if (fs.existsSync(validated.rootDir)) {
    throw new Error(`Failed to delete PI Agent workspace: ${runId}`);
  }
  return true;
}

export function ensureWorkspacesRoot(): void {
  if (!fs.existsSync(WORKSPACES_ROOT)) {
    fs.mkdirSync(WORKSPACES_ROOT, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(WORKSPACES_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("PI Agent workspace root must be a regular directory");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("PI Agent workspace root must not be accessible by group or other users");
  }
}

export function buildDataContext(snapshots: Map<string, TableSnapshot>): string {
  const parts: string[] = [];
  for (const [tableName, snapshot] of snapshots) {
    parts.push(`## Table: ${tableName}`, "", "### Schema");
    parts.push(
      snapshot.schema.columns.map((column) => `- ${column.name} (${column.type})`).join("\n"),
    );
    parts.push("", `### Data (${snapshot.rows.length} rows)`, "");
    for (let index = 0; index < snapshot.rows.length; index++) {
      parts.push(`[${snapshot.evidenceIds[index]}] ${JSON.stringify(snapshot.rows[index])}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

export function getWorkspacesRoot(): string {
  return WORKSPACES_ROOT;
}
