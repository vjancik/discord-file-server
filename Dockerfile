# syntax=docker/dockerfile:1
FROM oven/bun:1.3-slim AS base

# ── Build ──────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

# Per-arch cache id matches the cache-map ids CI restores via
# buildkit-cache-dance (.github/workflows/test-and-build.yml).
ARG TARGETARCH
COPY package.json bun.lock ./
RUN --mount=type=cache,id=bun-$TARGETARCH,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ── Media/bot toolchain (static upstream builds) ───────────────────────────────
# Debian/apk package versions lag upstream; yt-dlp needs current releases for
# site fixes and uses deno as its JS runtime (YouTube nsig). All three are
# glibc-linked static builds, hence the slim (Debian, glibc) base everywhere.
# Bump the versions here (and in the cache ids) to upgrade.
FROM base AS bot-tools
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget unzip xz-utils \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /out

RUN --mount=type=cache,id=yt-dlp-2026-07-04-$TARGETARCH,target=/cache \
    if [ "$TARGETARCH" = "amd64" ]; then \
        YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux"; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux_aarch64"; \
    else \
        echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1; \
    fi \
    && ( [ -s /cache/yt-dlp-2026-07-04 ] || wget -q -O /cache/yt-dlp-2026-07-04 "$YT_DLP_URL" ) \
    && cp /cache/yt-dlp-2026-07-04 /out/yt-dlp \
    && chmod +x /out/yt-dlp

RUN --mount=type=cache,id=deno-v2-7-9-$TARGETARCH,target=/cache \
    if [ "$TARGETARCH" = "amd64" ]; then \
        DENO_URL="https://github.com/denoland/deno/releases/download/v2.7.9/deno-x86_64-unknown-linux-gnu.zip"; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        DENO_URL="https://github.com/denoland/deno/releases/download/v2.7.9/deno-aarch64-unknown-linux-gnu.zip"; \
    else \
        echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1; \
    fi \
    && ( [ -s /cache/deno-v2-7-9 ] || ( wget -q -O /cache/deno-v2-7-9.zip "$DENO_URL" \
        && unzip -o /cache/deno-v2-7-9.zip deno -d /cache \
        && mv /cache/deno /cache/deno-v2-7-9 \
        && rm /cache/deno-v2-7-9.zip ) ) \
    && cp /cache/deno-v2-7-9 /out/deno \
    && chmod +x /out/deno

# BtbN rolling "latest" builds; the tarball unpacks to
# ffmpeg-n8.1-latest-<arch>-gpl-8.1/bin/{ffmpeg,ffprobe,ffplay}.
RUN --mount=type=cache,id=ffmpeg-n8-1-$TARGETARCH,target=/cache \
    if [ "$TARGETARCH" = "amd64" ]; then \
        FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linuxarm64-gpl-8.1.tar.xz"; \
    else \
        echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1; \
    fi \
    && ( [ -s /cache/ffmpeg-n8.1.tar.xz ] || wget -q -O /cache/ffmpeg-n8.1.tar.xz "$FFMPEG_URL" ) \
    && tar -xJf /cache/ffmpeg-n8.1.tar.xz --strip-components=2 -C /out \
        --wildcards "*/bin/ffmpeg" "*/bin/ffprobe"

# ── Next.js web app ────────────────────────────────────────────────────────────
FROM base AS web
# ffmpeg/ffprobe are shelled out to by the upload finalize hook; same static
# builds as the bot so both containers run identical ffmpeg versions.
COPY --from=bot-tools /out/ffmpeg /out/ffprobe /usr/local/bin/

ENV NODE_ENV=production
RUN groupadd -g 1001 nodejs && useradd -m -u 1001 -g nodejs nextjs

WORKDIR /app
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Migration .sql files are read at runtime (instrumentation.ts); standalone
# file tracing doesn't pick them up, so copy them to the default MIGRATIONS_DIR
# location (cwd-relative src/db/migrations).
COPY --from=builder --chown=nextjs:nodejs /app/src/db/migrations ./src/db/migrations

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["bun", "server.js"]

# ── Discord bot ────────────────────────────────────────────────────────────────
# Separate process/container sharing the SQLite DB and storage mount with the
# app. No build step: Bun runs the TypeScript directly (tsconfig.json is
# needed at runtime for the @/* path aliases).
FROM base AS bot
ENV NODE_ENV=production
RUN groupadd -g 1001 nodejs && useradd -m -u 1001 -g nodejs nextjs
# deno/ffmpeg/ffprobe are fixed at build time and stay root-owned in the system
# path. yt-dlp self-updates at runtime (boot + on download failure), and its
# --update replaces the binary in place — which needs write on the *directory*,
# not just the file — so it lives in a nextjs-owned dir put ahead on PATH.
ENV YTDLP_DIR=/home/nextjs/bin
ENV PATH="/home/nextjs/bin:${PATH}"
COPY --from=bot-tools /out/deno /out/ffmpeg /out/ffprobe /usr/local/bin/
RUN mkdir -p "$YTDLP_DIR"
COPY --from=bot-tools --chown=nextjs:nodejs /out/yt-dlp "$YTDLP_DIR/yt-dlp"
RUN chown nextjs:nodejs "$YTDLP_DIR"

WORKDIR /app
ARG TARGETARCH
COPY package.json bun.lock ./
RUN --mount=type=cache,id=bun-$TARGETARCH,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src

USER nextjs
CMD ["bun", "src/bot/index.ts"]
