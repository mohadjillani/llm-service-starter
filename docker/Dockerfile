# Build stage: compile to JavaScript so the runtime image carries no TypeScript
# toolchain and no dev dependencies.
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage.
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# tini so SIGTERM reaches node rather than being swallowed by PID 1 — without
# it `docker stop` waits out the full timeout and kills the process, which
# looks exactly like a service that does not shut down cleanly.
RUN apk add --no-cache tini curl

COPY package.json package-lock.json ./
# The lockfile's dev entries are irrelevant with --omit=dev, but the scripts
# are not: a postinstall from a dev dependency would still run.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist
# Read at runtime by src/accounting/pricing.ts, resolved relative to dist/.
COPY pricing ./pricing

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
