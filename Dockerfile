# FBMS POS. The only npm dependency is the libSQL client (used when TURSO_DATABASE_URL is set).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/fbms.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
