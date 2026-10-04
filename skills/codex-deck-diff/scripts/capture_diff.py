#!/usr/bin/env python3
"""Freeze a local Git diff for authoring guide.json against exact source contents."""

import argparse
import json
from pathlib import Path

from git_snapshot import capture, selection, selectors, snapshot_trees


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="Snapshot JSON path")
    parser.add_argument("--overwrite", action="store_true")
    selectors(parser)
    args = parser.parse_args()
    if args.output.exists() and not args.overwrite:
        parser.error("Output exists; choose another path or use --overwrite")
    try:
        snapshot = capture(args.repo, *selection(args), excludes=[*args.exclude, args.output.absolute()])
        # Reuse the exact builder's diff parser to expose hunk ranges for authoring.
        from build_guide import changed_files
        with snapshot_trees(snapshot) as (repo, left, right):
            files = changed_files(repo, left, right)
        if not files:
            raise ValueError("This comparison has no changed files")
        snapshot["files"] = files
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w" if args.overwrite else "x", encoding="utf-8") as target:
            json.dump(snapshot, target, ensure_ascii=False, indent=2)
            target.write("\n")
        print(json.dumps({"path": str(args.output.resolve()), "comparison": snapshot["comparison"],
                          "files": list(files)}, ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f"Diff capture failed: {error}\n")


if __name__ == "__main__":
    main()
