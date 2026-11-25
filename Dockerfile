# syntax=docker/dockerfile:1
#
# Forklift as a container: `forklift watch` over the forks in $FORKLIFT_REPOS.
# The same image runs either half of a sync (see deploy/compose.yaml).
#
# The image carries git, the GitHub CLI, Node with npm and pnpm, and the
# Claude Code CLI. A fork whose `regenerate` or `verify` commands need
# another toolchain should build its own image FROM this one.

ARG NODE_VERSION=26
ARG PNPM_VERSION=12.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
WORKDIR /src
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm bundle

FROM node:${NODE_VERSION}-bookworm-slim
ARG PNPM_VERSION
ARG CLAUDE_CODE_VERSION=2.1.332

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

COPY --from=build /src/dist/forklift.cjs /usr/local/lib/forklift.cjs
COPY deploy/entrypoint.sh /usr/local/bin/forklift-entrypoint
RUN printf '#!/bin/sh\nexec node /usr/local/lib/forklift.cjs "$@"\n' > /usr/local/bin/forklift \
 && chmod 0755 /usr/local/bin/forklift /usr/local/bin/forklift-entrypoint \
 && install -d -o node -g node /data

# Everything Forklift writes lives under /data: clones, its worktrees, the
# resolutions it has recorded, and the home directory of the tools it runs.
# The rest of the filesystem can be mounted read-only.
ENV FORKLIFT_HOME=/data \
    HOME=/data/home \
    DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production
VOLUME /data
USER node
WORKDIR /data
ENTRYPOINT ["forklift-entrypoint"]
CMD ["watch"]
