# Freiraum-Backend mit Web-Oberfläche. Baut für linux/arm64 (Homelab) und linux/amd64; keine
# nativen Abhängigkeiten. Build-Kontext ist das Repo-Wurzelverzeichnis:
#   docker build -f backend/Dockerfile .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN pnpm build && pnpm prune --prod

# Web-Oberfläche (ADR 0007): Vite-Build, der Client-Typen aus openapi/openapi.yaml nutzt.
FROM base AS web-build
WORKDIR /web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
RUN pnpm build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY backend/package.json ./
COPY backend/migrations ./migrations
COPY backend/public ./public
# Liegt neben dist/ und wird ohne WEB_DIST_DIR gefunden (config.ts).
COPY --from=web-build /web/dist ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" > /dev/null || exit 1
CMD ["node", "dist/server.js"]
