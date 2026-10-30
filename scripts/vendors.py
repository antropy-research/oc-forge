"""Pin official stable releases: OpenCode V2 npm latest, others GitHub latest.

A vendor without releases names a branch in vendors.json and follows its head.
"""

import json
import os
import re
from pathlib import Path
import subprocess
import sys
from typing import Optional
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PINS = ROOT / "vendors.json"


def latest_tag(name: str, pin: dict) -> str:
    if name == "opencode":
        with urllib.request.urlopen("https://registry.npmjs.org/@opencode%2fcli/latest", timeout=30) as response:
            version = json.load(response)["version"]
        if not re.fullmatch(r"2\.\d+\.\d+", version):
            raise SystemExit(f"Unexpected OpenCode V2 stable version: {version}")
        return f"v{version}"
    owner_repo = pin["repository"].removesuffix(".git").removeprefix("https://github.com/")
    headers = {"Accept": "application/vnd.github+json"}
    if token := os.environ.get("GH_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"https://api.github.com/repos/{owner_repo}/releases/latest", headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.load(response)
    tag = release.get("tag_name", "")
    pattern = r"\d+\.\d+\.\d+" if name == "vscode" else r"v\d+\.\d+\.\d+"
    if release.get("draft") or release.get("prerelease") or not re.fullmatch(pattern, tag):
        raise SystemExit(f"{name}: latest release is not a stable desktop release")
    return tag


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] != "sync":
        raise SystemExit("usage: vendors.py sync")
    pins = json.loads(PINS.read_text())
    changed = False
    # Resolve all candidates before changing any checkout.
    candidates = {}
    for name, pin in pins.items():
        path = ROOT / "vendors" / name
        if path.exists() and subprocess.check_output(["git", "-C", str(path), "status", "--porcelain"], text=True).strip():
            raise SystemExit(f"{name}: submodule must be pristine before sync")
        if "branch" in pin:
            # A repository CI cannot read yet (e.g. private, no token) is skipped
            # rather than failing the sync of every other vendor.
            if commit := branch_commit(name, pin):
                candidates[name] = (pin["branch"], commit)
            continue
        tag = latest_tag(name, pin)
        commit = tag_commit(pin["repository"], tag)
        if tag == pin["release"] and commit != pin["commit"]:
            raise SystemExit(f"{name}: pinned tag {tag} moved upstream")
        candidates[name] = (tag, commit)
    for name, pin in pins.items():
        if name not in candidates:
            continue
        ref, commit = candidates[name]
        updated = {**pin, "commit": commit} if "branch" in pin else {**pin, "release": ref, "commit": commit}
        if updated == pin:
            print(f"{name}: up to date at {ref} ({commit})")
            continue
        path = ROOT / "vendors" / name
        if not path.exists():
            # A vendor new to vendors.json becomes a submodule here, so only CI adds one.
            subprocess.run(["git", "-C", str(ROOT), "submodule", "add", pin["repository"], f"vendors/{name}"], check=True)
        elif "branch" in pin:
            subprocess.run(["git", "-C", str(path), "fetch", "--depth=1", "origin", commit], check=True)
        else:
            subprocess.run(["git", "-C", str(path), "fetch", "--depth=1", "origin", f"refs/tags/{ref}:refs/tags/{ref}"], check=True)
        subprocess.run(["git", "-C", str(path), "checkout", "--detach", commit], check=True)
        pins[name] = updated
        changed = True
        print(f"{name}: updated to {ref} ({commit})")
    if changed:
        PINS.write_text(json.dumps(pins, indent=2) + "\n")
        (ROOT / "upstream.json").write_text(json.dumps({
            "repository": pins["opencode"]["repository"],
            "tag": pins["opencode"]["release"],
            "commit": pins["opencode"]["commit"],
        }, indent=2) + "\n")
    print(f"changed={'true' if changed else 'false'}")
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"changed={'true' if changed else 'false'}\n")
            output.write(f"upstream={pins['opencode']['release']}\n")


def tag_commit(repository: str, tag: str) -> str:
    listing = subprocess.check_output(
        ["git", "ls-remote", repository, f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"], text=True
    )
    refs = dict(reversed(line.split("\t")) for line in listing.splitlines())
    commit = refs.get(f"refs/tags/{tag}^{{}}") or refs.get(f"refs/tags/{tag}")
    if not commit:
        raise SystemExit(f"formal release {tag} has no git tag in {repository}")
    return commit


def branch_commit(name: str, pin: dict) -> Optional[str]:
    listing = subprocess.run(
        ["git", "ls-remote", pin["repository"], f"refs/heads/{pin['branch']}"],
        capture_output=True, text=True, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if listing.returncode != 0:
        print(f"{name}: cannot read {pin['repository']}; skipped", file=sys.stderr)
        return None
    if not listing.stdout.strip():
        raise SystemExit(f"{name}: branch {pin['branch']} not found in {pin['repository']}")
    return listing.stdout.split()[0]


if __name__ == "__main__":
    main()
