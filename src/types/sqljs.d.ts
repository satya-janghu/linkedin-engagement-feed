declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Database {
    exec(sql: string): QueryExecResult[];
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string, params?: unknown[]): Statement;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
