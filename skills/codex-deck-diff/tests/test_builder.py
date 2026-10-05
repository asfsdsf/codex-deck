"""Observable snapshot, Git comparison, source validation, and CLI behavior."""

import copy
import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
from build_guide import build, changed_files, flatten, render
from git_snapshot import capture, decode_entry, git, load_snapshot, read_snapshot_source, snapshot_trees, digest


def files_of(snapshot):
    if snapshot["sourceMode"] == "project":
        return copy.deepcopy(snapshot["files"])
    with snapshot_trees(snapshot) as (repo, left, right):
        return changed_files(repo, left, right)


def manifest_for(snapshot):
    files = files_of(snapshot)
    steps = []
    for index, (path, file) in enumerate(files.items()):
        step = dict(id=f"step-{index}", group="Behavior", title=path, file=path,
                    heading="Follow this change", why="The caller now receives the updated result.",
                    check="Check the returned value.", next="Continue reading.", notes=[])
        if index < len(files) - 1:
            step["transition"] = dict(to=f"step-{index + 1}", basis="reading")
        steps.append(step)
    return dict(title="Fixture tour", overview="Trace the changed behavior.", language="en",
                comparison=copy.deepcopy(snapshot["comparison"]), steps=steps)


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="diff-tour-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.repo = self.directory / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "--quiet", "--initial-branch=main")
        git(self.repo, "config", "user.email", "fixture@example.test")
        git(self.repo, "config", "user.name", "Fixture")
        self.write("main.py", "def compute(value):\n    return value + 1\n")
        self.write("helper.py", "class Token:\n    pass\n")
        self.write(".gitignore", "ignored/\n")
        self.commit()
        self.initial = git(self.repo, "rev-parse", "HEAD").decode().strip()

    def write(self, path, content):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode() if isinstance(content, str) else content)
        return target

    def commit(self):
        git(self.repo, "add", "--all")
        git(self.repo, "commit", "--quiet", "-m", "Fixture change")

    def cli(self, script, *args, success=True):
        result = subprocess.run([sys.executable, str(SKILL / "scripts" / script),
                                 "--repo", str(self.repo), *map(str, args)], capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_source_free_reconstruction_survives_later_edits_and_ref_moves(self):
        original = "".join(f"line {i} 中文 😀\r\n" for i in range(1, 301))
        self.write(".gitattributes", "large.txt -text\n")
        self.write("large.txt", original)
        self.commit()
        git(self.repo, "tag", "before")
        updated = original.replace("line 150", "changed 150").rstrip("\n")
        self.write("large.txt", updated)
        self.write("added.txt", "new without newline")
        self.write("helper.py", b"\xef\xbb\xbfclass Token:\n    pass\n")
        (self.repo / "main.py").rename(self.repo / "renamed.py")
        snapshot = capture(self.repo, "tag", "before", omit_source=True)
        self.assertNotIn("blobs", snapshot)
        self.assertEqual(snapshot["sourceMode"], "project")
        self.assertTrue(any(row["kind"] == "gap" and "lines" not in row
                            for row in snapshot["files"]["large.txt"]["rows"]))
        path = self.directory / "snapshot.json"
        path.write_text(json.dumps(snapshot))
        manifest = manifest_for(snapshot)
        self.write("large.txt", "later edit\n")
        self.write("added.txt", "later addition\n")
        self.commit()
        git(self.repo, "tag", "-f", "before")
        loaded = load_snapshot(path, self.repo)
        self.assertEqual(read_snapshot_source(loaded, self.repo, "large.txt"), updated.encode())
        self.assertEqual(read_snapshot_source(loaded, self.repo, "large.txt", "left"), original.encode())
        self.assertEqual(read_snapshot_source(loaded, self.repo, "renamed.py"), b"def compute(value):\n    return value + 1\n")
        data = build(self.repo, manifest, loaded)
        self.assertEqual(data["sources"], {"left": {}, "right": {}})
        self.assertTrue(all("lines" not in row for file in data["files"].values()
                            for row in file["rows"] if row["kind"] == "gap"))
        self.assertIn('"sourceMode": "project"', render((SKILL / "assets/guide.html").read_text(), data))
        result = self.cli("read_source.py", "--snapshot", path, "--path", "added.txt")
        self.assertIn("new without newline", result.stdout)
        output = self.directory / "guide.json"
        output.write_text(json.dumps(manifest))
        self.cli("build_guide.py", "--snapshot", path, "--manifest", output,
                 "--output", self.directory / "thin.html")
        snapshot["comparison"]["base"] = "0" * 40
        snapshot["comparison"]["fingerprint"] = digest(snapshot)
        with self.assertRaisesRegex(ValueError, "Baseline commit.*unavailable"):
            read_snapshot_source(snapshot, self.repo, "large.txt", "left")

    def test_source_free_size_tampering_empty_baseline_and_binary_notice(self):
        self.write("large.txt", "unchanged source line\n" * 10000)
        self.commit()
        self.write("large.txt", "unchanged source line\n" * 5000 + "changed line\n" + "unchanged source line\n" * 4999)
        self.write("binary", b"\0\xff")
        snapshot = capture(self.repo, omit_source=True)
        self.assertLess(len(json.dumps(snapshot)), 10000)
        data = build(self.repo, manifest_for(snapshot), snapshot)
        self.assertIn("notice", data["files"]["binary"])
        row = next(row for row in snapshot["files"]["large.txt"]["rows"] if row["kind"] == "add")
        row["text"] = "tampered"
        with self.assertRaisesRegex(ValueError, "object ID"):
            read_snapshot_source(snapshot, self.repo, "large.txt")
        path = self.directory / "invalid.json"
        path.write_text(json.dumps(snapshot))
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            load_snapshot(path, self.repo)
        empty = self.directory / "empty"
        empty.mkdir()
        git(empty, "init", "--quiet")
        (empty / "new").write_bytes(b"new code\n")
        first = capture(empty, omit_source=True)
        self.assertIsNone(first["comparison"]["base"])
        self.assertEqual(read_snapshot_source(first, empty, "new"), b"new code\n")

    def test_default_final_worktree_and_new_files(self):
        self.write("main.py", "staged\n")
        git(self.repo, "add", "main.py")
        self.write("main.py", "final\n")
        self.write("new.ts", "export const answer = 42;\n")
        self.write("ignored/secret", "ignored\n")
        snapshot = capture(self.repo)
        self.assertEqual(decode_entry(snapshot, snapshot["right"]["main.py"]), b"final\n")
        self.assertNotIn("ignored/secret", snapshot["right"])
        self.assertEqual(set(files_of(snapshot)), {"main.py", "new.ts"})
        data = build(self.repo, manifest_for(snapshot), snapshot)
        self.assertEqual(data["comparison"]["base"], self.initial)

    def test_staged_edit_reverted_in_worktree_is_not_two_patches(self):
        self.write("main.py", "staged\n")
        git(self.repo, "add", "main.py")
        self.write("main.py", git(self.repo, "show", "HEAD:main.py"))
        self.assertFalse(files_of(capture(self.repo)))

    def test_revision_baselines_are_direct_not_merge_base(self):
        git(self.repo, "checkout", "--quiet", "-b", "other")
        self.write("other-only", "Other branch\n")
        self.commit()
        other = git(self.repo, "rev-parse", "HEAD").decode().strip()
        git(self.repo, "tag", "-a", "release", "-m", "Annotated release")
        git(self.repo, "update-ref", "refs/remotes/origin/other", other)
        git(self.repo, "checkout", "--quiet", "main")
        self.write("main-only", "Committed on main\n")
        self.commit()
        self.write("new", "Current untracked code\n")
        for kind, ref in (("commit", other[:12]), ("branch", "other"),
                          ("branch", "origin/other"), ("tag", "release")):
            with self.subTest(kind=kind, ref=ref):
                snapshot = capture(self.repo, kind, ref)
                self.assertEqual(snapshot["comparison"]["base"], other)
                files = files_of(snapshot)
                self.assertEqual(files["other-only"]["status"], "D")
                self.assertEqual(files["main-only"]["status"], "A")
                self.assertEqual(files["new"]["status"], "A")

    def test_invalid_and_ambiguous_selectors(self):
        for kind, ref in (("commit", "--help"), ("commit", "missing"),
                          ("branch", self.initial), ("branch", "main~1"), ("tag", "main")):
            with self.subTest(kind=kind):
                with self.assertRaises(ValueError):
                    capture(self.repo, kind, ref)
        git(self.repo, "branch", "origin/main")
        git(self.repo, "update-ref", "refs/remotes/origin/main", self.initial)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            capture(self.repo, "branch", "origin/main")
        self.assertEqual(capture(self.repo, "branch", "refs/remotes/origin/main")["comparison"]["base"], self.initial)
        self.cli("build_guide.py", "--manifest", "unused", "--output", "unused",
                 "--branch", "main", "--tag", "release", success=False)

    def test_readonly_source_repository_and_snapshot_replay(self):
        self.write("main.py", "final\n")
        before = {p.relative_to(self.repo).as_posix(): p.read_bytes()
                  for p in self.repo.rglob("*") if p.is_file()}
        snapshot = capture(self.repo)
        manifest = manifest_for(snapshot)
        data = build(self.repo, manifest, snapshot)
        render((SKILL / "assets/guide.html").read_text(), data)
        after = {p.relative_to(self.repo).as_posix(): p.read_bytes()
                 for p in self.repo.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.write("main.py", "later edit\n")
        with self.assertRaisesRegex(ValueError, "does not match"):
            build(self.repo, manifest)
        replay = build(self.repo, manifest, snapshot)
        self.assertEqual(replay["sources"]["right"]["main.py"], ["final"])

    def test_cli_capture_build_overwrite_language_and_exclusions(self):
        self.write("main.py", "final\n")
        output = self.repo / "tour"
        snapshot_path = output / "snapshot.json"
        self.cli("capture_diff.py", "--output", snapshot_path, "--exclude", output)
        snapshot = load_snapshot(snapshot_path, self.repo)
        guide = output / "guide.json"
        guide.write_text(json.dumps(manifest_for(snapshot)))
        html = output / "tour.html"
        self.cli("build_guide.py", "--manifest", guide, "--output", html)
        self.assertIn('<html lang="en">', html.read_text())
        self.cli("build_guide.py", "--manifest", guide, "--output", html, success=False)
        self.cli("build_guide.py", "--manifest", guide, "--output", html,
                 "--snapshot", snapshot_path, "--overwrite", "--language", "ko")
        self.assertIn('<html lang="ko">', html.read_text())
        result = self.cli("read_source.py", "--snapshot", snapshot_path, "--path", "main.py")
        self.assertIn("1  final", result.stdout)
        self.cli("capture_diff.py", "--output", snapshot_path, success=False)

    def test_snapshot_tampering_and_repository_identity(self):
        self.write("main.py", "final\n")
        path = self.directory / "snapshot.json"
        snapshot = capture(self.repo)
        path.write_text(json.dumps(snapshot))
        self.assertEqual(load_snapshot(path, self.repo), snapshot)
        oid = snapshot["right"]["main.py"]["oid"]
        snapshot["blobs"][oid] = base64.b64encode(zlib.compress(b"tampered")).decode()
        path.write_text(json.dumps(snapshot))
        with self.assertRaisesRegex(ValueError, "object ID"):
            load_snapshot(path, self.repo)
        other = self.directory / "other"
        other.mkdir()
        git(other, "init", "--quiet")
        with self.assertRaisesRegex(ValueError, "different repository"):
            load_snapshot(path, other)

    def test_compact_snapshot_omits_unchanged_assets_and_shares_frozen_text(self):
        shared = ("# Shared source with Unicode: 中文 😀\r\n" * 2000).encode()
        self.write(".gitattributes", "shared.py -text\ncopy.py -text\n")
        self.write("shared.py", shared)
        self.write("copy.py", shared)
        self.write("image.png", b"\0" + os.urandom(1024 * 1024))
        self.write("non-utf8.dat", b"\xff" + os.urandom(1024 * 1024))
        self.commit()
        self.write("main.py", "changed\n")
        snapshot = capture(self.repo)
        self.assertEqual(snapshot["schemaVersion"], 3)
        for side in ("left", "right"):
            self.assertNotIn("image.png", snapshot[side])
            self.assertNotIn("non-utf8.dat", snapshot[side])
            self.assertEqual(decode_entry(snapshot, snapshot[side]["shared.py"]), shared)
            self.assertEqual(snapshot[side]["shared.py"]["oid"], snapshot["right"]["copy.py"]["oid"])
        self.assertEqual(set(files_of(snapshot)), {"main.py"})
        self.assertLess(len(json.dumps(snapshot).encode()), 10_000)
        snapshot_path = self.directory / "snapshot.json"
        snapshot_path.write_text(json.dumps(snapshot))
        self.assertEqual(load_snapshot(snapshot_path, self.repo), snapshot)
        # A replay must still resolve unchanged source after live files disappear.
        (self.repo / "shared.py").unlink()
        (self.repo / "copy.py").unlink()
        manifest = manifest_for(snapshot)
        manifest["definitions"] = {"Shared": dict(path="shared.py", start=1, end=1, description="Frozen shared source.")}
        data = build(self.repo, manifest, snapshot)
        self.assertEqual(data["definitions"]["Shared"]["rows"][0]["text"], shared.decode().split("\n")[0])
        result = self.cli("read_source.py", "--snapshot", snapshot_path, "--path", "shared.py", "--start", 1, "--end", 1)
        self.assertIn("中文 😀", result.stdout)

    def test_binary_changes_renames_deletions_and_modes_are_retained(self):
        binary = b"\0" + os.urandom(2048)
        for path in ("rename.bin", "mode.bin", "modify.bin", "delete.bin"):
            self.write(path, binary)
        self.write("delete.bin", b"\0" + os.urandom(2048))
        self.commit()
        (self.repo / "rename.bin").rename(self.repo / "renamed.bin")
        os.chmod(self.repo / "mode.bin", 0o755)
        (self.repo / "delete.bin").unlink()
        self.write("modify.bin", b"\0new binary")
        snapshot = capture(self.repo)
        files = files_of(snapshot)
        self.assertEqual({path: file["status"] for path, file in files.items()},
                         {"renamed.bin": "R", "mode.bin": "M", "modify.bin": "M", "delete.bin": "D"})
        self.assertTrue(all(file.get("notice") for file in files.values()))
        self.assertEqual(decode_entry(snapshot, snapshot["right"]["renamed.bin"]), binary)
        self.assertEqual(snapshot["left"]["rename.bin"]["oid"], snapshot["right"]["mode.bin"]["oid"])
        build(self.repo, manifest_for(snapshot), snapshot)

    def test_snapshot_rejects_missing_invalid_or_unreferenced_blobs_and_old_format(self):
        self.write("main.py", "changed\n")
        snapshot = capture(self.repo)
        path = self.directory / "snapshot.json"
        oid = snapshot["right"]["main.py"]["oid"]
        for kind in ("missing", "invalid-base64", "invalid-zlib", "unreferenced", "old-format", "fingerprint"):
            with self.subTest(kind=kind):
                bad = copy.deepcopy(snapshot)
                if kind == "missing":
                    del bad["blobs"][oid]
                elif kind == "invalid-base64":
                    bad["blobs"][oid] = "!"
                elif kind == "invalid-zlib":
                    bad["blobs"][oid] = base64.b64encode(b"uncompressed").decode()
                elif kind == "unreferenced":
                    bad["blobs"]["0" * 40] = bad["blobs"][oid]
                elif kind == "old-format":
                    bad["schemaVersion"] = 1
                else:
                    bad["comparison"]["fingerprint"] = "incorrect"
                path.write_text(json.dumps(bad))
                with self.assertRaises(ValueError):
                    load_snapshot(path, self.repo)

    def test_file_kinds_and_exact_lines(self):
        self.write("long.txt", "".join(f"line {i}\n" for i in range(130)))
        self.write("old name.txt", "identical renamed contents\n")
        self.write("deleted.txt", "Removed\n")
        self.write("link", "old regular file\n")
        self.commit()
        (self.repo / "old name.txt").rename(self.repo / "new name.txt")
        (self.repo / "deleted.txt").unlink()
        (self.repo / "link").unlink()
        (self.repo / "link").symlink_to(self.directory / "outside")
        self.write("binary.dat", b"\0\xffbinary")
        self.write("non-utf8.dat", b"\xff\xfe")
        self.write("empty", "")
        self.write("strange\tfile\n名.txt", "emoji 😀\r\nno newline")
        self.write("long.txt", "".join(f"line {i}\n" if i != 65 else "changed\n" for i in range(130)))
        os.chmod(self.repo / "helper.py", 0o755)
        snapshot = capture(self.repo)
        files = files_of(snapshot)
        self.assertEqual(files["new name.txt"]["status"], "R")
        self.assertEqual(files["deleted.txt"]["status"], "D")
        self.assertEqual(files["link"]["status"], "T")
        self.assertEqual(files["helper.py"]["newMode"], "100755")
        self.assertTrue(files["binary.dat"]["notice"])
        self.assertTrue(files["non-utf8.dat"]["notice"])
        lines = [r["text"] for r in flatten(files["strange\tfile\n名.txt"]["rows"]) if r.get("new")]
        self.assertEqual(lines, ["emoji 😀\r", "no newline"])
        self.assertTrue(any(row["kind"] == "gap" for row in files["long.txt"]["rows"]))
        build(self.repo, manifest_for(snapshot), snapshot)

    def test_definitions_links_citations_and_range_failures(self):
        self.write("main.py", "from helper import Token\n\ndef compute(value):\n    return Token()\n")
        snapshot = capture(self.repo)
        manifest = manifest_for(snapshot)
        step = manifest["steps"][0]
        step["notes"] = [dict(title="Return a token", text="Returns the new type.", start=4, end=4)]
        step["reference"] = dict(path="helper.py", start=1, end=2, label="Token", text="The returned type.")
        manifest["definitions"] = {"Token": dict(path="helper.py", start=1, end=2, description="The result type.")}
        manifest["pythonSymbols"] = {"main.py": {"Token": "Token"}}
        data = build(self.repo, manifest, snapshot)
        self.assertEqual(data["definitions"]["Token"]["rows"][0]["text"], "class Token:")
        self.assertTrue(any(r.get("links") for r in data["files"]["main.py"]["rows"]))
        broken = copy.deepcopy(manifest)
        broken["steps"][0]["notes"][0]["end"] = 999
        with self.assertRaisesRegex(ValueError, "out of bounds"):
            build(self.repo, broken, snapshot)
        broken = copy.deepcopy(manifest)
        broken["definitions"]["Token"]["path"] = "../outside"
        with self.assertRaises(ValueError):
            build(self.repo, broken, snapshot)
        broken = copy.deepcopy(manifest)
        broken["links"] = [dict(path="main.py", line=4, text="Unknown", definition="Token")]
        with self.assertRaises(ValueError):
            build(self.repo, broken, snapshot)

    def test_citation_validation_and_missing_file_coverage(self):
        self.write("main.py", "changed\n")
        self.write("new", "also changed\n")
        snapshot = capture(self.repo)
        manifest = manifest_for(snapshot)
        manifest["steps"][0]["transition"] = dict(to="step-1", basis="source", evidence=[
            dict(path="helper.py", side="right", start=1, end=2, text="Shared type")])
        data = build(self.repo, manifest, snapshot)
        self.assertEqual(data["transitionSummary"]["source"], 1)
        manifest["steps"][0]["transition"]["evidence"][0]["end"] = 99
        with self.assertRaisesRegex(ValueError, "out of bounds"):
            build(self.repo, manifest, snapshot)
        manifest = manifest_for(snapshot)
        manifest["steps"].pop()
        manifest["steps"][0].pop("transition")
        with self.assertRaisesRegex(ValueError, "Every changed file"):
            build(self.repo, manifest, snapshot)

    def test_binary_symlink_parent_is_not_followed(self):
        self.write("nested/child", "tracked\n")
        self.commit()
        (self.repo / "nested/child").unlink()
        (self.repo / "nested").rmdir()
        external = self.directory / "outside"
        external.mkdir()
        (external / "child").write_text("Do not read me")
        (self.repo / "nested").symlink_to(external)
        snapshot = capture(self.repo)
        self.assertNotIn("nested/child", snapshot["right"])
        self.assertIn("nested", snapshot["right"])

    def test_submodule_gitlink_changes(self):
        git(self.repo, "update-index", "--add", "--cacheinfo", "160000", self.initial, "sub")
        git(self.repo, "commit", "--quiet", "-m", "Add gitlink")
        (self.repo / "sub").mkdir()
        new_oid = git(self.repo, "rev-parse", "HEAD").decode().strip()
        git(self.repo, "update-index", "--cacheinfo", "160000", new_oid, "sub")
        files = files_of(capture(self.repo))
        self.assertEqual(files["sub"]["status"], "M")
        self.assertIn("notice", files["sub"])
        (self.repo / "sub").rmdir()
        self.assertEqual(files_of(capture(self.repo))["sub"]["status"], "D")

    def test_untracked_nested_repository_is_a_gitlink(self):
        nested = self.repo / "nested"
        nested.mkdir()
        git(nested, "init", "--quiet")
        git(nested, "config", "user.email", "fixture@example.test")
        git(nested, "config", "user.name", "Fixture")
        (nested / "first").write_text("nested code\n")
        git(nested, "add", ".")
        git(nested, "commit", "--quiet", "-m", "Nested repository")
        files = files_of(capture(self.repo))
        self.assertEqual(files["nested"]["status"], "A")
        self.assertEqual(files["nested"]["newMode"], "160000")

    def test_unborn_repository_and_empty_comparison(self):
        empty = self.directory / "empty"
        empty.mkdir()
        git(empty, "init", "--quiet")
        (empty / "first").write_text("first\n")
        snapshot = capture(empty)
        self.assertIsNone(snapshot["comparison"]["base"])
        self.assertEqual(files_of(snapshot)["first"]["status"], "A")
        self.cli("capture_diff.py", "--output", self.directory / "clean.json", success=False)

    def test_unmerged_entries_require_resolution(self):
        oid = git(self.repo, "rev-parse", "HEAD:main.py").decode().strip()
        records = f"0 {'0' * 40}\tmain.py\n100644 {oid} 1\tmain.py\n100644 {oid} 2\tmain.py\n"
        git(self.repo, "update-index", "--index-info", input=records.encode())
        with self.assertRaisesRegex(ValueError, "unmerged"):
            capture(self.repo)

    def test_sha256_repository(self):
        repo = self.directory / "sha256"
        repo.mkdir()
        try:
            git(repo, "init", "--quiet", "--object-format=sha256")
        except ValueError:
            self.skipTest("This Git version does not support SHA-256 repositories")
        (repo / "first").write_text("first\n")
        snapshot = capture(repo)
        self.assertEqual(snapshot["objectFormat"], "sha256")
        self.assertEqual(files_of(snapshot)["first"]["status"], "A")
        thin = capture(repo, omit_source=True)
        self.assertEqual(read_snapshot_source(thin, repo, "first"), b"first\n")
        build(repo, manifest_for(thin), thin)

    def test_cli_revision_and_frozen_branch_after_movement(self):
        git(self.repo, "branch", "baseline")
        self.write("main.py", "current code\n")
        snapshot_path = self.directory / "snapshot.json"
        self.cli("capture_diff.py", "--branch", "baseline", "--output", snapshot_path)
        snapshot = load_snapshot(snapshot_path, self.repo)
        guide = self.directory / "guide.json"
        guide.write_text(json.dumps(manifest_for(snapshot)))
        page = self.directory / "tour.html"
        self.cli("build_guide.py", "--branch", "baseline", "--manifest", guide, "--output", page)
        self.commit()
        git(self.repo, "branch", "--force", "baseline", "HEAD")
        self.cli("build_guide.py", "--branch", "baseline", "--manifest", guide, "--output", page,
                 "--overwrite", success=False)
        self.cli("build_guide.py", "--branch", "baseline", "--manifest", guide, "--output", page,
                 "--snapshot", snapshot_path, "--overwrite")
        self.cli("build_guide.py", "--tag", "different", "--manifest", guide, "--output", page,
                 "--snapshot", snapshot_path, "--overwrite", success=False)
        guide.write_text("[]")
        result = self.cli("build_guide.py", "--manifest", guide, "--output", page, "--overwrite", success=False)
        self.assertIn("expected an object", result.stderr)

    def test_render_escaping_licenses_and_committed_source_identity(self):
        git(self.repo, "remote", "add", "origin", "git@github.com:owner/repo.git")
        self.write("main.py", "</script><script>throw new Error('injected')</script>\n")
        snapshot = capture(self.repo)
        manifest = manifest_for(snapshot)
        manifest["title"] = '<script>alert("title")</script>'
        data = build(self.repo, manifest, snapshot)
        page = render((SKILL / "assets/guide.html").read_text(), data)
        self.assertNotIn('<script>alert("title")</script>', page)
        self.assertIn("\\u003c/script>", page)
        self.assertIn((SKILL / "LICENSE").read_text(), page)
        self.assertIn("highlight.js", page)
        self.assertEqual(data["repositoryUrl"], "https://github.com/owner/repo")
        self.assertNotIn("main.py", data["rightCommitted"])
        self.assertIn("helper.py", data["rightCommitted"])


if __name__ == "__main__":
    unittest.main()
