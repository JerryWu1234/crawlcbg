import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Ensure data directory exists
const DATA_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, "cbg_data.db");
const dbSync = new DatabaseSync(DB_FILE);

export interface DbHelper {
  exec: (sql: string) => void;
  get: (sql: string, params?: any[]) => any;
  all: (sql: string, params?: any[]) => any[];
  run: (sql: string, params?: any[]) => any;
  insert: (tableName: string, dataObject: Record<string, any>) => any;
  exists: (tableName: string, whereObject: Record<string, any>) => boolean;
  upsert: (tableName: string, dataObject: Record<string, any>) => any;
}

export const db: DbHelper = {
  exec(sql: string) {
    dbSync.exec(sql);
  },

  get(sql: string, params: any[] = []) {
    const stmt = dbSync.prepare(sql);
    return stmt.get(...params);
  },

  all(sql: string, params: any[] = []) {
    const stmt = dbSync.prepare(sql);
    return stmt.all(...params);
  },

  run(sql: string, params: any[] = []) {
    const stmt = dbSync.prepare(sql);
    return stmt.run(...params);
  },

  insert(tableName: string, dataObject: Record<string, any>) {
    const keys = Object.keys(dataObject);
    if (keys.length === 0) return;
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`;
    const params = Object.values(dataObject);
    const stmt = dbSync.prepare(sql);
    return stmt.run(...params);
  },

  exists(tableName: string, whereObject: Record<string, any>) {
    const keys = Object.keys(whereObject);
    if (keys.length === 0) return false;
    const whereClause = keys.map((k) => `${k} = ?`).join(" AND ");
    const sql = `SELECT 1 FROM ${tableName} WHERE ${whereClause} LIMIT 1`;
    const params = Object.values(whereObject);
    const stmt = dbSync.prepare(sql);
    const result = stmt.get(...params);
    return Boolean(result);
  },

  upsert(tableName: string, dataObject: Record<string, any>) {
    const keys = Object.keys(dataObject);
    if (keys.length === 0) return;
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`;
    const params = Object.values(dataObject);
    const stmt = dbSync.prepare(sql);
    return stmt.run(...params);
  },
};
