"""Build OpenChamber's web package from vendors/openchamber with oc-forge's adapters.

Usage: python scripts/build-openchamber.py [--source DIR] [--check-only] [--keep]

The source is never written to. Its tracked files are copied (git archive of
HEAD) to build/openchamber/<version>/, and everything happens there:

1. every adapter must still apply: each anchor found exactly once (else stop);
2. bun install --frozen-lockfile;
3. the adapters' new files (adapters/openchamber/host, server) are copied in;
4. Vite builds the web package with OpenChamber's own config plus the adapter
   plugin, which rewrites the UI sources in memory as they load;
5. the adapted server sources (they ship unbuilt) are written to the copy and
   the package is packed;
6. the adapted UI sources are written to the copy and type-checked with
   OpenChamber's own `bun check -b`;
7. the package must contain the adapted code, and the source must still be
   pristine; then it is written to dist/openchamber-web-<version>.tgz.

--check-only stops after the type-check (steps 1-3 and 6): no Vite build, no package.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]
ADAPTERS = ROOT / "adapters/openchamber"
CLI = ADAPTERS / "cli.ts"
# Strings only the adapted code contains, in the built UI and in the staged server.
UI_MARKER = b"oc-forge:default-zones"
SERVER_MARKER = "parseOcForgeManifest"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=ROOT / "vendors/openchamber", help="OpenChamber checkout (default: vendors/openchamber)")
    parser.add_argument("--check-only", action="store_true", help="apply the adapters and type-check; build no package")
    parser.add_argument("--keep", action="store_true", help="keep the build tree afterwards")
    args = parser.parse_args()
    source = args.source.resolve()
    if not (source / "packages/web/package.json").is_file():
        sys.exit(f"{source} is not an OpenChamber checkout (no packages/web/package.json); run `git submodule update --init vendors/openchamber`")
    require_clean(source, "before the build")
    require_node()
    version = json.loads((source / "packages/web/package.json").read_text())["version"]
    tree = ROOT / "build/openchamber" / version
    env = build_env()
    started = time.monotonic()

    step(f"copying OpenChamber {version} from {source} to {tree.relative_to(ROOT)}")
    copy_source(source, tree)
    step("checking every adapter still applies")
    bun(env, "run", str(CLI), "verify", str(tree))
    step("installing dependencies")
    bun(env, "install", "--frozen-lockfile", cwd=tree)
    bun(env, "run", str(CLI), "stage", str(tree), "added")
    web = tree / "packages/web"

    package = None
    if not args.check_only:
        step("building the web package; the adapters rewrite UI sources in memory")
        bun(env, "../../scripts/build-builtin-extensions.mjs", cwd=web)
        bun(env, "run", str(CLI), "vite-config", str(tree))
        vite = web / "node_modules/vite/bin/vite.js"
        run(["node", str(vite), "build", "--config", "vite.oc-forge.config.ts"], cwd=web,
            env={**env, "NODE_OPTIONS": "--max-old-space-size=6144"})
        if not any(UI_MARKER in path.read_bytes() for path in (web / "dist/assets").glob("*.js")):
            sys.exit("the built UI does not contain the adapted code")
        step("staging the adapted server sources and packing")
        bun(env, "run", str(CLI), "stage", str(tree), "server")
        package = pack(env, web, version, tree.parent / "pack")
    else:
        bun(env, "run", str(CLI), "stage", str(tree), "server")

    for path in sorted((web / "server").rglob("*.js")):
        if "oc-forge" in path.read_text(errors="ignore"):
            run(["node", "--check", str(path)], cwd=web)
    step("type-checking the adapted UI with OpenChamber's own check")
    bun(env, "run", str(CLI), "stage", str(tree), "ui")
    bun(env, "check", "-b", cwd=web)

    require_clean(source, "after the build")
    if package:
        archive = ROOT / "dist" / f"openchamber-web-{version}.tgz"
        archive.parent.mkdir(exist_ok=True)
        shutil.move(package, archive)
        print(f"wrote {archive.relative_to(ROOT)} ({archive.stat().st_size // 1024} KiB)")
    if not args.keep:
        shutil.rmtree(tree.parent, ignore_errors=True)
    print(f"done in {time.monotonic() - started:.0f}s")


def require_node() -> None:
    # Vite 7 needs Node 20.19+/22.12+; OpenChamber's own release builds use Node 24.
    try:
        reported = subprocess.check_output(["node", "--version"], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        sys.exit("OpenChamber's web build runs Vite under Node; install Node 24 (`mise install`)")
    major, minor = (int(part) for part in reported.removeprefix("v").split(".")[:2])
    if (major, minor) < (22, 12):
        sys.exit(f"Node {reported} is too old for OpenChamber's web build; use Node 24 (`mise install`)")


def build_env() -> dict[str, str]:
    env = dict(os.environ)
    # Bun runs package scripts through bash; a BASH_ENV that re-activates a
    # version manager would put its shims ahead of the Bun running the build.
    env.pop("BASH_ENV", None)
    env.pop("ENV", None)
    # The web package never needs Electron; its postinstall fetch is best-effort anyway.
    env["ELECTRON_SKIP_BINARY_DOWNLOAD"] = "1"
    return env


def copy_source(source: Path, tree: Path) -> None:
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    if (source / ".git").exists():
        archive = subprocess.Popen(["git", "-C", str(source), "archive", "--format=tar", "HEAD"], stdout=subprocess.PIPE)
        extract = subprocess.run(["tar", "-x", "-C", str(tree)], stdin=archive.stdout, check=False)
        archive.stdout.close()
        if archive.wait() != 0 or extract.returncode != 0:
            sys.exit(f"could not copy {source}")
    else:
        # A source without git metadata (a Docker build stage): copy the files, not what a build left there.
        shutil.copytree(source, tree, dirs_exist_ok=True, ignore=shutil.ignore_patterns("node_modules", "dist", ".git"))


def pack(env: dict[str, str], web: Path, version: str, staging: Path) -> Path:
    # Beside the build tree, so the tree's cleanup (or --keep) covers it too.
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    bun(env, "pm", "pack", "--destination", str(staging), cwd=web)
    packed = list(staging.glob("*.tgz"))
    if len(packed) != 1:
        sys.exit(f"bun pm pack produced {len(packed)} archives")
    with tarfile.open(packed[0]) as archive:
        names = set(archive.getnames())
        manifest = json.loads(archive.extractfile("package/package.json").read())
        catalog = archive.extractfile("package/server/lib/guests/catalog.js").read().decode()
    missing = {"package/dist/index.html", "package/server/lib/oc-forge/manifest.js"} - names
    if missing:
        sys.exit(f"the package lacks {', '.join(sorted(missing))}")
    if SERVER_MARKER not in catalog:
        sys.exit("the packed server does not contain the adapted catalog")
    if manifest.get("version") != version:
        sys.exit(f"the package says version {manifest.get('version')}, expected {version}")
    workspace = [name for name, spec in manifest.get("dependencies", {}).items() if str(spec).startswith("workspace:")]
    if workspace:
        sys.exit(f"the package still has workspace dependencies: {', '.join(workspace)}")
    return packed[0]


def require_clean(source: Path, when: str) -> None:
    if not (source / ".git").exists():
        print(f"note: {source} has no git metadata; skipping the pristine check {when}")
        return
    status = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True)
    if status:
        sys.exit(f"{source} has changes {when}; it must stay pristine (adapt it from adapters/openchamber instead):\n{status}")


def bun(env: dict[str, str], *args: str, cwd: Path = ROOT) -> None:
    run(["bun", *args], cwd=cwd, env=env)


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    result = subprocess.run(command, cwd=cwd, env=env)
    if result.returncode != 0:
        sys.exit(f"failed ({result.returncode}): {' '.join(command)}")


def step(message: str) -> None:
    print(f"==> {message}", flush=True)


if __name__ == "__main__":
    main()
