FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub Copilot CLI v1.0.3 (standalone coding agent).
# Tarball layout: copilot-linux-x64.tar.gz contains a single 'copilot' binary.
ARG COPILOT_VERSION=v1.0.3
RUN set -eux; \
    ARCH=$(dpkg --print-architecture); \
    case "$ARCH" in \
      amd64) GOARCH="x64" ;; \
      arm64) GOARCH="arm64" ;; \
      *) GOARCH="x64" ;; \
    esac; \
    TARBALL="copilot-linux-${GOARCH}.tar.gz"; \
    curl -fsSL \
      "https://github.com/github/copilot-cli/releases/download/${COPILOT_VERSION}/${TARBALL}" \
      -o /tmp/copilot.tar.gz; \
    tar -xzf /tmp/copilot.tar.gz -C /usr/local/bin/; \
    rm /tmp/copilot.tar.gz; \
    chmod +x /usr/local/bin/copilot; \
    copilot --version || true

WORKDIR /app
COPY package.json package-lock.json ./
COPY src ./src

# tsx is a production dependency; --omit=dev skips type-checking tools not needed at runtime.
RUN npm ci --omit=dev

CMD ["node", "--import", "tsx", "src/workers/run_task.ts"]
