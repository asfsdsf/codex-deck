#!/usr/bin/env python3
"""Print numbered source lines from a captured diff, including unchanged files."""

import argparse
from pathlib import Path

from git_snapshot import decode_entry, load_snapshot, valid_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--side", choices=("left", "right"), default="right")
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int)
    args = parser.parse_args()
    try:
        snapshot = load_snapshot(args.snapshot, args.repo)
        entry = snapshot[args.side][valid_path(args.path)]
        if entry["mode"] == "160000":
            raise ValueError("Submodule gitlink; no text source")
        raw = decode_entry(snapshot, entry)
        if b"\0" in raw:
            raise ValueError("Binary file; no text source")
        text = raw.decode("utf-8")
        lines = text.split("\n") if text else []
        if text.endswith("\n"):
            lines.pop()
        end = args.end if args.end is not None else len(lines)
        if not lines and args.start == 1 and args.end is None:
            return
        if not 1 <= args.start <= end <= len(lines):
            raise ValueError("Source range is out of bounds")
        for line in range(args.start, end + 1):
            print(f"{line:>6}  {lines[line - 1]}")
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f"Source read failed: {error}\n")


if __name__ == "__main__":
    main()
