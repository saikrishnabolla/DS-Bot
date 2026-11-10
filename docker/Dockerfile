# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /app
COPY ds-bot/ ./ds-bot/
RUN cd ds-bot && npm ci --omit=dev --no-fund --no-audit

COPY app/ ./app/
RUN cd app \
    && npm ci --no-fund --no-audit \
    && npm run build

FROM ${NODE_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash build-essential ca-certificates curl ffmpeg git gosu jq less procps \
        python3 python3-pip python3-venv ripgrep unzip zip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/ds-bot /app/ds-bot
COPY --from=build /app/app/ui/dist /app/app/ui/dist
COPY docker/host.mjs /app/docker/host.mjs
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/cue-entrypoint

ENV CUE_DATA_DIR=/data \
    CUE_WORKSPACE=/workspace \
    CUE_HOST=0.0.0.0 \
    CUE_PORT=3080 \
    CUE_PUBLIC_ORIGIN=http://localhost:3080

WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/cue-entrypoint"]

LABEL org.opencontainers.image.title="Cue" \
      org.opencontainers.image.description="Cue on Pi Durable" \
      org.opencontainers.image.source="https://github.com/Fei2411/DS-Bot" \
      org.opencontainers.image.licenses="Apache-2.0"
