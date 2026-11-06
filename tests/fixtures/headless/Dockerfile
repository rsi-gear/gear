# Runtime-only test image. No credentials, project files or model endpoints.
ARG BASE_IMAGE=node:22.23.0-bookworm-slim
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install --no-install-recommends -y python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/gear-test-runtime
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
ENV PATH="/opt/gear-test-runtime/node_modules/.bin:${PATH}"
