/**
 * Controlled SQLite registry for PI Agent analysis.
 *
 * Only regular SQLite files in the first level of configured directories are
 * registered. Every access revalidates the canonical path so a file replaced
 * with a symlink after discovery cannot escape the registry.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const INTERNAL_TABLES = new Set(["tab_schedules", "tab_schedule_runs"]);
const SQLITE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);

export interface DatabaseEntry {
  id: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface TableEntry {
  name: string;
  rowCount: number;
}

export interface TableSchema {
  name: string;
  columns: Array<{ name: string; type: string }>;
}

export interface TableSnapshot {
  schema: TableSchema;
  rows: Record<string, unknown>[];
  evidenceIds: string[];
}

interface RegisteredDatabase {
  entry: DatabaseEntry;
  absolutePath: string;
  allowedDir: string;
}

export class TableSelectionError extends Error {
  readonly invalidTableNames: string[];

  constructor(
    invalidTableNames: string[],
    message = "Table selection contains unavailable tables",
  ) {
    super(message);
    this.name = "TableSelectionError";
    this.invalidTableNames = invalidTableNames;
  }
}

function pathToId(absolutePath: string): string {
  return crypto.createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function jsonSafeSqliteValue(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function jsonSafeSqliteRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [column, jsonSafeSqliteValue(value)]),
  );
}

function canonicalDirectory(directory: string): string | null {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return fs.realpathSync(directory);
  } catch {
    return null;
  }
}

function visibleTableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map(({ name }) => name).filter((name) => !INTERNAL_TABLES.has(name));
}

export class DatabaseRegistry {
  private readonly configuredDirs: string[];
  private entries = new Map<string, RegisteredDatabase>();

  constructor(allowedDirs: string[]) {
    this.configuredDirs = [
      ...new Set(allowedDirs.map((dir) => path.resolve(dir.trim())).filter(Boolean)),
    ];
    this.refresh();
  }

  refresh(): void {
    const newEntries = new Map<string, RegisteredDatabase>();

    for (const configuredDir of this.configuredDirs) {
      const allowedDir = canonicalDirectory(configuredDir);
      if (!allowedDir) continue;

      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(allowedDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const item of items) {
        if (!item.isFile() || !SQLITE_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
          continue;

        const addressedPath = path.join(allowedDir, item.name);
        try {
          const addressedStat = fs.lstatSync(addressedPath);
          if (!addressedStat.isFile() || addressedStat.isSymbolicLink()) continue;

          const absolutePath = fs.realpathSync(addressedPath);
          if (path.dirname(absolutePath) !== allowedDir) continue;

          const stat = fs.statSync(absolutePath);
          if (!stat.isFile()) continue;

          const id = pathToId(absolutePath);
          newEntries.set(id, {
            entry: {
              id,
              name: item.name,
              sizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            },
            absolutePath,
            allowedDir,
          });
        } catch {
          // Files can disappear during a scan; omit them until the next refresh.
        }
      }
    }

    this.entries = newEntries;
  }

  list(): DatabaseEntry[] {
    return [...this.entries.values()].map(({ entry }) => entry);
  }

  /** Revalidate the registered file immediately before every SQLite open. */
  resolve(databaseId: string): string | undefined {
    const registered = this.entries.get(databaseId);
    if (!registered) return undefined;

    try {
      const addressedStat = fs.lstatSync(registered.absolutePath);
      if (!addressedStat.isFile() || addressedStat.isSymbolicLink()) return undefined;
      const canonicalPath = fs.realpathSync(registered.absolutePath);
      if (
        canonicalPath !== registered.absolutePath ||
        path.dirname(canonicalPath) !== registered.allowedDir
      ) {
        return undefined;
      }
      return canonicalPath;
    } catch {
      return undefined;
    }
  }

  getEntry(databaseId: string): DatabaseEntry | undefined {
    return this.resolve(databaseId) ? this.entries.get(databaseId)?.entry : undefined;
  }

  listTables(databaseId: string): TableEntry[] | null {
    const absolutePath = this.resolve(databaseId);
    if (!absolutePath) return null;

    const db = new DatabaseSync(absolutePath, { readOnly: true });
    try {
      db.exec("PRAGMA query_only = ON");
      return visibleTableNames(db).map((name) => {
        const statement = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`);
        statement.setReadBigInts(true);
        const count = statement.get() as { count: number | bigint } | undefined;
        return { name, rowCount: Number(count?.count ?? 0) };
      });
    } finally {
      db.close();
    }
  }

  /**
   * Capture all selected tables inside one SQLite read transaction. Selection
   * is all-or-nothing and must exactly match the current visible-table whitelist.
   */
  snapshotTables(databaseId: string, tableNames: string[]): Map<string, TableSnapshot> | null {
    const absolutePath = this.resolve(databaseId);
    if (!absolutePath) return null;

    const normalizedNames = tableNames.map((name) => (typeof name === "string" ? name : ""));
    const duplicates = normalizedNames.filter(
      (name, index) => normalizedNames.indexOf(name) !== index,
    );
    if (normalizedNames.some((name) => !name) || duplicates.length > 0) {
      throw new TableSelectionError([
        ...new Set([...duplicates, ...normalizedNames.filter((name) => !name)]),
      ]);
    }

    const db = new DatabaseSync(absolutePath, { readOnly: true });
    let inTransaction = false;
    try {
      db.exec("PRAGMA query_only = ON");
      db.exec("BEGIN DEFERRED TRANSACTION");
      inTransaction = true;

      const visible = new Set(visibleTableNames(db));
      const invalid = normalizedNames.filter((name) => !visible.has(name));
      if (invalid.length > 0) {
        throw new TableSelectionError(invalid);
      }

      const result = new Map<string, TableSnapshot>();
      for (const tableName of normalizedNames) {
        const columnsRaw = db
          .prepare("SELECT name, type FROM pragma_table_info(?) ORDER BY cid")
          .all(tableName) as Array<{ name: string; type: string }>;
        if (columnsRaw.length === 0) throw new TableSelectionError([tableName]);

        const schema: TableSchema = {
          name: tableName,
          columns: columnsRaw.map((column) => ({
            name: column.name,
            type: column.type || "TEXT",
          })),
        };
        const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`);
        statement.setReadBigInts(true);
        const rows = (statement.all() as Record<string, unknown>[]).map(jsonSafeSqliteRow);
        const evidenceIds = rows.map((_, index) => `${tableName}#${index}`);
        result.set(tableName, { schema, rows, evidenceIds });
      }

      db.exec("COMMIT");
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
      }
      throw error;
    } finally {
      db.close();
    }
  }

  estimateSnapshotSize(snapshot: Map<string, TableSnapshot>): {
    totalRows: number;
    totalBytes: number;
  } {
    let totalRows = 0;
    let totalBytes = 0;
    for (const tableData of snapshot.values()) {
      totalRows += tableData.rows.length;
      totalBytes += Buffer.byteLength(JSON.stringify(tableData.schema), "utf8");
      for (const row of tableData.rows) {
        totalBytes += Buffer.byteLength(JSON.stringify(row), "utf8");
      }
    }
    return { totalRows, totalBytes };
  }
}
