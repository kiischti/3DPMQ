FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc

FROM node:22-alpine
LABEL org.opencontainers.image.title="3DPMQ" \
      org.opencontainers.image.description="3D Printer Makerspace Queue: validation, approval and queue for Prusa printers (PrusaLink)" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
# /data must be writable by the unprivileged "node" user; a new named volume copies this ownership
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/api/config || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
