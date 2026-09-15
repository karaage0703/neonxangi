FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG XANGI_COMMIT=726ecfc7f1e6d9bf7d553c203cff0a7b0a43b84e
ARG CODEX_VERSION=0.154.0
ARG CLAUDE_CODE_VERSION=2.1.270
ARG COPILOT_VERSION=1.0.83

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git iproute2 ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/neonxangi
COPY . /opt/neonxangi
COPY .neonxangi-workspace-seed/ /workspace/
RUN npm ci \
    && npm run build \
    && npm prune --omit=dev \
    && git clone https://github.com/karaage0703/xangi.git /opt/xangi \
    && git -C /opt/xangi checkout "${XANGI_COMMIT}" \
    && npm --prefix /opt/xangi ci \
    && npm --prefix /opt/xangi run build \
    && npm install --global \
      "@openai/codex@${CODEX_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@github/copilot@${COPILOT_VERSION}" \
    && npm cache clean --force \
    && rm -rf /opt/neonxangi/.neonxangi-workspace-seed \
    && install -D -m 0644 /opt/neonxangi/blueprint/codex-requirements.toml /etc/codex/requirements.toml \
    && chmod 0755 /opt/neonxangi/blueprint/start-workload.sh \
    && mkdir -p /var/lib/xangi/logs /var/lib/neonxangi /var/log/neonxangi /workspace \
    && rm -rf /workspace/logs \
    && ln -s /var/lib/xangi/logs /workspace/logs \
    && chown -R node:node /var/lib/xangi /var/lib/neonxangi /var/log/neonxangi /workspace

WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
