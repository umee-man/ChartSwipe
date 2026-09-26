# ChartSwipe web — Nuxt 3 SPA served by the Nitro node-server (arch §11).
# Build:  docker build -t chartswipe-web ./web
# Run:    docker run --rm -p 3000:3000 chartswipe-web

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first for layer caching. Scripts are skipped here: `postinstall` runs `nuxt prepare`,
# which needs the sources that are only copied in the next step (`nuxi build` prepares anyway).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
ENV NODE_ENV=production
RUN npx nuxi build

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app

ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

# .output is self-contained (server bundle + its own node_modules + public assets).
COPY --from=build --chown=node:node /app/.output ./.output

# Unprivileged user shipped with the official image.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", ".output/server/index.mjs"]
