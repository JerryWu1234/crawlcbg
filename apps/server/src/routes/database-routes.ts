import type { FastifyInstance } from "fastify";
import type { DbHelper } from "../db.js";

interface DatabaseRoutesDependencies {
  fastify: FastifyInstance;
  db: DbHelper;
}

export function registerDatabaseRoutes({ fastify, db }: DatabaseRoutesDependencies): void {
  // 1. List all SQLite tables and row counts
  fastify.get("/api/db/tables", async () => {
    try {
      const tablesRaw = db.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
      const tables = tablesRaw.map((t: any) => {
        const countRes = db.get(`SELECT COUNT(*) as count FROM ${t.name}`);
        return {
          name: t.name,
          count: countRes ? countRes.count : 0,
        };
      });
      return { success: true, tables };
    } catch (err: any) {
      return { success: false, error: err.message, tables: [] };
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

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(500, parseInt(pageSize, 10) || 20));
    const offsetNum = (pageNum - 1) * limitNum;

    try {
      let rows: any[] = [];
      let totalCount = 0;

      // Safely check if rowid is supported by the table
      let orderClause = "";
      try {
        db.get(`SELECT rowid FROM ${table} LIMIT 1`);
        orderClause = "ORDER BY rowid DESC";
      } catch {
        orderClause = "";
      }

      if (search && search.trim()) {
        const keyword = `%${search.trim()}%`;
        const sample = db.get(`SELECT * FROM ${table} LIMIT 1`);
        if (sample) {
          const keys = Object.keys(sample);
          const whereClause = keys.map((k) => `${k} LIKE ?`).join(" OR ");
          const params = keys.map(() => keyword);

          const countRes = db.get(
            `SELECT COUNT(*) as count FROM ${table} WHERE ${whereClause}`,
            params,
          );
          totalCount = countRes ? countRes.count : 0;

          const sql = `SELECT * FROM ${table} WHERE ${whereClause} ${orderClause} LIMIT ${limitNum} OFFSET ${offsetNum}`;
          rows = db.all(sql, params);
        }
      } else {
        const countRes = db.get(`SELECT COUNT(*) as count FROM ${table}`);
        totalCount = countRes ? countRes.count : 0;

        const sql = `SELECT * FROM ${table} ${orderClause} LIMIT ${limitNum} OFFSET ${offsetNum}`;
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
    } catch (err: any) {
      return reply.status(500).send({ error: `Query failed: ${err.message}` });
    }
  });

  // 3. Clear table data
  fastify.post("/api/db/clear", async (request, reply) => {
    const { table } = (request.body as { table?: string }) || {};
    if (!table) {
      return reply.status(400).send({ error: "Missing 'table' parameter." });
    }

    try {
      db.exec(`DELETE FROM ${table}`);
      return { success: true, message: `Table '${table}' cleared.` };
    } catch (err: any) {
      return reply.status(500).send({ error: `Clear failed: ${err.message}` });
    }
  });

  // 4. Delete single row from table
  fastify.post("/api/db/delete-row", async (request, reply) => {
    const { table, primaryKey, primaryValue } =
      (request.body as { table?: string; primaryKey?: string; primaryValue?: any }) || {};
    if (!table || !primaryKey || primaryValue === undefined) {
      return reply.status(400).send({ error: "Missing 'table', 'primaryKey', or 'primaryValue'." });
    }

    try {
      db.run(`DELETE FROM ${table} WHERE ${primaryKey} = ?`, [primaryValue]);
      return { success: true, message: `Row where ${primaryKey}='${primaryValue}' deleted.` };
    } catch (err: any) {
      return reply.status(500).send({ error: `Delete row failed: ${err.message}` });
    }
  });
}
