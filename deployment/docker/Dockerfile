FROM node:24-trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY . .
RUN npm ci --no-audit --no-fund && npm run package:production
RUN mkdir /package && tar -xzf artifacts/squadxo-*.tar.gz --strip-components=1 -C /package
WORKDIR /package
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-trixie-slim
WORKDIR /app
COPY --from=build --chown=node:node /package/ ./
USER node
ENTRYPOINT ["node", "--unhandled-rejections=warn", "index.js"]
CMD ["--config", "config.json"]
