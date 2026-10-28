"""Rebuild one OpenCode CLI target with our adapters into dist/<target>.tar.gz.

Usage: python scripts/build.py <target>, where target is one of TARGETS.

Runs upstream's unmodified packages/cli/script/build.ts with scripts/build-preload.ts
preloaded, then checks that the binary contains the adapted code, that the
upstream submodule was left untouched, and (when the host can run it) that the
binary starts.
"""

import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "vendors/opencode"
TARGETS = {
    "opencode-linux-x64": ("linux", "x86_64"),
    "opencode-darwin-arm64": ("darwin", "arm64"),
}
# Present only when the location-ttl adapter was compiled in.
ADAPTED = b"OPENCODE_LOCATION_TTL"
ORIGINAL = b'timeToLive??"60 minutes"'


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else ""
    if target not in TARGETS:
        sys.exit(f"usage: build.py <{'|'.join(TARGETS)}>")
    require_clean("before build")
    version = json.loads((ROOT / "upstream.json").read_text())["tag"].removeprefix("v")
    outdir = ROOT / "build" / target
    # Install every platform's native packages from the lockfile up front, so
    # upstream's build does not run its own `bun install`, which rewrites package.json.
    subprocess.run(["bun", "install", "--frozen-lockfile", "--os=*", "--cpu=*"], cwd=UPSTREAM, check=True)
    subprocess.run(
        [
            "bun",
            f"--preload={ROOT / 'scripts/build-preload.ts'}",
            "script/build.ts",
            f"--target={target}",
            f"--outdir={outdir}",
            "--skip-install",
        ],
        cwd=UPSTREAM / "packages/cli",
        check=True,
        # Match the official release build: stable channel and upstream version. The
        # compile runtime is mise's official Bun, so BUN_COMPILE_RELEASE is not set:
        # upstream resolves it through the unauthenticated GitHub API, which is rate
        # limited on shared CI runners. Since v2.2.0 upstream takes the target from
        # OPENCODE_TARGET (without the "opencode-" prefix) and ignores --target=, so
        # without it every platform is built, the musl ones included.
        env={
            **os.environ,
            "OPENCODE_VERSION": version,
            "OPENCODE_CHANNEL": "latest",
            "OPENCODE_TARGET": target.removeprefix("opencode-"),
        },
    )
    require_clean("after build")
    binary = outdir / target.replace("opencode", "cli") / "bin/opencode"
    contents = binary.read_bytes()
    if ADAPTED not in contents or ORIGINAL in contents:
        sys.exit(f"{binary} does not contain the adapted location TTL")
    if sys.platform == "darwin":
        subprocess.run(["codesign", "--force", "--sign", "-", str(binary)], check=True)
    if TARGETS[target] == (sys.platform, platform.machine()):
        reported = subprocess.check_output([str(binary), "--version"], text=True).strip()
        if version not in reported:
            sys.exit(f"built binary reports {reported!r}, expected {version}")
        print(f"smoke test passed: {reported}")
    archive = ROOT / "dist" / f"{target}.tar.gz"
    archive.parent.mkdir(exist_ok=True)
    with tarfile.open(archive, "w:gz") as file:
        file.add(binary, arcname="opencode")
    print(f"wrote {archive}")


def require_clean(when: str) -> None:
    status = subprocess.check_output(["git", "-C", str(UPSTREAM), "status", "--porcelain"], text=True)
    if status:
        sys.exit(f"upstream submodule has changes {when}; it must stay pristine:\n{status}")


if __name__ == "__main__":
    main()
