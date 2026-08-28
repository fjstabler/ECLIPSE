# Two stages so the final image doesn't carry the compiler toolchain
# better-sqlite3 needs to build its native binding — only the compiled
# node_modules make it into the runtime image below.
#
# Node 22, not 20: the openai package declares a >=22 engine requirement
# (`npm ci` on Node 20 installs it anyway, just with an EBADENGINE warning —
# it's not enforced — but running N.O.V.A.'s conversational layer on a Node
# version its own SDK says it doesn't support isn't a risk worth taking).
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
# ffmpeg is optional at runtime (ECLIPSE_TRANSCODE=false works without it),
# but without it .mkv and anything else a browser can't open directly won't
# play — so it's in the image by default rather than something you have to
# remember to add.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web
COPY scripts ./scripts

# Fixed inside the container regardless of what .env says — docker-compose.yml
# binds the real host paths to /media/movies and /media/series instead.
ENV ECLIPSE_DATA_DIR=/app/data
EXPOSE 8383

CMD ["node", "server/index.js"]
