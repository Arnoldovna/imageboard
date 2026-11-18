# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/web/Dockerfile .
# Base images are pinned by digest (conventions §9); Dependabot (docker ecosystem) proposes updates.

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global pnpm@10.34.9
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --ignore-scripts --filter "@app/web..."
RUN pnpm --filter "@app/web..." run build

# Unprivileged nginx (uid 101, listens on 8080). Serves the SPA and proxies /api to the api service.
# The image's entrypoint renders /etc/nginx/templates/*.template with envsubst into /etc/nginx/conf.d/ at start.
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e AS runtime
# Keep API_MAX_BODY_SIZE slightly above UPLOAD_MAX_BYTES so the API, not nginx, answers 413 (ADR 0013).
# CSP_IMG_SRC_EXTRA: extra img-src origins (a CDN later, ADR 0019); empty = same origin only.
# TRUSTED_PROXY_CIDR: address range of a TLS-terminating load balancer whose X-Forwarded-Proto nginx keeps (ADR 0019).
# The default 0.0.0.0/32 (the unspecified address) is never the peer of a connection, so nothing is trusted and nginx
# sends its own scheme. (255.255.255.255 would be clearer, but nginx's geo module rejects it.)
ENV API_MAX_BODY_SIZE=6m \
    CSP_IMG_SRC_EXTRA="" \
    TRUSTED_PROXY_CIDR=0.0.0.0/32
# Only substitute our own variables; nginx's $uri, $host, ... stay untouched.
ENV NGINX_ENVSUBST_FILTER="^(API_MAX_BODY_SIZE|CSP_IMG_SRC_EXTRA|TRUSTED_PROXY_CIDR)$"
COPY apps/web/templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
