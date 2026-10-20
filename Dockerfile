FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/helpdesk.db \
    TRUST_PROXY=1
COPY package.json server.js ./
COPY public ./public
COPY scripts ./scripts
COPY docker-entrypoint.sh ./
RUN apk add --no-cache su-exec && mkdir -p /data && chown -R node:node /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
CMD ["node", "server.js"]
