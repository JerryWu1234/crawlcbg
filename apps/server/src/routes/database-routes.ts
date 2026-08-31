import type { FastifyInstance } from "fastify";
import type { DbHelper } from "../db.js";

interface DatabaseRoutesDependencies {
  fastify: FastifyInstance;
  db: DbHelper;
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const isKnownTable = (db: DbHelper, table: unknown): table is string => {
  if (typeof table !== "string" || !table) return false;
  return Boolean(
    db.get(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? AND name NOT LIKE 'sqlite_%'",
      [table],
    ),
  );
};

const hasColumn = (db: DbHelper, table: string, column: unknown): column is string => {
  if (typeof column !== "string" || !column) return false;
  const columns = db.all(`PRAGMA table_info(${quoteIdentifier(table)})`);
  return columns.some((item) => item?.name === column);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function registerDatabaseRoutes({ fastify, db }: DatabaseRoutesDependencies): void {
  // 1. List all SQLite tables and row counts
  fastify.get("/api/db/tables", async () => {
    try {
      const tablesRaw = db.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
      const tables = tablesRaw.map((table) => {
        const name = String(table.name);
        const countRes = db.get(`SELECT COUNT(*) as count FROM ${quoteIdentifier(name)}`);
        return {
          name,
          count: countRes ? countRes.count : 0,
        };
      });
      return { success: true, tables };
    } catch (error) {
      return { success: false, error: errorMessage(error), tables: [] };
    }
  });

  // 2. Query table data with pagination and optional search filter
  fastify.get("/api/db/data", async (request, reply) => {
    const {
      table,
      search,
      page = "1",
      pageSize = "20",
    } = (request.query as {
      table?: string;
      search?: string;
      page?: string;
      pageSize?: string;
    }) || {};

    if (!table) {
      return reply.status(400).send({ error: "Missing 'table' parameter." });
    }
    if (!isKnownTable(db, table)) {
      return reply.status(400).send({ error: "Unknown or invalid table." });
    }

    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(500, Number.parseInt(pageSize, 10) || 20));
    const offsetNum = (pageNum - 1) * limitNum;
    const tableIdentifier = quoteIdentifier(table);

    try {
      let rows: unknown[] = [];
      let totalCount = 0;

      let orderClause = "";
      try {
        db.get(`SELECT rowid FROM ${tableIdentifier} LIMIT 1`);
        orderClause = "ORDER BY rowid DESC";
      } catch {
        orderClause = "";
      }

      if (search?.trim()) {
        const keyword = `%${search.trim()}%`;
        const sample = db.get(`SELECT * FROM ${tableIdentifier} LIMIT 1`);
        if (sample) {
          const keys = Object.keys(sample);
          const whereClause = keys.map((key) => `${quoteIdentifier(key)} LIKE ?`).join(" OR ");
          const params = keys.map(() => keyword);

          const countRes = db.get(
            `SELECT COUNT(*) as count FROM ${tableIdentifier} WHERE ${whereClause}`,
            params,
          );
          totalCount = countRes ? countRes.count : 0;

          const sql = `SELECT * FROM ${tableIdentifier} WHERE ${whereClause} ${orderClause} LIMIT ${limitNum} OFFSET ${offsetNum}`;
          rows = db.all(sql, params);
        }
      } else {
        const countRes = db.get(`SELECT COUNT(*) as count FROM ${tableIdentifier}`);
        totalCount = countRes ? countRes.count : 0;

        const sql = `SELECT * FROM ${tableIdentifier} ${orderClause} LIMIT ${limitNum} OFFSET ${offsetNum}`;
        rows = db.all(sql);
      }

      const totalPages = Math.max(1, Math.ceil(totalCount / limitNum));

      return {
        success: true,
        table,
        total: totalCount,
        page: pageNum,
        pageSize: limitNum,
        totalPages,
        rows,
      };
    } catch (error) {
      return reply.status(500).send({ error: `Query failed: ${errorMessage(error)}` });
    }
  });

  // 3. Clear table data
  fastify.post("/api/db/clear", async (request, reply) => {
    const { table } = (request.body as { table?: string }) || {};
    if (!table) {
      return reply.status(400).send({ error: "Missing 'table' parameter." });
    }
    if (!isKnownTable(db, table)) {
      return reply.status(400).send({ error: "Unknown or invalid table." });
    }

    try {
      db.exec(`DELETE FROM ${quoteIdentifier(table)}`);
      return { success: true, message: `Table '${table}' cleared.` };
    } catch (error) {
      return reply.status(500).send({ error: `Clear failed: ${errorMessage(error)}` });
    }
  });

  // 4. Delete single row from table
  fastify.post("/api/db/delete-row", async (request, reply) => {
    const { table, primaryKey, primaryValue } =
      (request.body as { table?: string; primaryKey?: string; primaryValue?: unknown }) || {};
    if (!table || !primaryKey || primaryValue === undefined) {
      return reply.status(400).send({ error: "Missing 'table', 'primaryKey', or 'primaryValue'." });
    }
    if (!isKnownTable(db, table) || !hasColumn(db, table, primaryKey)) {
      return reply.status(400).send({ error: "Unknown or invalid table/primary key." });
    }

    try {
      db.run(`DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(primaryKey)} = ?`, [
        primaryValue,
      ]);
      return { success: true, message: `Row deleted using '${primaryKey}'.` };
    } catch (error) {
      return reply.status(500).send({ error: `Delete row failed: ${errorMessage(error)}` });
    }
  });
}
