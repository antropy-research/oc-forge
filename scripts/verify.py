"""Validate the wrapper's reproducible upstream and tool-version contracts."""

import json
from pathlib import Path
import subprocess
import tomllib


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    upstream = json.loads((root / "upstream.json").read_text())
    pins = json.loads((root / "vendors.json").read_text())
    for name, pin in pins.items():
        if "commit" not in pin:
            # Listed, not vendored yet: upstream sync adds it once it can read the repository.
            print(f"{name}: not vendored yet")
            continue
        path = root / "vendors" / name
        def git(*args: str) -> str:
            return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()
        if "branch" in pin:
            # No release tag to check against: the pin is a commit of the tracked branch.
            if git("rev-parse", "HEAD") != pin["commit"]:
                raise SystemExit(f"{name}: HEAD differs from vendors.json")
        else:
            tag = f"refs/tags/{pin['release']}"
            # CI checks submodules out shallow and without tags; fetch just the pinned one.
            if subprocess.run(["git", "-C", str(path), "rev-parse", "--verify", "--quiet", f"{tag}^{{commit}}"], capture_output=True).returncode != 0:
                git("fetch", "--quiet", "--depth=1", "origin", f"+{tag}:{tag}")
            if git("rev-parse", "HEAD") != pin["commit"] or git("rev-parse", f"{tag}^{{commit}}") != pin["commit"]:
                raise SystemExit(f"{name}: HEAD/tag differs from vendors.json")
        if git("status", "--porcelain"):
            raise SystemExit(f"{name}: vendor checkout must stay pristine")
    if upstream != {"repository": pins["opencode"]["repository"], "tag": pins["opencode"]["release"], "commit": pins["opencode"]["commit"]}:
        raise SystemExit("OpenCode pins differ between vendors.json and upstream.json")
    config = tomllib.loads((root / "mise.toml").read_text())
    package = json.loads((root / "vendors/opencode/packages/cli/package.json").read_text())
    workspace = json.loads((root / "vendors/opencode/package.json").read_text())
    head = subprocess.check_output(
        ["git", "-C", str(root / "vendors/opencode"), "rev-parse", "HEAD"], text=True
    ).strip()
    if head != upstream["commit"]:
        raise SystemExit("Submodule HEAD differs from upstream.json; update the pin explicitly.")
    if package["version"] != upstream["tag"].removeprefix("v"):
        raise SystemExit("Upstream package version does not match the pinned release tag.")
    if workspace["packageManager"] != f"bun@{config['tools']['bun']}":
        raise SystemExit("mise Bun version differs from the upstream packageManager.")
    if (root / ".python-version").read_text().strip() != config["tools"]["python"]:
        raise SystemExit("Python pins differ between mise and uv.")
    status = subprocess.check_output(["git", "-C", str(root / "vendors/opencode"), "status", "--porcelain"], text=True)
    if status:
        raise SystemExit(f"Upstream submodule must stay pristine; adapt it from adapters/ instead:\n{status}")
    print(f"Verified {upstream['tag']} ({head}) and tool-version contracts.")


if __name__ == "__main__":
    main()
