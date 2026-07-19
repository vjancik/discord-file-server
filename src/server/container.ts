import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { AdmissionService } from "./capacity/admission.service";
import { StatfsDiskProbe } from "./capacity/disk";
import { StagingLedger } from "./capacity/staging-ledger";
import { evictStagingUnderPressure } from "./cleanup/staging-gc";
import { FileRepository } from "./files/file.repository";
import { FileService } from "./files/file.service";
import { FinalizeService } from "./files/finalize.service";
import { FileStorage } from "./files/storage";
import { FfmpegProber } from "./media/prober";
import { QuotaService } from "./quota/quota.service";
import { JtiRepository } from "./uploads/service-token";
import { SettingsRepository } from "./users/settings.repository";

/**
 * Composition root: services wired with real adapters and validated env.
 * Tests never import this — they construct services with fakes directly.
 */
export interface Container {
  fileRepo: FileRepository;
  settingsRepo: SettingsRepository;
  storage: FileStorage;
  quota: QuotaService;
  finalize: FinalizeService;
  files: FileService;
  stagingLedger: StagingLedger;
  diskProbe: StatfsDiskProbe;
  admission: AdmissionService;
  jtis: JtiRepository;
}

let cached: Container | undefined;

export function getContainer(): Container {
  if (cached) return cached;
  const env = getEnv();
  const db = getDb();
  const fileRepo = new FileRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const storage = new FileStorage(env.STORAGE_DIR);
  const stagingLedger = new StagingLedger();
  const diskProbe = new StatfsDiskProbe();
  cached = {
    fileRepo,
    settingsRepo,
    storage,
    quota: new QuotaService(fileRepo, {
      storageLimit: env.STORAGE_LIMIT,
      maxFileSize: env.MAX_FILE_SIZE,
    }),
    finalize: new FinalizeService(fileRepo, storage, new FfmpegProber(), {
      defaultExpiryMs: env.DEFAULT_FILE_EXPIRY,
    }),
    files: new FileService(fileRepo, storage),
    jtis: new JtiRepository(db),
    stagingLedger,
    diskProbe,
    admission: new AdmissionService(
      stagingLedger,
      diskProbe,
      fileRepo,
      {
        stagingDir: env.STAGING_DIR,
        storageDir: env.STORAGE_DIR,
        stagingLimit: env.STAGING_LIMIT,
        storageLimit: env.STORAGE_LIMIT,
      },
      (neededBytes) =>
        evictStagingUnderPressure(env.STAGING_DIR, stagingLedger, neededBytes),
    ),
  };
  return cached;
}
