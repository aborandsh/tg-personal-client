# Railway runs from repo root
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# tdl's native addon loads libtdjson via dlopen at runtime — no system libs needed.
# python3 + zipfile: session backup fallback (no zip binary in slim images)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# Volume is attached via Railway dashboard/API at /data (VOLUME directive unsupported)

EXPOSE 3000
CMD ["node", "src/index.js"]
