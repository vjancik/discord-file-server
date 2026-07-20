import { getEnv } from "@/lib/env";
import { getContainer } from "@/server/container";
import { buildOgHtml } from "@/server/embeds/og-builder";
import { isEmbedCrawler } from "@/server/embeds/ua";
import { canonicalUrl } from "@/server/links/urls";

/**
 * Short-link resolution (PRD §4/§5): embed crawlers receive an OG-tagged HTML
 * page; everyone else is 302-redirected to the canonical file URL (served by
 * Caddy) — except /embed_video files, whose human destination is the /v watch
 * page (title, player, description). Dead or expired links 404.
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

  if (isEmbedCrawler(req.headers.get("user-agent"))) {
    const uploader = await fileRepo.ownerName(file.ownerId);
    const html = buildOgHtml(
      { ...file, uploaderName: uploader ?? "unknown", source },
      baseUrl,
      EMBED_SIZE_LIMIT,
    );
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  if (source) return Response.redirect(`${baseUrl}/v/${file.shortCode}`, 302);
  return Response.redirect(canonicalUrl(baseUrl, file), 302);
}
