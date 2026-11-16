import type { Database as SqlDb, SqlValue } from "sql.js";

/**
 * SQLite en WebAssembly (sql.js). Cette classe ne dépend ni de Node ni du navigateur :
 * la persistance éventuelle est fournie par `persist` (fichier sur PC, rien sur le web).
 */
export class Database {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(protected db: SqlDb, private persist?: (bytes: Uint8Array) => void) {}

  private static norm(params: unknown[]): SqlValue[] {
    return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as SqlValue)));
  }

  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(Database.norm(params));
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, Database.norm(params));
    this.scheduleFlush();
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (!this.persist) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (!this.persist) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.persist(this.db.export());
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
