import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export class D1Mock {
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    for (const migration of readdirSync(new URL('../drizzle/', import.meta.url)).filter(p => p.endsWith('.sql')).sort()) this.raw.exec(readFileSync(new URL('../drizzle/' + migration, import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
  }
  prepare(sql) {
    const db = this;
    return { values: [], sql, bind(...values) { this.values = values; return this; },
      async first() { return db.raw.prepare(sql).get(...this.values) || null; },
      execute() { const stmt = db.raw.prepare(sql); if (stmt.columns().length) return { results: stmt.all(...this.values), meta: { changes: 0 } }; const result = stmt.run(...this.values); return { results: [], meta: { changes: Number(result.changes) } }; },
      async all() { return this.execute(); }, async run() { return this.execute(); }
    };
  }
  async batch(statements) { this.raw.exec('BEGIN IMMEDIATE'); try { const result = statements.map(s => s.execute()); this.raw.exec('COMMIT'); return result; } catch (e) { this.raw.exec('ROLLBACK'); throw e; } }
}
