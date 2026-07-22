import { getEnv } from "@/lib/env";
import { getContainer } from "@/server/container";
import { buildMastodonStatus } from "@/server/embeds/mastodon";

/**
 * Mastodon API v1 status endpoint backing the /s_beta Mastodon trick
 * (docs/mastodon-trick.md): Discord derives this URL from the activity+json
 * alternate link and renders the returned status as the embed. The id
 * namespace is our short code, with the same liveness rules as /s.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params;
  const { fileRepo, embedSources } = getContainer();
  const { baseUrl } = getEnv();

  const file = fileRepo.findLiveByShortCode(code);
  if (!file || (file.expiresAt && file.expiresAt.getTime() < Date.now())) {
    return Response.json({ error: "Record not found" }, { status: 404 });
  }

  const source = embedSources.get(file.id);
  const uploader = await fileRepo.ownerName(file.ownerId);
  const status = buildMastodonStatus(
    { ...file, uploaderName: uploader ?? "unknown", source },
    baseUrl,
  );
  return Response.json(status, {
    headers: { "X-Robots-Tag": "noindex" },
  });
}
