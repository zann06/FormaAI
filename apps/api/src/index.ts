/**
 * FormaAI API entry point.
 *
 * Boot sequence:
 *   1. load + validate configuration (fails fast on production misconfig)
 *   2. apply pending database migrations (idempotent; safe with several replicas)
 *   3. build the Fastify server
 *   4. start the DB-backed job worker (unless WORKER_ENABLED is off)
 *   5. listen and handle SIGTERM/SIGINT for graceful shutdown
 */
import 'dotenv/config';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './server.js';
import { JobWorker } from './services/worker/index.js';

async function main(): Promise<void> {
  const config = loadConfig();

  await runMigrations(config.DATABASE_URL);

  const built = await buildServer({ config });
  const { app, dbHandle } = built;

  let worker: JobWorker | null = null;
  if (config.WORKER_ENABLED) {
    worker = new JobWorker(built.workerServices, built.db, {
      concurrency: config.WORKER_CONCURRENCY,
      logger: built.safeLogger,
    });
    // Requeue jobs that were mid-flight when the previous process died.
    await worker.recoverStaleJobs();
    worker.start();
  } else {
    app.log.warn('WORKER_ENABLED is off — jobs will be queued but never executed by this process');
  }

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  app.log.info(
    {
      port: config.API_PORT,
      env: config.NODE_ENV,
      pdfConversion: Boolean(config.LIBREOFFICE_BIN || config.CONVERTER_URL),
      worker: config.WORKER_ENABLED,
    },
    'FormaAI API ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      if (worker) await worker.stop();
      await app.close();
      await dbHandle.close();
    } catch (error) {
      app.log.error({ error: (error as Error).message }, 'error during shutdown');
      process.exitCode = 1;
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Deliberately avoid dumping the error object: stack frames can include
  // interpolated connection strings.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FormaAI API failed to start: ${message}`);
  process.exit(1);
});
