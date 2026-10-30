# syntax=docker/dockerfile:1
# OpenCode, OpenChamber and VS Code Server for the web, each built from its vendors/ submodule at the
# commit vendors.json pins, for extension development; the GitHub CLI the Planner reads GitHub with
# and its agents open pull requests with; and Bun for the SDK's guest bundler
# (`bunx openchamber-guest-bundle`). The build context is the repository root (compose.yaml, build.sh)
# and Dockerfile.dockerignore keeps it to what the stages copy. No vendor version is named here: the
# stages build what the pins check out, and the tools they need follow the vendors (Bun as a vendor's
# packageManager says, VS Code's Node as its .nvmrc says).
ARG NODE_IMAGE=node:26.12.0-trixie-slim

# Every stage starts from the final image's Debian and packages, so what is compiled runs there.
# git and ssh for projects and worktrees; python3, make and g++ for native modules that ship no
# prebuilt binary.
FROM ${NODE_IMAGE} AS toolchain
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git less openssh-client python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# The VS Code commit vendors.json pins, on its own, so that another pin moving does not rebuild VS Code.
FROM ${NODE_IMAGE} AS pins
COPY vendors.json /tmp/vendors.json
RUN node -p 'require("/tmp/vendors.json").vscode.commit' > /vscode-commit

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

# VS Code Server for the web, built the way Microsoft's Linux pipeline builds its own.
FROM toolchain AS vscode
# The native build dependencies VS Code's Linux build installs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config libxkbfile-dev libkrb5-dev xz-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /oc-forge/vendors/vscode
COPY vendors/vscode/.nvmrc ./
# Node as .nvmrc says, ahead of the image's own Node; the server bundles the Node remote/.npmrc names.
RUN version="$(cat .nvmrc)" \
  && case "$(dpkg --print-architecture)" in \
      amd64) arch=x64 ;; arm64) arch=arm64 ;; \
      *) echo "no Node for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
  && name="node-v$version-linux-$arch" \
  && curl -fsSLO "https://nodejs.org/dist/v$version/$name.tar.xz" \
  && curl -fsSL "https://nodejs.org/dist/v$version/SHASUMS256.txt" | grep " $name.tar.xz\$" | sha256sum -c - \
  && mkdir -p /opt/node \
  && tar -xJf "$name.tar.xz" -C /opt/node --strip-components=1 \
  && rm "$name.tar.xz"
ENV PATH=/opt/node/bin:$PATH
COPY vendors/vscode ./
# As in VS Code's CI: no Electron, browsers or ONNX Runtime downloads for a server, and no Foundry
# Local native install (on-device dictation, from Microsoft's private feed): FOUNDRY_LOCAL_SKIP_INSTALL,
# or on releases older than that variable, their disableFoundryLocalInstall.ts. `npm ci` gets five
# tries, as there: native modules building at once can race on node-gyp's header cache. The
# postinstall runs `git config`, which needs a repository, and the copy has no git metadata.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip \
  FOUNDRY_LOCAL_SKIP_INSTALL=1
RUN git init -q \
  && if [ -f build/azure-pipelines/common/disableFoundryLocalInstall.ts ]; then \
       node build/azure-pipelines/common/disableFoundryLocalInstall.ts; \
     fi \
  && for try in 1 2 3 4 5; do \
       npm ci && break; \
       [ "$try" -lt 5 ] || { echo "npm ci failed five times" >&2; exit 1; }; \
       echo "npm ci failed ($try of 5), trying again" >&2; \
     done
# The packaging VS Code leaves to whoever distributes its OSS build: the commit, which
# build/lib/getVersion.ts reads from BUILD_SOURCEVERSION as the copy has no git, and
# vscode-product.json merged into product.json (quality, Open VSX as the extension gallery) before
# the build, which inlines product.json. VSCODE_QUALITY, the same quality, is the pipeline variable
# the built-in Copilot extension's build wants once BUILD_SOURCEVERSION is set.
COPY --from=pins /vscode-commit /tmp/vscode-commit
COPY containers/openchamber-dev/vscode-product.json /tmp/vscode-product.json
# Then the steps of build/azure-pipelines/linux/steps/product-build-linux-compile.yml: `core-ci`, the
# built-in Copilot extension as the VSIX build/azure-pipelines/product-copilot.yml packs (`npm run build`,
# `vsce package`), unpacked into .build/extensions/copilot as common/downloadCopilotVsix.ts does
# (with each file's mode, so its executables stay executable), and
# `vscode-reh-web-linux-<arch>-min-ci`. The one-task local build, `vscode-reh-web-linux-<arch>-min`,
# packs Copilot without the node_modules/@github/copilot/sdk its last step requires, and fails.
RUN node -e 'const fs = require("fs"); \
      const product = JSON.parse(fs.readFileSync("product.json", "utf8")); \
      Object.assign(product, JSON.parse(fs.readFileSync("/tmp/vscode-product.json", "utf8"))); \
      fs.writeFileSync("product.json", JSON.stringify(product, null, "\t") + "\n")' \
  && case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; esac \
  && export BUILD_SOURCEVERSION="$(cat /tmp/vscode-commit)" \
    VSCODE_QUALITY="$(node -p 'require("./product.json").quality')" \
  && npm run gulp core-ci \
  && (cd extensions/copilot && npm run build \
      && npx vsce package --allow-package-secrets sendgrid -o /tmp/copilot-chat.vsix) \
  && python3 -c 'import os, sys, zipfile; \
      vsix = zipfile.ZipFile(sys.argv[1]); \
      [os.chmod(vsix.extract(entry, sys.argv[2]), (entry.external_attr >> 16) & 0o777 or 0o644) \
       for entry in vsix.infolist() if entry.filename.startswith("extension/") and not entry.is_dir()]' \
      /tmp/copilot-chat.vsix /tmp/copilot-vsix \
  && mkdir -p .build/extensions/copilot \
  && cp -a /tmp/copilot-vsix/extension/. .build/extensions/copilot/ \
  && rm -rf /tmp/copilot-chat.vsix /tmp/copilot-vsix \
  && npm run gulp "vscode-reh-web-linux-$arch-min-ci" \
  && mv "../vscode-reh-web-linux-$arch" /opt/vscode-server

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

# The VS Code Server under /opt/vscode-server; `vscode-server` starts it (see the `vscode` service).
COPY --from=vscode /opt/vscode-server /opt/vscode-server
RUN ln -s "/opt/vscode-server/bin/$(node -p 'require("/opt/vscode-server/product.json").serverApplicationName')" \
    /usr/local/bin/vscode-server

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
