# SolVamos Studio — Cloud Run image
# Fail-closed: prisma client MUST be generated into the runtime image
# (omit=dev leaves @prisma/client without engines → crash before listen on :8080).

FROM node:20-slim AS build
WORKDIR /app

# OpenSSL for Prisma engines on slim
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci || npm install
# Generate before bundle so CI/local catch missing schema early
RUN npx prisma generate
COPY . .
RUN npm run build \
  && test -f dist/server.cjs \
  && test -d node_modules/.prisma/client

FROM ubuntu:24.04
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DEBIAN_FRONTEND=noninteractive

ARG PAY_VERSION=1.0.23
ARG NODE_VERSION=22.14.0
ENV PAY_PKG_VERSION=${PAY_VERSION}

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip xz-utils openssl \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
  && npm install --global "@solana/pay@${PAY_VERSION}" \
  && mkdir -p /tmp/pay-home/.npm /tmp/solvamos-data \
  && HOME=/tmp/pay-home npm_config_cache=/tmp/pay-home/.npm \
       npx --yes --package "@solana/pay@${PAY_VERSION}" pay --version || true \
  && printf '%s\n' '#!/bin/sh' 'exec npx --yes --package "@solana/pay@'"${PAY_VERSION}"'" pay "$@"' > /usr/local/bin/pay \
  && chmod +x /usr/local/bin/pay \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev || npm install --omit=dev \
  && npx prisma generate \
  && test -d node_modules/.prisma/client

COPY --from=build /app/dist ./dist

ENV DATA_DIR=/tmp/solvamos-data
ENV HOME=/tmp/pay-home
ENV npm_config_cache=/tmp/pay-home/.npm
ENV PAY_CLI_PATH=/usr/local/bin/pay
EXPOSE 8080

# Apply pending Prisma migrations before boot (fail-closed: a failed migration
# keeps the previous Cloud Run revision serving instead of running mismatched code).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.cjs"]
