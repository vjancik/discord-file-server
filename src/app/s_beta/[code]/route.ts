import { getEnv } from "@/lib/env";
import { getContainer } from "@/server/container";
import { buildMastodonHtml } from "@/server/embeds/mastodon";
import { buildOgHtml } from "@/server/embeds/og-builder";
import { isDiscordCrawler, isEmbedCrawler } from "@/server/embeds/ua";
import { canonicalUrl, watchUrl } from "@/server/links/urls";

/**
 * Beta variant of /s exploring the Mastodon trick (docs/mastodon-trick.md).
 * Resolves the same short codes as /s. Discordbot gets the Mastodon-pipeline
 * page with a player attachment for every file size (no EMBED_SIZE_LIMIT
 * card fallback — the point is to test size and cache behavior); other
 * crawlers get the standard OG page; humans get the same redirects as /s
 * (/v watch page for /embed_video files, canonical file otherwise).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params;
  const { fileRepo, embedSources } = getContainer();
  const { baseUrl, EMBED_SIZE_LIMIT } = getEnv();

  const file = fileRepo.findLiveByShortCode(code);
  if (!file || (file.expiresAt && file.expiresAt.getTime() < Date.now())) {
    return new Response("Not found", { status: 404 });
  }

  const source = embedSources.get(file.id);
  const userAgent = req.headers.get("user-agent");

  if (isEmbedCrawler(userAgent)) {
    const uploader = await fileRepo.ownerName(file.ownerId);
    const input = { ...file, uploaderName: uploader ?? "unknown", source };
    const html = isDiscordCrawler(userAgent)
      ? buildMastodonHtml(input, baseUrl)
      : buildOgHtml(input, baseUrl, EMBED_SIZE_LIMIT);
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  if (source) return Response.redirect(watchUrl(baseUrl, file), 302);
  return Response.redirect(canonicalUrl(baseUrl, file), 302);
}
