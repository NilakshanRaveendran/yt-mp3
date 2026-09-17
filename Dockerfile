FROM node:24-bookworm-slim AS binaries
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/ scripts/
RUN node scripts/install-binaries.js

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=binaries /app/vendor/bin/ /app/vendor/bin/
COPY server.js ./
COPY lib/ lib/
COPY public/ public/
ENV NODE_ENV=production PORT=10000 YTDLP_PATH=/app/vendor/bin/yt-dlp FFMPEG_DIR=/app/vendor/bin
USER node
EXPOSE 10000
CMD ["node", "server.js"]
