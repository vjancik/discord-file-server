/**
 * Runs once per server instance, before requests are served: validates env
 * (fail fast on misconfiguration) and applies pending DB migrations.
 * Cleanup jobs (staging GC, expiry) and capacity bookkeeping (staging
 * ledger rebuild, hourly reconcile, low-disk warnings) are started here too.
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
  const { scanStaging, rebuildLedger, reconcileLedger } = await import(
    "@/server/capacity/staging-scan"
  );
  const { LOW_DISK_WARN_BYTES } = await import("@/server/capacity/disk");
  const { fileRepo, files, stagingLedger, diskProbe } = getContainer();

  // Resumed uploads never re-enter onUploadCreate, so after a restart the
  // staging sidecars are the only record of in-flight reservations.
  const restored = rebuildLedger(
    await scanStaging(env.STAGING_DIR),
    stagingLedger,
  );
  if (restored > 0) {
    log.info({ restored }, "restored staging reservations from sidecars");
  }

  const warnIfLowDisk = async (label: string, dir: string) => {
    try {
      const free = await diskProbe.freeBytes(dir);
      if (free < LOW_DISK_WARN_BYTES) {
        log.warn(
          { dir, freeBytes: free },
          `${label} volume is low on disk space`,
        );
      }
    } catch (err) {
      log.warn({ err, dir }, `could not check ${label} free space`);
    }
  };

  const runCleanup = async () => {
    await collectStagingGarbage(env.STAGING_DIR, stagingLedger).catch((err) =>
      log.error({ err }, "staging GC failed"),
    );
    await deleteExpiredFiles(fileRepo, files).catch((err) =>
      log.error({ err }, "expiry job failed"),
    );
    // Self-heal ledger drift (missed release paths) instead of requiring
    // every release path to be perfect forever.
    try {
      const drift = reconcileLedger(
        await scanStaging(env.STAGING_DIR),
        stagingLedger,
      );
      if (drift.added > 0 || drift.released > 0) {
        log.warn({ ...drift }, "staging ledger drifted; reconciled from disk");
      }
    } catch (err) {
      log.error({ err }, "ledger reconcile failed");
    }
    await warnIfLowDisk("staging", env.STAGING_DIR);
    await warnIfLowDisk("storage", env.STORAGE_DIR);
  };
  await runCleanup();
  setInterval(runCleanup, 60 * 60 * 1000); // hourly

  log.info(
    { baseUrl: env.baseUrl },
    "environment validated, migrations applied, cleanup scheduled",
  );
}
