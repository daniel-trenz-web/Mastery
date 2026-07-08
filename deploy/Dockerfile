# WERKOS — Produktions-Image (Node 22, zero dependencies → kein npm install nötig)
FROM node:22-alpine

RUN addgroup -S werkos && adduser -S werkos -G werkos
WORKDIR /app

COPY server/ ./server/
COPY web/ ./web/

ENV NODE_ENV=production \
    PORT=4000 \
    WERKOS_DATA_DIR=/data \
    WERKOS_WEB_DIR=/app/web

RUN mkdir -p /data && chown -R werkos:werkos /data /app
USER werkos

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/ >/dev/null || exit 1

CMD ["node", "server/src/index.js"]
