import { Download, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession, isAdmin } from "@/auth/dal";
import { CopyButton } from "@/components/copy-button";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { getEnv } from "@/lib/env";
import { getContainer } from "@/server/container";
import { trimCardDescription } from "@/server/embeds/og-builder";
import { canonicalUrl, shortUrl, thumbnailUrl } from "@/server/links/urls";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

/** Same liveness rules as /s: tombstoned or expired short links are dead. */
function findLiveFile(code: string) {
  const { fileRepo, embedSources } = getContainer();
  const file = fileRepo.findLiveByShortCode(code);
  if (!file || (file.expiresAt && file.expiresAt.getTime() < Date.now())) {
    return null;
  }
  return { file, source: embedSources.get(file.id) };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { code } = await params;
  const found = findLiveFile(code);
  if (!found?.source) return { robots: { index: false } };
  const { file, source } = found;
  const thumb = thumbnailUrl(getEnv().baseUrl, file);
  const description = source.description
    ? trimCardDescription(source.description)
    : undefined;
  return {
    title: source.title,
    description,
    robots: { index: false },
    openGraph: {
      title: source.title,
      description,
      ...(thumb ? { images: [{ url: thumb }] } : {}),
    },
  };
}

/**
 * Watch page for /embed_video files (docs/embed-video.md, second iteration):
 * inline player, source title below it (YouTube-style), link buttons, full
 * untrimmed description in a card. Public like /s and /f — the short code is
 * the capability — but wears the shared site header (signed-out visitors get
 * a Sign in button). Files without embed metadata keep their old behavior
 * (the raw file) and never land here.
 */
export default async function WatchPage({ params }: Params) {
  const { code } = await params;
  const found = findLiveFile(code);
  if (!found) notFound();
  const { baseUrl } = getEnv();
  const { file, source } = found;
  if (!source) redirect(canonicalUrl(baseUrl, file));

  const session = await getSession();
  const user = session?.user ?? null;
  const admin = user ? await isAdmin(user.id) : false;

  const canonical = canonicalUrl(baseUrl, file);
  const thumb = thumbnailUrl(baseUrl, file);
  const aspectRatio =
    file.width && file.height ? `${file.width} / ${file.height}` : "16 / 9";

  // YouTube-style "1,299,168 views · May 17, 2026"; parts absent when the
  // source didn't expose them. UTC keeps date-only publish dates exact.
  const stats = [
    source.viewCount !== null
      ? `${new Intl.NumberFormat("en-US").format(source.viewCount)} views`
      : null,
    source.uploadedAt
      ? new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeZone: "UTC",
        }).format(source.uploadedAt)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader user={user} admin={admin} />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-6 sm:py-8">
        {file.kind === "audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: source media has no caption tracks
          <audio
            controls
            preload="metadata"
            src={canonical}
            className="w-full"
          />
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: source media has no caption tracks
          <video
            controls
            playsInline
            preload="metadata"
            src={canonical}
            poster={thumb ?? undefined}
            className="max-h-[70svh] w-full rounded-lg bg-black"
            style={{ aspectRatio }}
          />
        )}
        <h1 className="text-balance font-semibold text-xl">{source.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={shortUrl(baseUrl, file)} label="Short URL" />
          <CopyButton value={canonical} label="File URL" />
          {/* Same-origin /f/ URL without Content-Disposition, so the download
              attribute is honored (see DownloadFileButton). */}
          <Button asChild variant="outline" size="sm">
            <a href={canonical} download={file.fileName}>
              Download
              <Download />
            </a>
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={source.sourceUrl}>
              Original URL
              <ExternalLink />
            </a>
          </Button>
        </div>
        {(stats || source.description) && (
          <div className="flex flex-col gap-1 rounded-xl bg-muted/50 p-4 text-sm">
            {stats && <p className="font-medium">{stats}</p>}
            {source.description && (
              <p className="wrap-anywhere whitespace-pre-wrap">
                {source.description}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
