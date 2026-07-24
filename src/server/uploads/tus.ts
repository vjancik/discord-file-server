import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { FileStore } from "@tus/file-store";
import { EVENTS, Server, type Upload } from "@tus/server";
import { auth } from "@/auth/auth";
import { extensionOf } from "@/lib/blocked-extensions";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { getContainer } from "@/server/container";
import { UploadRejectedError } from "@/server/files/finalize.service";
import { classifyUpload } from "@/server/files/type-policy";
import { verifyServiceToken } from "./service-token";
import { SingleFlight } from "./single-flight";

const log = createLogger("tus");

/**
 * tus stores completed uploads under a bare random id, which leaves the
 * staging data file with no extension. Downstream tools that key off the
 * extension then misbehave — exiftool tries to *create* a JPEG from scratch
 * ("Can't create JPEG files from scratch") instead of copying an extensionless
 * source. Appending the real extension keeps the whole pipeline's intermediate
 * files self-describing and inspectable; the sidecar tus writes alongside is
 * `<id>.json`, so it becomes `<id>.<ext>.json` and the pair still matches on
 * suffix (see scanStaging).
 *
 * The extension is derived from the untrusted client filename, so it is
 * hard-sanitised to a short lowercase-alphanumeric token before it can touch a
 * path — never trust it to be free of separators or dots.
 */
export function stagingNamingFunction(
  metadata?: Record<string, string | null>,
): string {
  const id = randomBytes(16).toString("hex");
  const ext = safeExt(metadata?.filename ?? undefined);
  return ext ? `${id}.${ext}` : id;
}

/** Longest extension we bother preserving on the staging file (e.g. "jpeg"). */
const MAX_STAGING_EXT_LEN = 12;

function safeExt(fileName: string | undefined): string {
  if (!fileName) return "";
  // extensionOf already lowercases and strips to the last dot, but the client
  // filename is untrusted: keep only [a-z0-9] so no separator, dot, or control
  // character can ride into the staging path.
  const cleaned = extensionOf(fileName).replace(/[^a-z0-9]/g, "");
  return cleaned.slice(0, MAX_STAGING_EXT_LEN);
}

/**
 * How long a successful finalize response is kept for retries. A client whose
 * final PATCH response was lost (network blip, proxy timeout on a slow
 * finalize) retries within its backoff window; a retained response hands it
 * the same links instead of failing on the already-consumed staging file.
 */
const FINALIZE_RETAIN_MS = 5 * 60 * 1000;

type TusError = { status_code: number; body: string };
const reject = (status_code: number, body: string): TusError => ({
  status_code,
  body,
});

/**
 * Who is uploading: a signed-in browser session, or the bot acting for a user
 * via a service token (docs/embed-auth.md). Token requests carry the claims so
 * onUploadCreate can consume the single-use jti and apply maxBytes.
 */
type UploadActor = {
  id: string;
  serviceToken?: { jti: string; exp: number; maxBytes?: number };
};

const SERVICE_TOKEN_HEADER = "x-service-token";

async function requireUploadActor(req: Request): Promise<UploadActor> {
  const token = req.headers.get(SERVICE_TOKEN_HEADER);
  if (token !== null) {
    const secrets = getEnv().BOT_SERVICE_SECRET;
    const claims = secrets && verifyServiceToken(token, secrets);
    if (!claims) throw reject(401, "Invalid or expired service token.");
    const { userId, ...rest } = claims;
    return { id: userId, serviceToken: rest };
  }
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw reject(401, "Sign in to upload files.");
  return { id: session.user.id };
}

/**
 * tus resumable-upload server (PRD §3 upload flow): chunks land in SSD
 * staging via FileStore; auth runs on every request; policy + quota gate
 * creation (size is known up front, so oversized uploads fail fast); the
 * finalize service publishes the file and the hook returns both links.
 */
function createTusServer(): Server {
  const env = getEnv();
  type FinalizeResponse = {
    status_code: number;
    headers: Record<string, string>;
    body: string;
  };
  const finalizeOnce = new SingleFlight<FinalizeResponse>(FINALIZE_RETAIN_MS);

  return new Server({
    path: "/api/upload",
    datastore: new FileStore({ directory: env.STAGING_DIR }),
    // Keep the real extension on the staging file so the pipeline's
    // intermediate files stay self-describing (see stagingNamingFunction).
    namingFunction: (_req, metadata) => stagingNamingFunction(metadata),
    // The staging file must not be deleted out from under a running finalize:
    // the per-upload lock is released before onUploadFinish runs, so a cancel
    // (DELETE) could otherwise race it. Once all bytes are in, termination is
    // refused instead.
    disableTerminationForFinishedUploads: true,
    // Mint upload URLs from the configured public origin, never from request
    // headers: TLS terminates upstream (Caddy, or Cloudflare's edge when
    // tunneled), so requests reach the app as plain http and a header-derived
    // Location would be http:// — which browsers then block as mixed content
    // on the follow-up PATCH.
    generateUrl: (_req, { path, id }) => `${env.baseUrl}${path}/${id}`,

    async onIncomingRequest(req) {
      await requireUploadActor(req);
    },

    async onUploadCreate(req, upload) {
      const user = await requireUploadActor(req);
      const { settingsRepo, quota, files, admission, stagingLedger, jtis } =
        getContainer();

      if (!upload.size)
        throw reject(400, "Upload size must be known up front.");
      if (
        user.serviceToken?.maxBytes !== undefined &&
        upload.size > user.serviceToken.maxBytes
      )
        throw reject(413, "Upload exceeds the service token's size cap.");
      const rawFileName = upload.metadata?.filename;
      if (!rawFileName) throw reject(400, "filename metadata is required.");

      const classified = classifyUpload(
        rawFileName,
        upload.metadata?.filetype ?? undefined,
      );
      if (!classified.ok) throw reject(422, classified.reason);

      // The user's in-flight reservations count against their quota so two
      // concurrent uploads can't both pass against the same usage.
      const plan = quota.planUpload(
        user.id,
        upload.size,
        settingsRepo.get(user.id).autoDeleteOldest,
        stagingLedger.reservedByOwner(user.id),
      );
      if (plan.action === "reject") throw reject(413, plan.reason);

      // Admission runs before the plan's auto-deletes execute (they're
      // credited via bytesFreedByPlan): a wait/reject must not have already
      // deleted the user's old files — a 429 retry re-runs this whole hook.
      const decision = await admission.admit({
        ownerId: user.id,
        sizeBytes: upload.size,
        bytesFreedByPlan: plan.toDelete.reduce((s, f) => s + f.sizeBytes, 0),
      });
      // 429 = "retry later": the tus client backs off and retries, which is
      // our no-FIFO wait queue. Hard rejects must be a non-429 4xx — a 5xx
      // (e.g. the semantically nicer 507) would also be retried forever.
      if (decision.action === "wait") throw reject(429, decision.reason);
      if (decision.action === "reject") throw reject(413, decision.reason);

      // Consume the single-use jti only after every gate passed: a 429 wait
      // retry must not burn it. From here on the token cannot start another
      // upload (docs/embed-auth.md).
      if (user.serviceToken) {
        const { jti, exp } = user.serviceToken;
        if (!jtis.consume(jti, new Date(exp)))
          throw reject(401, "Service token already used.");
      }

      for (const old of plan.toDelete) {
        log.info(
          { fileId: old.id, userId: user.id },
          "auto-deleting oldest file to free quota",
        );
        await files.delete(old.id, user.id);
      }

      // Reserve after all gates pass. If FileStore.create still fails (e.g.
      // disk error) the reservation leaks until the hourly reconcile — the
      // sidecar won't exist, so reconciliation releases it.
      stagingLedger.reserve(upload.id, upload.size, user.id);

      return { metadata: { ...upload.metadata, ownerId: user.id } };
    },

    async onUploadFinish(req, upload: Upload) {
      const user = await requireUploadActor(req);
      // The upload belongs to whoever created it; a different actor (e.g. a
      // second service token for another user) must not finalize it.
      const ownerId = upload.metadata?.ownerId;
      if (ownerId && ownerId !== user.id)
        throw reject(403, "Upload belongs to a different user.");

      // The tus lock is released before this hook runs, so a retried final
      // PATCH can arrive while finalize is still in flight — single-flight
      // per upload id makes it await (or reuse) the original finalize
      // instead of racing it against the same staging file.
      return finalizeOnce.run(upload.id, async () => {
        const { finalize, settingsRepo } = getContainer();
        const stagingPath = (upload.storage as { path: string }).path;
        const settings = settingsRepo.get(user.id);

        try {
          const row = await finalize.finalize({
            stagingPath,
            ownerId: user.id,
            rawFileName: upload.metadata?.filename ?? "file",
            clientMime: upload.metadata?.filetype ?? undefined,
            sizeBytes: upload.size ?? 0,
            sourceThumbnailUrl: upload.metadata?.sourcethumbnail ?? undefined,
            strip: {
              media: settings.stripMediaMetadata,
              documents: settings.stripDocumentMetadata,
            },
          });
          const { baseUrl } = getEnv();
          return {
            status_code: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fileId: row.id,
              fileName: row.fileName,
              kind: row.kind,
              shortUrl: `${baseUrl}/s/${row.shortCode}`,
              canonicalUrl: `${baseUrl}/f/${row.id}/${encodeURIComponent(row.fileName)}`,
            }),
          };
        } catch (err) {
          if (err instanceof UploadRejectedError)
            throw reject(422, err.message);
          log.error({ err }, "finalize failed");
          throw reject(500, "Upload processing failed.");
        } finally {
          // The data file was moved (or rolled back); drop FileStore's .info sidecar.
          await unlink(`${stagingPath}.json`).catch(() => {});
          // Release even on failure: a failed finalize leaves at most an
          // orphaned data file, which the scan counts by its disk size and
          // GC/pressure eviction removes.
          getContainer().stagingLedger.release(upload.id);
        }
      });
    },

    onResponseError(_req, err) {
      log.error({ err }, "tus request failed");
      return undefined;
    },
  });
}

let cached: Server | undefined;

export function getTusServer(): Server {
  if (!cached) {
    cached = createTusServer();
    // Client-cancelled uploads (uppy cancel → tus DELETE): FileStore.remove
    // already deleted the data file and sidecar; free the reservation too.
    cached.on(
      EVENTS.POST_TERMINATE,
      (_req: Request, _res: unknown, id: string) => {
        getContainer().stagingLedger.release(id);
      },
    );
  }
  return cached;
}
