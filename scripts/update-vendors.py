"""Move vendors/ to each vendor's latest official release, by hand: `mise run vendors:update`.

Run it on the branch whose pins you update (planner), in a checkout with no changes but the pins an earlier run of it
left. Its steps, in order, each one's output also in build/vendors-update/<step>.log:

0. init (a fresh checkout only): the submodules cloned, shallow;
1. sync: scripts/vendors.py moves vendors.json, upstream.json and the submodules to the latest releases;
2. setup: with the new pins staged, `mise run setup` (submodules at them, locked dependencies);
3. ci: `mise run ci` (the pins verified, upstream's checks and lifecycle tests, our adapter tests, the extensions);
4. openchamber: scripts/build-openchamber.py --check-only (every OpenChamber adapter still applies, and type-checks);
5. commit: "chore: update vendor releases", the pins alone, on the current branch.

A step that fails stops the run and commits nothing. The new pins stay staged, so the adapters and tests can be fixed
against them (in commits of their own); run it again to check and commit, or with --abort to put the branch's pins
back. It never pushes: a release is published when the commit reaches main (.github/workflows/release.yml).
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
PIN_PATHS = ("vendors", "vendors.json", "upstream.json")
LOGS = ROOT / "build/vendors-update"


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def is_pin_path(path: str) -> bool:
    return path in ("vendors", "vendors.json", "upstream.json") or path.startswith("vendors/")


def versions(pins: dict) -> dict[str, str]:
    """Each vendor's release tag, or the branch and commit a vendor without releases follows."""
    return {name: pin.get("release") or f"{pin.get('branch')}@{str(pin.get('commit', ''))[:9]}" for name, pin in pins.items()}


def stop(message: str) -> None:
    raise SystemExit(
        f"\nvendors:update stopped: {message}\n"
        "Nothing was committed. The new pins stay staged: fix the adapters or tests against them (and commit those fixes\n"
        "on their own), then run `mise run vendors:update` again; `mise run vendors:update -- --abort` puts this branch's\n"
        "pins back."
    )


def step(name: str, command: list[str], timeout_minutes: int) -> None:
    """Runs one step, its output to the terminal and to its log; stops the run if it fails or overruns."""
    LOGS.mkdir(parents=True, exist_ok=True)
    log = LOGS / f"{name}.log"
    print(f"\n==> {name}: {' '.join(command)}   (log: {log.relative_to(ROOT)})", flush=True)
    started = time.monotonic()
    with log.open("w") as out:
        process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)

        def pump() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                out.write(line)
                sys.stdout.write(line)
            sys.stdout.flush()

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        try:
            code: int | None = process.wait(timeout=timeout_minutes * 60)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
            code = None
        reader.join(timeout=10)
    minutes = (time.monotonic() - started) / 60
    if code != 0:
        stop(f"{name} {'ran past ' + str(timeout_minutes) + ' min' if code is None else 'failed (exit ' + str(code) + ')'} after {minutes:.1f} min; its output is in {log}")
    print(f"<== {name}: passed in {minutes:.1f} min", flush=True)


def abort() -> None:
    """Puts HEAD's pins back: vendors.json, upstream.json and the submodules at HEAD's commits."""
    git("reset", "-q", "HEAD", "--", *PIN_PATHS)
    git("checkout", "HEAD", "--", "vendors.json", "upstream.json")
    subprocess.run(["git", "submodule", "update", "--init", "--recursive"], cwd=ROOT, check=True)
    print(f"Pins back at HEAD's: {', '.join(f'{name} {version}' for name, version in versions(json.loads(git('show', 'HEAD:vendors.json'))).items())}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--abort", action="store_true", help="put this branch's pins back (HEAD's), ending an unfinished run")
    parser.add_argument("--trailer", action="append", default=[], help="a trailer for the commit, e.g. 'Co-authored-by: Name <email>' (repeatable)")
    parser.add_argument("--timeout-minutes", type=int, default=90, help="the longest a step may run (default: 90)")
    args = parser.parse_args()
    if args.abort:
        return abort()

    if git("rev-parse", "--abbrev-ref", "HEAD").strip() == "HEAD":
        raise SystemExit("Check out the branch to update first: the pins are committed to it.")
    others = [line for line in git("status", "--porcelain", "--untracked-files=no").splitlines() if not is_pin_path(line[3:])]
    if others:
        raise SystemExit("Only vendor pins may be uncommitted; commit or stash these first:\n" + "\n".join(others))

    # The sync fetches and checks out inside each submodule: in a fresh checkout's empty submodule folder, those git
    # commands would act on this repository instead. Missing ones are cloned first, shallow, as CI checks them out.
    if any(line.startswith("-") for line in git("submodule", "status").splitlines()):
        step("init", ["git", "submodule", "update", "--init", "--recursive", "--depth", "1"], args.timeout_minutes)
    step("sync", [sys.executable, "scripts/vendors.py", "sync"], args.timeout_minutes)
    before = versions(json.loads(git("show", "HEAD:vendors.json")))
    after = versions(json.loads((ROOT / "vendors.json").read_text()))
    if not git("diff", "HEAD", "--name-only", "--", *PIN_PATHS).split():
        print(f"\nUp to date: {', '.join(f'{name} {version}' for name, version in after.items())}.")
        return
    # Staged, so that setup's `git submodule update` checks the submodules out at the new pins, not HEAD's.
    git("add", "--", *PIN_PATHS)
    step("setup", ["mise", "run", "setup"], args.timeout_minutes)
    step("ci", ["mise", "run", "ci"], args.timeout_minutes)
    step("openchamber", [sys.executable, "scripts/build-openchamber.py", "--check-only"], args.timeout_minutes)

    moves = [f"- {name}: {before.get(name, 'new')} -> {version}" for name, version in after.items() if before.get(name) != version]
    message = "chore: update vendor releases\n\n" + "\n".join(moves or ["- the pinned commits"]) + "\n\nBy `mise run vendors:update`: setup, `mise run ci` and the OpenChamber adapters passed.\n"
    trailers = [part for trailer in args.trailer for part in ("--trailer", trailer)]
    git("commit", "-q", "-m", message, *trailers, "--", *PIN_PATHS)
    print(f"\nCommitted {git('rev-parse', '--short', 'HEAD').strip()} on {git('rev-parse', '--abbrev-ref', 'HEAD').strip()}:\n" + "\n".join(moves))


if __name__ == "__main__":
    main()
