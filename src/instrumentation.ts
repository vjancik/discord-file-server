/**
 * Runs once per server instance, before requests are served: validates env
 * (fail fast on misconfiguration) and applies pending DB migrations.
 * Cleanup jobs (staging GC, expiry) are started here too.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEnv } = await import("@/lib/env");
  const { getDb } = await import("@/db/client");
  const { runMigrations } = await import("@/db/migrate");
  const { createLogger } = await import("@/lib/logger");

  const log = createLogger("boot");
  const env = getEnv();
  runMigrations(getDb());

  const { getContainer } = await import("@/server/container");
  const { collectStagingGarbage } = await import("@/server/cleanup/staging-gc");
  const { deleteExpiredFiles } = await import("@/server/cleanup/expiry");
  const { fileRepo, files } = getContainer();
  const runCleanup = async () => {
    await collectStagingGarbage(env.STAGING_DIR).catch((err) =>
      log.error({ err }, "staging GC failed"),
    );
    await deleteExpiredFiles(fileRepo, files).catch((err) =>
      log.error({ err }, "expiry job failed"),
    );
  };
  await runCleanup();
  setInterval(runCleanup, 60 * 60 * 1000); // hourly

  log.info(
    { baseUrl: env.baseUrl },
    "environment validated, migrations applied, cleanup scheduled",
  );
}
