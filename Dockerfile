# Sweatshop v2 — API + worker manager + web dashboard in one container.
# Workers are spawned as child processes from agents/generator (STORAGE=pg).
FROM node:22-slim

WORKDIR /app

# deps first (layer cache) — sharp pulls its linux binary during npm ci
COPY agents/generator/package*.json agents/generator/
RUN cd agents/generator && npm ci
COPY server/package*.json server/
RUN cd server && npm ci

COPY agents/generator agents/generator
COPY server server
COPY db db
COPY renderer renderer
COPY web web

ENV NODE_ENV=production \
    PORT=8787 \
    STORAGE=pg \
    SWEATSHOP_DATA_DIR=/data

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "--import", "tsx", "src/index.ts"]
