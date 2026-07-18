import { unlink } from "node:fs/promises";
import { FileStore } from "@tus/file-store";
import { Server, type Upload } from "@tus/server";
import { auth } from "@/auth/auth";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { getContainer } from "@/server/container";
import { UploadRejectedError } from "@/server/files/finalize.service";
import { classifyUpload } from "@/server/files/type-policy";

const log = createLogger("tus");

type TusError = { status_code: number; body: string };
const reject = (status_code: number, body: string): TusError => ({
  status_code,
  body,
});

async function requireSessionUser(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw reject(401, "Sign in to upload files.");
  return session.user;
}

/**
 * tus resumable-upload server (PRD §3 upload flow): chunks land in SSD
 * staging via FileStore; auth runs on every request; policy + quota gate
 * creation (size is known up front, so oversized uploads fail fast); the
 * finalize service publishes the file and the hook returns both links.
 */
function createTusServer(): Server {
  const env = getEnv();

  return new Server({
    path: "/api/upload",
    datastore: new FileStore({ directory: env.STAGING_DIR }),
    // Mint upload URLs from the configured public origin, never from request
    // headers: TLS terminates upstream (Caddy, or Cloudflare's edge when
    // tunneled), so requests reach the app as plain http and a header-derived
    // Location would be http:// — which browsers then block as mixed content
    // on the follow-up PATCH.
    generateUrl: (_req, { path, id }) => `${env.baseUrl}${path}/${id}`,

    async onIncomingRequest(req) {
      await requireSessionUser(req);
    },

    async onUploadCreate(req, upload) {
      const user = await requireSessionUser(req);
      const { settingsRepo, quota, files } = getContainer();

      if (!upload.size)
        throw reject(400, "Upload size must be known up front.");
      const rawFileName = upload.metadata?.filename;
      if (!rawFileName) throw reject(400, "filename metadata is required.");

      const classified = classifyUpload(
        rawFileName,
        upload.metadata?.filetype ?? undefined,
      );
      if (!classified.ok) throw reject(422, classified.reason);

      const plan = quota.planUpload(
        user.id,
        upload.size,
        settingsRepo.get(user.id).autoDeleteOldest,
      );
      if (plan.action === "reject") throw reject(413, plan.reason);
      for (const old of plan.toDelete) {
        log.info(
          { fileId: old.id, userId: user.id },
          "auto-deleting oldest file to free quota",
        );
        await files.delete(old.id, user.id);
      }

      return { metadata: { ...upload.metadata, ownerId: user.id } };
    },

    async onUploadFinish(req, upload: Upload) {
      const user = await requireSessionUser(req);
      const { finalize } = getContainer();
      const stagingPath = (upload.storage as { path: string }).path;

      try {
        const row = await finalize.finalize({
          stagingPath,
          ownerId: user.id,
          rawFileName: upload.metadata?.filename ?? "file",
          clientMime: upload.metadata?.filetype ?? undefined,
          sizeBytes: upload.size ?? 0,
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
        if (err instanceof UploadRejectedError) throw reject(422, err.message);
        log.error({ err }, "finalize failed");
        throw reject(500, "Upload processing failed.");
      } finally {
        // The data file was moved (or rolled back); drop FileStore's .info sidecar.
        await unlink(`${stagingPath}.json`).catch(() => {});
      }
    },

    onResponseError(_req, err) {
      log.error({ err }, "tus request failed");
      return undefined;
    },
  });
}

let cached: Server | undefined;

export function getTusServer(): Server {
  cached ??= createTusServer();
  return cached;
}
