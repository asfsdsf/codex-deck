"""Create an isolated, realistic tour for browser smoke tests."""

import argparse
import json
from pathlib import Path

from test_builder import SKILL, build, capture, files_of, git, manifest_for, render


def create(directory):
    repo = directory / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    git(repo, "init", "--quiet", "--initial-branch=main")
    git(repo, "config", "user.email", "fixture@example.test")
    git(repo, "config", "user.name", "Fixture")
    lines = ["from helper import Token\n"] + [f"value_{i} = {i}\n" for i in range(2, 141)]
    (repo / "main.py").write_text("".join(lines))
    (repo / "helper.py").write_text("class Base:\n    pass\n\nclass Token(Base):\n    pass\n")
    (repo / "removed.txt").write_text("Old response\n")
    (repo / "old-name.txt").write_text("Renamed contents\n")
    git(repo, "add", ".")
    git(repo, "commit", "--quiet", "-m", "Initial fixture")
    lines[9] = "limit = 10\n"
    lines[65] = "result = Token()\n"
    (repo / "main.py").write_text("".join(lines))
    (repo / "response.txt").write_text("The response now carries a token.\n")
    (repo / "removed.txt").unlink()
    (repo / "old-name.txt").rename(repo / "new-name.txt")
    snapshot = capture(repo)
    manifest = manifest_for(snapshot)
    manifest.update(title="Return a typed search response", overview="Follow the changed request through its result type and response.")
    order = {"main.py": 0, "response.txt": 1, "removed.txt": 2, "new-name.txt": 3}
    manifest["steps"].sort(key=lambda s: order[s["file"]])
    for index, step in enumerate(manifest["steps"]):
        step["id"] = f"step-{index}"
        step.pop("transition", None)
        if index < len(manifest["steps"]) - 1:
            step["transition"] = dict(to=f"step-{index + 1}", basis="reading")
    first = manifest["steps"][0]
    first.update(title="Apply the limit and return a Token", heading="The result now has an explicit type",
                 why="The request now uses a limit and returns a Token. Follow these two changes, then read how the response uses the result.",
                 notes=[dict(title="Set the limit", start=10, end=10, text="The request uses a limit of ten results."),
                        dict(title="Return a Token", start=66, end=66, text="The result is constructed as a Token, which derives from Base.")],
                 reference=dict(path="helper.py", start=4, end=5, label="Existing Token type", text="The result type already inherits shared behavior from Base."))
    first["transition"] = dict(to="step-1", basis="source", evidence=[
        dict(path="main.py", side="right", start=66, end=66, text="The request constructs the typed result.")])
    manifest["definitions"] = {
        "Token": dict(path="helper.py", name="Token", start=4, end=5, description="The typed response result; inherits Base."),
        "Base": dict(path="helper.py", name="Base", start=1, end=2, description="Shared behavior for response types.")}
    manifest["pythonSymbols"] = {"main.py": {"Token": "Token"}, "helper.py": {"Base": "Base"}}
    snapshot["files"] = files_of(snapshot)
    (directory / "snapshot.json").write_text(json.dumps(snapshot, indent=2))
    (directory / "guide.json").write_text(json.dumps(manifest, indent=2))
    data = build(repo, manifest, snapshot)
    (directory / "diff-tour.html").write_text(render((SKILL / "assets/guide.html").read_text(), data))
    return directory / "diff-tour.html"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(create(args.output.resolve()))
