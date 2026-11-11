import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import path from 'node:path';

/**
 * Applies the project's SQL migrations into the current `search_path` schema.
 *
 * Drizzle's own migrator is deliberately not used here: it pins the migration
 * journal to a fixed schema, which makes per-test-schema isolation impossible.
 * Production uses the real migrator (see `src/db/migrate.ts`).
 */
export async function applyMigrationsToSchema(
  pool: pg.Pool,
  schema: string,
  migrationsFolder = path.join(process.cwd(), 'drizzle'),
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const client = await pool.connect();  try {
    // Strip any `SET LOCAL search_path` so the migration objects are created in
    // the throwaway schema rather than wherever the file points.
    await client.query(
      `select set_config('search_path', $1, false)`,
      [schema],
    );
    await client.query('begin');
    await client.query('create schema if not exists drizzle');
    await client.query(
      `create table if not exists drizzle.__drizzle_migrations (
         id serial primary key, hash text not null, created_at bigint
       )`,
    );
    for (const migration of migrations) {
      for (const statement of migration.sql) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        if (/^SET\s+LOCAL\s+search_path/i.test(trimmed)) continue;
        // Drizzle qualifies FK targets as "public"."users"; retarget to the test schema.
        const rewritten = trimmed.replaceAll('"public".', `"${schema}".`);
        try {
          await client.query(rewritten);
        } catch (error) {
          throw new Error(
            `Migration failed on statement: ${rewritten.slice(0, 200)} :: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
      await client.query(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
