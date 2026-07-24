# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────────────────
# Gasless relayer backend — multi-stage image.
#
# The build context is the REPO ROOT (not backend/): the service reads the
# generated chains/deployed.json at startup, and that file lives outside backend/.
#
#   docker build -f backend/Dockerfile -t gasless .
# ──────────────────────────────────────────────────────────────────────────

# ---- Stage 1: compile the TypeScript sources ----
FROM node:20-alpine AS builder
WORKDIR /app

# Toolchain for optional native addons (bufferutil / utf-8-validate) that fall
# back to source when no musl prebuild is available.
RUN apk add --no-cache python3 make g++

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
RUN npm run build

# ---- Stage 2: production-only node_modules ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 3: minimal runtime image ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    SERVICE_HOST=0.0.0.0 \
    SERVICE_PORT=3100

# Compiled app + prod deps + the generated delegate registry the service loads
# on boot (chains/deployed.json is optional; the chain registry itself lives in
# config.yaml). Run as the built-in non-root `node` user.
COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist         ./dist
COPY --chown=node:node backend/package.json ./package.json
COPY --chown=node:node chains               ./chains

# Default config. main.ts reads ./config.yaml (GASLESS_CONFIG / --config override
# it); secrets are injected separately via /run/secrets/gasless_env and override
# any value here. Mount your own config.yaml over this to change non-secret
# defaults without rebuilding.
COPY --chown=node:node backend/config.yaml ./config.yaml

USER node
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${SERVICE_PORT}/health" || exit 1

CMD ["node", "dist/main.js"]
