import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(connectionString: string, migrationsFolder = path.join(here, '../../drizzle')) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = loadConfig();
  runMigrations(config.DATABASE_URL)
    .then(() => {
      console.log('Migrations applied');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
