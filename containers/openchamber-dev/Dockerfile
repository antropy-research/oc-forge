# syntax=docker/dockerfile:1
# OpenChamber and OpenCode from npm for extension development, pinned to the
# pair the host runs, plus Bun for the SDK's guest bundler
# (`bunx openchamber-guest-bundle`).
ARG BUN_IMAGE=oven/bun:1.4.3
ARG NODE_IMAGE=node:26.12.0-trixie-slim

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE}
ARG OPENCHAMBER_VERSION=2.4.0
ARG OPENCODE_VERSION=2.0.32

# git and ssh for projects and worktrees; python3, make and g++ for native
# modules that ship no prebuilt binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git less openssh-client python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx

# npm 11 skips install scripts unless they are allowed by name: OpenCode's picks
# the binary for this CPU, node-pty's builds when no prebuild matches.
RUN npm install -g --allow-scripts=@opencode/cli,node-pty \
    "@openchamber/web@${OPENCHAMBER_VERSION}" "@opencode/cli@${OPENCODE_VERSION}" \
  && npm cache clean --force

ENV LANG=C.UTF-8
# The image's `node` user is UID 1000, so files written into the bind-mounted
# extensions folder stay owned by the host user.
USER node
WORKDIR /home/node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["openchamber", "serve", "--foreground", "--port", "3000", "--host", "0.0.0.0"]
