import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { Database as CoreDatabase } from "./db-core";

/** Version Node/Electron : la base vit en mémoire et est écrite atomiquement sur disque 200 ms après chaque modification. */
export class Database extends CoreDatabase {
  static async open(file?: string, wasmDir?: string): Promise<Database> {
    const SQL = await initSqlJs(wasmDir ? { locateFile: (f: string) => path.join(wasmDir, f) } : {});
    const data = file && fs.existsSync(file) ? fs.readFileSync(file) : undefined;
    const persist = file
      ? (bytes: Uint8Array) => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.tmp`;
          fs.writeFileSync(tmp, Buffer.from(bytes));
          fs.renameSync(tmp, file);
        }
      : undefined;
    return new Database(new SQL.Database(data), persist);
  }
}
