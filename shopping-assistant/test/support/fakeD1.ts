// A minimal in-memory stand-in for D1, covering only the subset of SQL
// the Worker source actually issues (see src/assistant/handler.ts):
// INSERT [OR REPLACE|OR IGNORE] INTO ... VALUES (...), UPDATE ... SET ... WHERE,
// DELETE FROM ... WHERE, and SELECT (also inside `batch()`) [cols|*] FROM ... [WHERE ...]
// [ORDER BY col [ASC|DESC]] [LIMIT ?|n], with
// `?` placeholders and WHERE clauses that are an AND of `col <op> ?`
// comparisons (`=`, `<`, `<=`, `>`, `>=`). `batch()` is atomic, like
// D1's. `migrations/` remains the source of truth for the
// schema — this fake does not read or enforce it beyond the primary keys
// and AUTOINCREMENT ids declared in PRIMARY_KEYS / AUTOINCREMENT_ID
// below, which must stay in sync with that file.
//
// This was chosen over `better-sqlite3` to avoid a native module on
// Windows CI/dev machines.

type FakeRow = Record<string, unknown>;

const PRIMARY_KEYS: Record<string, string[]> = {
  assistant_usage: ['key'],
};

/** Tables whose `id INTEGER PRIMARY KEY AUTOINCREMENT` the fake fills in
 * when an INSERT leaves it out. */
const AUTOINCREMENT_ID = new Set<string>();

type Operator = '=' | '<' | '<=' | '>' | '>=';

interface WhereCondition {
  column: string;
  operator: Operator;
  value: unknown;
}

function parseWhere(clause: string, params: unknown[], cursor: { index: number }): WhereCondition[] {
  return clause.split(/\s+AND\s+/i).map((fragment) => {
    const match = /^(\w+)\s*(=|<=|>=|<|>)\s*\?$/.exec(fragment.trim());
    if (!match) {
      throw new Error(`FakeD1: unsupported WHERE fragment "${fragment}"`);
    }
    return { column: match[1], operator: match[2] as Operator, value: params[cursor.index++] };
  });
}

function rowMatches(row: FakeRow, where: WhereCondition[]): boolean {
  return where.every(({ column, operator, value }) => {
    const actual = row[column] as number | string;
    const expected = value as number | string;
    switch (operator) {
      case '=':
        return actual === expected;
      case '<':
        return actual < expected;
      case '<=':
        return actual <= expected;
      case '>':
        return actual > expected;
      case '>=':
        return actual >= expected;
    }
  });
}

class FakeD1Database {
  private tables = new Map<string, FakeRow[]>();
  private readonly lastIds = new Map<string, number>();
  /** Like SQLite's `last_insert_rowid()`: the id of the last row an
   * INSERT gave an AUTOINCREMENT id to. Reported as `meta.last_row_id`. */
  lastRowId = 0;

  private table(name: string): FakeRow[] {
    if (!this.tables.has(name)) {
      this.tables.set(name, []);
    }
    return this.tables.get(name)!;
  }

  /** Test-only introspection: a snapshot of a table's current rows. */
  dump(name: string): FakeRow[] {
    return this.table(name).map((row) => ({ ...row }));
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql.trim(), []);
  }

  /** Atomic like D1's: if any statement throws, every table is restored
   * to its state before the batch and the error is rethrown. */
  async batch<T = unknown>(statements: FakeStatement[]): Promise<FakeD1Result<T>[]> {
    const snapshot = new Map([...this.tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
    const lastIds = new Map(this.lastIds);
    try {
      const results: FakeD1Result<T>[] = [];
      for (const statement of statements) {
        // Like D1, a SELECT in a batch returns its rows in `results`.
        results.push(statement.isQuery() ? await statement.all<T>() : await statement.run<T>());
      }
      return results;
    } catch (error) {
      this.tables = snapshot;
      this.lastIds.clear();
      lastIds.forEach((value, key) => this.lastIds.set(key, value));
      throw error;
    }
  }

  /** Runs a write statement; returns the number of rows changed. */
  execute(sql: string, params: unknown[]): number {
    let match: RegExpExecArray | null;

    match = /^INSERT\s+(?:OR\s+(REPLACE|IGNORE)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)$/i.exec(sql);
    if (match) {
      const [, conflict, table, colsRaw, placeholdersRaw] = match;
      const cols = colsRaw.split(',').map((c) => c.trim());
      const placeholderCount = placeholdersRaw.split(',').length;
      if (placeholderCount !== cols.length) {
        throw new Error('FakeD1: column/value count mismatch');
      }
      const row: FakeRow = {};
      cols.forEach((col, i) => (row[col] = params[i]));
      if (AUTOINCREMENT_ID.has(table) && row.id === undefined) {
        const id = (this.lastIds.get(table) ?? 0) + 1;
        this.lastIds.set(table, id);
        row.id = id;
        this.lastRowId = id;
      }
      const rows = this.table(table);
      const pk = PRIMARY_KEYS[table] ?? [];
      const existingIndex = pk.length > 0 ? rows.findIndex((r) => pk.every((k) => r[k] === row[k])) : -1;
      if (existingIndex >= 0) {
        if (conflict?.toUpperCase() === 'IGNORE') {
          return 0;
        }
        if (conflict?.toUpperCase() !== 'REPLACE') {
          throw new Error(`FakeD1: duplicate primary key on ${table}`);
        }
        rows[existingIndex] = row;
      } else {
        rows.push(row);
      }
      return 1;
    }

    match = /^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i.exec(sql);
    if (match) {
      const [, table, setClause, whereClause] = match;
      const setCols = setClause.split(',').map((part) => part.trim().split('=')[0].trim());
      const cursor = { index: 0 };
      const setValues = setCols.map(() => params[cursor.index++]);
      const where = parseWhere(whereClause, params, cursor);
      const matching = this.table(table).filter((row) => rowMatches(row, where));
      matching.forEach((row) => setCols.forEach((col, i) => (row[col] = setValues[i])));
      return matching.length;
    }

    match = /^DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)$/i.exec(sql);
    if (match) {
      const [, table, whereClause] = match;
      const cursor = { index: 0 };
      const where = parseWhere(whereClause, params, cursor);
      const before = this.table(table);
      const kept = before.filter((row) => !rowMatches(row, where));
      this.tables.set(table, kept);
      return before.length - kept.length;
    }

    throw new Error(`FakeD1: unsupported statement "${sql}"`);
  }

  query(sql: string, params: unknown[]): FakeRow[] {
    const match =
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\?|\d+))?$/i.exec(
        sql,
      );
    if (!match) {
      throw new Error(`FakeD1: unsupported query "${sql}"`);
    }
    const [, colsRaw, table, whereClause, orderBy, direction, limitRaw] = match;
    let rows = this.table(table);
    const cursor = { index: 0 };
    if (whereClause) {
      const where = parseWhere(whereClause, params, cursor);
      rows = rows.filter((row) => rowMatches(row, where));
    }
    if (orderBy) {
      const sign = direction?.toUpperCase() === 'DESC' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = a[orderBy] as number | string;
        const y = b[orderBy] as number | string;
        return x < y ? -sign : x > y ? sign : 0;
      });
    }
    if (limitRaw) {
      rows = rows.slice(0, limitRaw === '?' ? Number(params[cursor.index++]) : Number(limitRaw));
    }
    if (colsRaw.trim() === '*') {
      return rows.map((row) => ({ ...row }));
    }
    const cols = colsRaw.split(',').map((c) => c.trim());
    return rows.map((row) => {
      const projected: FakeRow = {};
      cols.forEach((col) => (projected[col] = row[col]));
      return projected;
    });
  }
}

interface FakeD1Result<T> {
  success: true;
  results: T[];
  meta: { changes: number; last_row_id: number };
}

class FakeStatement {
  constructor(
    private readonly db: FakeD1Database,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  isQuery(): boolean {
    return /^SELECT\s/i.test(this.sql);
  }

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  async run<T = unknown>(): Promise<FakeD1Result<T>> {
    const changes = this.db.execute(this.sql, this.params);
    return { success: true, results: [], meta: { changes, last_row_id: this.db.lastRowId } };
  }

  async first<T = unknown>(): Promise<T | null> {
    const rows = this.db.query(this.sql, this.params);
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<FakeD1Result<T>> {
    const rows = this.db.query(this.sql, this.params);
    return { success: true, results: rows as T[], meta: { changes: 0, last_row_id: this.db.lastRowId } };
  }
}

/** Creates a fresh fake D1 database, cast to the real `D1Database` type
 * so it drops straight into `Env.DB` in tests. Only the methods this
 * Worker calls (`prepare`/`bind`/`run`/`first`/`all`/`batch`) are
 * implemented; anything else is intentionally absent. */
export function createFakeD1(): D1Database {
  return new FakeD1Database() as unknown as D1Database;
}

/** Test-only: reads back a table's rows for assertions. */
export function dumpTable(db: D1Database, table: string): FakeRow[] {
  return (db as unknown as FakeD1Database).dump(table);
}
