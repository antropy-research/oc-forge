# syntax=docker/dockerfile:1
# OpenChamber and OpenCode from npm for extension development: the latest
# OpenChamber release, which extensions are installed on, with an OpenCode it
# supports (2.5.2 bundles 2.1.4); VS Code Server for the web; the GitHub CLI the
# Planner reads GitHub with and its agents open pull requests with; and Bun for
# the SDK's guest bundler (`bunx openchamber-guest-bundle`).
ARG BUN_IMAGE=oven/bun:1.4.4
ARG NODE_IMAGE=node:26.12.0-trixie-slim

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE}
ARG OPENCHAMBER_VERSION=2.5.2
ARG OPENCODE_VERSION=2.1.4
# VS Code release, as `vendors.json` pins it; its server for the web runs in the `vscode` service.
ARG VSCODE_VERSION=1.140.0
ARG GH_VERSION=2.103.2

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

# Microsoft's VS Code Server for the web, the same build VS Code ${VSCODE_VERSION} ships,
# under /opt/vscode-server; `vscode-server` starts it (see the `vscode` service).
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "no VS Code Server for $arch" >&2; exit 1 ;; esac \
  && curl -fsSL "https://update.code.visualstudio.com/${VSCODE_VERSION}/server-linux-${arch}-web/stable" -o /tmp/vscode-server.tar.gz \
  && mkdir -p /opt/vscode-server \
  && tar -xzf /tmp/vscode-server.tar.gz -C /opt/vscode-server --strip-components=1 \
  && rm /tmp/vscode-server.tar.gz \
  && ln -s /opt/vscode-server/bin/code-server /usr/local/bin/vscode-server

# GitHub CLI: `gh auth login` once in the container (the home volume keeps it).
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64|arm64) ;; *) echo "no gh for $arch" >&2; exit 1 ;; esac \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o /tmp/gh.tar.gz \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}"

ENV LANG=C.UTF-8
# The image's `node` user is UID 1000, so files written into the bind-mounted
# extensions folder stay owned by the host user.
USER node
WORKDIR /home/node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["openchamber", "serve", "--foreground", "--port", "3000", "--host", "0.0.0.0"]
