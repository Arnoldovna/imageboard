# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/api/Dockerfile .
# Base images are pinned by digest (conventions §9); Dependabot (docker ecosystem) proposes updates.

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Node 25+ no longer bundles corepack. Install exactly the version in package.json#packageManager.
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# --ignore-scripts skips the root `prepare` (lefthook needs git); no API dependency needs a build script.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --ignore-scripts --filter "@app/api..."
RUN pnpm --filter "@app/api..." run build \
 && pnpm --filter @app/api deploy --prod --ignore-scripts /out \
 && cp -r apps/api/drizzle /out/drizzle

# Distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:ffa8a7545403036c94ec76674b5dbac2d425af2d679147cdf3e30180071487b7 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out ./
USER nonroot
EXPOSE 3000
# The image entrypoint is node; `migrate` runs the same image with CMD ["dist/db/migrate.js"].
CMD ["--enable-source-maps", "dist/server.js"]
