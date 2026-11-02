/** Pequenos atalhos sobre o D1 (SQLite na Cloudflare). */
type Arg = string | number | null | undefined | boolean;
const limpa = (a: Arg[]) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x));

export async function all<T = Record<string, any>>(db: D1Database, sql: string, ...args: Arg[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...limpa(args)).all<T>();
  return r.results ?? [];
}

export async function first<T = Record<string, any>>(db: D1Database, sql: string, ...args: Arg[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...limpa(args)).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...args: Arg[]): Promise<{ id: number; changes: number }> {
  const r = await db.prepare(sql).bind(...limpa(args)).run();
  return { id: Number(r.meta.last_row_id ?? 0), changes: Number(r.meta.changes ?? 0) };
}

export async function kvGet(db: D1Database, chave: string): Promise<string | null> {
  return (await first<{ valor: string }>(db, "SELECT valor FROM kv WHERE chave = ?", chave))?.valor ?? null;
}

export async function kvSet(db: D1Database, chave: string, valor: string) {
  await run(db, "INSERT INTO kv (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", chave, valor);
}
