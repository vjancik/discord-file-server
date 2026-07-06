# syntax=docker/dockerfile:1
FROM oven/bun:1.3-alpine AS base

# ── Build ──────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ── Runtime ────────────────────────────────────────────────────────────────────
FROM base AS runner
# ffmpeg/ffprobe are shelled out to by the upload finalize hook
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

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
