# Railway runs from repo root
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# tdl's native addon loads libtdjson via dlopen at runtime — no system libs needed.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# Volume must be mounted at /data (Railway: Service → Volumes → mount path /data)
ENV TDLIB_DIR=/data/tdlib
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "src/index.js"]
