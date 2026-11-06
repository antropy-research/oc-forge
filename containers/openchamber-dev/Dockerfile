# syntax=docker/dockerfile:1
# OpenCode and OpenChamber, each built from its vendors/ submodule at the commit vendors.json pins,
# for extension development; the GitHub CLI the Planner reads GitHub with and its agents open pull
# requests with; and Bun for the SDK's guest bundler (`bunx openchamber-guest-bundle`). The build
# context is the repository root (compose.yaml, build.sh) and Dockerfile.dockerignore keeps it to
# what the stages copy. No vendor version is named here: the stages build what the pins check out,
# and the tools they need follow the vendors (Bun as a vendor's packageManager says).
ARG NODE_IMAGE=node:26.12.0-trixie-slim

# Every stage starts from the final image's Debian and packages, so what is compiled runs there.
# git and ssh for projects and worktrees; python3, make and g++ for native modules that ship no
# prebuilt binary.
FROM ${NODE_IMAGE} AS toolchain
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git less openssh-client python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# OpenCode with oc-forge's adapters, built by scripts/build.py as the releases are: upstream's
# packages/cli/script/build.ts with scripts/build-preload.ts preloaded.
FROM toolchain AS opencode
WORKDIR /oc-forge
COPY vendors/opencode/package.json vendors/opencode/
RUN npm install -g --allow-scripts=bun \
    "bun@$(node -p 'require("./vendors/opencode/package.json").packageManager.replace(/^bun@/, "")')"
COPY vendors/opencode vendors/opencode
# OpenCode's desktop app's Electron; the CLI does not use it.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# The install build.py starts with, here ahead of the adapters so that changing one does not reinstall.
RUN cd vendors/opencode && bun install --frozen-lockfile --os="*" --cpu="*"
COPY upstream.json ./
COPY adapters/opencode adapters/opencode
COPY scripts/build.py scripts/build-preload.ts scripts/adapter-plugin.ts scripts/
# The copy has no git metadata, so build.py skips its pristine check (build.sh checks the checkout
# instead); it still checks that the binary has the adapted location TTL and that it starts.
RUN case "$(dpkg --print-architecture)" in \
      amd64) target=linux-x64 ;; arm64) target=linux-arm64 ;; \
      *) echo "no OpenCode build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
  && python3 scripts/build.py "opencode-$target" \
  && install -D -m 0755 "build/opencode-$target/cli-$target/bin/opencode" /out/opencode

# OpenChamber's web package and its SDK, packed as npm would publish them.
FROM toolchain AS openchamber
WORKDIR /oc-forge
COPY vendors/openchamber/package.json vendors/openchamber/
RUN npm install -g --allow-scripts=bun \
    "bun@$(node -p 'require("./vendors/openchamber/package.json").packageManager.replace(/^bun@/, "")')"
COPY vendors/openchamber vendors/openchamber
WORKDIR /oc-forge/vendors/openchamber
# OPENCHAMBER_BUILD builds the web package and leaves its tarball in /out; it runs here in
# vendors/openchamber after the install. By default it is oc-forge's adapted build
# (scripts/build-openchamber.py: the adapters applied to a copy of the vendor's sources, checked,
# type-checked and packed; README.md); upstream's own build is the one-line alternative there.
COPY adapters/openchamber /oc-forge/adapters/openchamber
COPY scripts/build-openchamber.py /oc-forge/scripts/build-openchamber.py
ARG OPENCHAMBER_BUILD="cd /oc-forge && python3 scripts/build-openchamber.py --source vendors/openchamber && mkdir -p /out && cp dist/openchamber-web-*.tgz /out/"
# The root postinstall builds the SDK and the built-in extensions (the desktop app's Electron is not
# needed). One step: the install, the build and the web package's prepack each rebuild
# packages/web/server/built-in-extensions by renaming the last one aside, and overlayfs refuses that
# rename (EXDEV) for a folder an earlier layer made.
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 bun install --frozen-lockfile \
  && sh -c "$OPENCHAMBER_BUILD" \
  && bun pm pack --cwd packages/sdk --destination /out

FROM toolchain
ARG GH_VERSION=2.103.2

COPY --from=openchamber /usr/local/lib/node_modules/bun/bin/bun.exe /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx

# OpenCode as its npm package installs it: `opencode` and `opencode2`.
COPY --from=opencode /out/opencode /usr/local/bin/opencode
RUN ln -s opencode /usr/local/bin/opencode2

# OpenChamber from its packed tarballs, the SDK beside the web package that depends on it. npm 11
# skips install scripts unless they are allowed by name: node-pty's builds when no prebuild matches.
RUN --mount=type=bind,from=openchamber,source=/out,target=/tmp/openchamber \
    npm install -g --allow-scripts=node-pty /tmp/openchamber/*.tgz \
  && npm cache clean --force

# GitHub CLI: `gh auth login` once in the container (the home volume keeps it).
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64|arm64) ;; *) echo "no gh for $arch" >&2; exit 1 ;; esac \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o /tmp/gh.tar.gz \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}"

# The Cloak Browser extension (extensions/cloak-browser) runs CloakBrowser, a Chromium, headless in this
# container: the libraries its `chrome` links (none are in the slim image), and fonts for Latin, CJK,
# the other scripts Noto covers (Arabic, Hebrew, Devanagari, Thai, …) and emoji (it has none either).
# The browser itself is downloaded by the extension on first use.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 \
    libdbus-1-3 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    fonts-liberation fonts-noto-cjk fonts-noto-color-emoji fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

# The dev defaults, applied once OpenChamber answers: Cloak Browser installed, approved and the Browser
# provider (OC_DEV_BROWSER_PROVIDER in compose.yaml), so the agent's browser actions run on CloakBrowser.
# Into a folder that exists: a folder COPY makes would get the file's mode, which the `node` user cannot enter.
COPY --chmod=0644 containers/openchamber-dev/dev-defaults.mjs /usr/local/lib/oc-forge-dev-defaults.mjs

ENV LANG=C.UTF-8
# The image's `node` user is UID 1000, so files written into the bind-mounted
# extensions folder stay owned by the host user.
USER node
WORKDIR /home/node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1
# OpenChamber in the foreground, and the dev defaults beside it; the subshell leaves the helper to init (compose's
# `init: true`), which reaps it when it is done.
CMD ["sh", "-c", "(node /usr/local/lib/oc-forge-dev-defaults.mjs &); exec openchamber serve --foreground --port 3000 --host 0.0.0.0"]
