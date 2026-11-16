import fs from "node:fs";
import path from "node:path";
import initSqlJs, { type Database as SqlDb, type SqlValue } from "sql.js";

/**
 * SQLite en WebAssembly (sql.js) : aucune dépendance native, donc rien à recompiler pour Electron.
 * La base vit en mémoire et est écrite sur disque (atomiquement) 200 ms après chaque modification.
 */
export class Database {
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(private db: SqlDb, private file?: string) {}

  static async open(file?: string, wasmDir?: string): Promise<Database> {
    const SQL = await initSqlJs(wasmDir ? { locateFile: (f: string) => path.join(wasmDir, f) } : {});
    const data = file && fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    return new Database(new SQL.Database(data), file);
  }

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
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(this.db.export()));
    fs.renameSync(tmp, this.file);
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
