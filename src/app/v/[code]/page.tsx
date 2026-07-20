import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession, isAdmin } from "@/auth/dal";
import { WatchView } from "@/components/files/watch-view";
import { SiteHeader } from "@/components/site-header";
import { getEnv } from "@/lib/env";
import { toFileView } from "@/lib/file-view";
import { getContainer } from "@/server/container";
import { trimCardDescription } from "@/server/embeds/og-builder";
import { canonicalUrl, thumbnailUrl } from "@/server/links/urls";

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
 * the shared WatchView (also used by the dashboard preview dialog) inside the
 * site container. Public like /s and /f — the short code is the capability —
 * but wears the shared site header (signed-out visitors get a Sign in
 * button). Files without embed metadata keep their old behavior (the raw
 * file) and never land here.
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

  const view = toFileView(file, baseUrl, source);
  if (!view.embed) redirect(canonicalUrl(baseUrl, file));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader user={user} admin={admin} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        <WatchView file={view} embed={view.embed} />
      </main>
    </div>
  );
}
