"""Capture byte-faithful Git comparisons without writing to the source repository."""

import argparse
import base64
import copy
import hashlib
import json
import os
import stat
import subprocess
import tempfile
import zlib
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit


def git(repo, *args, input=None, env=None):
    # Optional Git locks are unnecessary for these read-only operations.
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    if env:
        environment.update(env)
    result = subprocess.run(["git", *args], cwd=repo, input=input,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace").strip() or "Git command failed")
    return result.stdout


def valid_path(path):
    if not isinstance(path, str) or not path or path.startswith("/") or "\0" in path:
        raise ValueError("Source paths must be repository-relative")
    if any(part in ("", ".", "..", ".git") for part in path.split("/")):
        raise ValueError("Invalid repository-relative source path")
    return path


def selectors(parser):
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--commit", help="Compare this commit with current code")
    group.add_argument("--branch", help="Compare this local or remote-tracking branch with current code")
    group.add_argument("--tag", help="Compare this tag (including annotated tags) with current code")
    parser.add_argument("--exclude", type=Path, action="append", default=[],
                        help="Exclude an artifact path or directory; repeat as needed")
    parser.add_argument("--omit-source", action="store_true",
                        help="Keep the diff without source blobs; reconstruct source from the pinned Git baseline")


def selection(args):
    for kind in ("commit", "branch", "tag"):
        if getattr(args, kind, None) is not None:
            return kind, getattr(args, kind)
    return "worktree", None


def repository(repo):
    root = Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    common = Path(git(root, "rev-parse", "--git-common-dir").decode().strip())
    common = (root / common).resolve()
    identity = hashlib.sha256(str(common).encode()).hexdigest()
    return root, identity


def resolve_base(repo, kind, ref, head):
    if kind == "worktree":
        return head
    if not ref or ref.startswith("-"):
        raise ValueError("Revision must be a nonempty Git revision, not an option")
    if kind == "branch":
        candidates = [ref] if ref.startswith(("refs/heads/", "refs/remotes/")) else [
            "refs/heads/" + ref, "refs/remotes/" + ref]
        resolved = []
        for candidate in candidates:
            try:
                git(repo, "show-ref", "--verify", candidate)
                resolved.append(git(repo, "rev-parse", "--verify", candidate + "^{commit}").decode().strip())
            except ValueError:
                pass
        if len(resolved) != 1:
            raise ValueError("Branch is missing or ambiguous; use refs/heads/… or refs/remotes/…")
        return resolved[0]
    if kind == "tag":
        ref = ref if ref.startswith("refs/tags/") else "refs/tags/" + ref
        git(repo, "show-ref", "--verify", ref)
    return git(repo, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}").decode().strip()


def tree_entries(repo, ref):
    if ref is None:
        return {}
    entries = {}
    for item in git(repo, "ls-tree", "-r", "-z", ref).split(b"\0"):
        if not item:
            continue
        metadata, path = item.split(b"\t", 1)
        mode, _, oid = metadata.decode().split()
        entries[valid_path(path.decode("utf-8"))] = {"mode": mode, "oid": oid}
    return entries


def read_blobs(repo, entries):
    oids = list(dict.fromkeys(e["oid"] for e in entries.values() if e["mode"] != "160000"))
    if not oids:
        return {}
    raw = git(repo, "cat-file", "--batch", input=("\n".join(oids) + "\n").encode())
    blobs, cursor = {}, 0
    for oid in oids:
        end = raw.index(b"\n", cursor)
        actual, kind, size = raw[cursor:end].decode().split()
        if actual != oid or kind != "blob":
            raise ValueError("Expected a source blob")
        cursor = end + 1
        size = int(size)
        blobs[oid] = raw[cursor:cursor + size]
        cursor += size + 1
    return blobs


def blob_oid(content, object_format):
    raw = b"blob " + str(len(content)).encode() + b"\0" + content
    return hashlib.new(object_format, raw).hexdigest()


def encode_entry(mode, content, contents, object_format):
    oid = blob_oid(content, object_format)
    contents.setdefault(oid, content)
    return {"mode": mode, "oid": oid}


def decode_entry(snapshot, entry):
    try:
        return zlib.decompress(base64.b64decode(snapshot["blobs"][entry["oid"]], validate=True))
    except (KeyError, zlib.error, ValueError) as error:
        raise ValueError("Missing or invalid compressed source blob") from error


def is_binary(content):
    if b"\0" in content:
        return True
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def compact_sources(left, right, contents):
    """Keep frozen text for tracing, but no unchanged binary assets or duplicate payloads."""
    for path in set(left) & set(right):
        entry = left[path]
        if entry == right[path] and entry["mode"] != "160000" and is_binary(contents[entry["oid"]]):
            del left[path]
            del right[path]
    used = {entry["oid"] for side in (left, right) for entry in side.values()
            if entry["mode"] != "160000"}
    return {oid: base64.b64encode(zlib.compress(contents[oid])).decode("ascii") for oid in sorted(used)}


def github_remote(repo):
    try:
        remote = git(repo, "config", "--get", "remote.origin.url").decode().strip()
    except ValueError:
        return None
    if remote.startswith("git@github.com:"):
        remote = "https://github.com/" + remote.split(":", 1)[1]
    if remote.startswith("ssh://git@github.com/"):
        remote = "https://github.com/" + remote.split("github.com/", 1)[1]
    parts = urlsplit(remote)
    path = parts.path.removesuffix(".git").rstrip("/")
    if parts.hostname == "github.com" and parts.scheme == "https" and len(path.strip("/").split("/")) == 2:
        return "https://github.com" + path
    return None


def excluded_paths(root, excludes):
    paths = set()
    for path in excludes:
        absolute = (root / path).resolve() if not path.is_absolute() else path.resolve()
        try:
            relative = absolute.relative_to(root).as_posix()
        except ValueError:
            continue
        if relative == ".":
            raise ValueError("Cannot exclude the entire repository")
        paths.add(valid_path(relative))
    return sorted(p for p in paths if not any(p.startswith(other + "/") for other in paths if other != p))


def is_excluded(path, exclusions):
    return any(path == item or path.startswith(item + "/") for item in exclusions)


def digest(snapshot):
    # Names/contents/modes and pinned revisions define a snapshot, not capture time.
    # Blob object IDs identify the decoded bytes, independent of compression.
    value = {key: snapshot[key] for key in ("schemaVersion", "sourceMode", "comparison", "left", "right", "repositoryName",
                                          "repositoryUrl", "objectFormat", "rightCommitted")}
    if snapshot["sourceMode"] == "project":
        value["files"] = snapshot["files"]
    value["comparison"] = {k: v for k, v in value["comparison"].items() if k != "fingerprint"}
    return hashlib.sha256(json.dumps(value, ensure_ascii=True, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def capture(repo, kind="worktree", ref=None, excludes=(), omit_source=False):
    root, identity = repository(repo)
    try:
        head = git(root, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    except ValueError:
        head = None
    base = resolve_base(root, kind, ref, head)
    excluded = excluded_paths(root, excludes)
    object_format = git(root, "rev-parse", "--show-object-format").decode().strip()
    before, committed = tree_entries(root, base), tree_entries(root, head)
    contents = read_blobs(root, {**before, **{f"head:{p}": e for p, e in committed.items()}})
    index = {}
    for item in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not item:
            continue
        metadata, path = item.split(b"\t", 1)
        mode, oid, stage = metadata.decode().split()
        if stage != "0":
            raise ValueError("Resolve unmerged index entries before capturing a tour")
        index[valid_path(path.decode("utf-8"))] = {"mode": mode, "oid": oid}
    untracked_raw = [p.decode("utf-8") for p in
                     git(root, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0") if p]
    nested_repos = {valid_path(p[:-1]) for p in untracked_raw if p.endswith("/")}
    untracked = {valid_path(p.rstrip("/")) for p in untracked_raw}
    left, right = {}, {}
    for path, entry in before.items():
        if not is_excluded(path, excluded):
            left[path] = dict(entry)
    try:
        filemode = git(root, "config", "--get", "core.filemode").strip() != b"false"
    except ValueError:
        filemode = True
    for path in sorted(set(committed) | set(index) | untracked):
        if is_excluded(path, excluded):
            continue
        target = root / path
        # A tracked parent replaced by a symlink must not expose external files.
        if any(parent.is_symlink() for parent in target.parents if parent != root and root in parent.parents):
            continue
        known = index.get(path, committed.get(path, {}))
        if known.get("mode") == "160000" and target.is_dir() and not target.is_symlink():
            oid = known["oid"]
            try:
                subroot = Path(git(target, "rev-parse", "--show-toplevel").decode().strip()).resolve()
                if subroot == target.resolve():
                    oid = git(target, "rev-parse", "HEAD").decode().strip()
            except ValueError:
                pass
            # An uninitialized submodule retains the index's gitlink.
            right[path] = {"mode": "160000", "oid": oid}
            continue
        try:
            info = target.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            right[path] = encode_entry("120000", os.fsencode(os.readlink(target)), contents, object_format)
        elif stat.S_ISREG(info.st_mode):
            mode = "100755" if info.st_mode & 0o111 else "100644"
            if not filemode and known.get("mode") in ("100644", "100755"):
                mode = known["mode"]
            right[path] = encode_entry(mode, target.read_bytes(), contents, object_format)
        elif stat.S_ISDIR(info.st_mode) and path in nested_repos:
            try:
                oid = git(target, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
            except ValueError as error:
                raise ValueError(f"Nested repository {path} has no HEAD; exclude it or create its first commit") from error
            right[path] = {"mode": "160000", "oid": oid}
        elif not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"Unsupported special file: {path}")
    blobs = compact_sources(left, right, contents)
    right_committed = sorted(path for path, entry in right.items() if entry == committed.get(path))
    snapshot = {"schemaVersion": 3, "sourceMode": "embedded", "repositoryName": root.name, "repositoryUrl": github_remote(root),
                "objectFormat": object_format,
                "comparison": {"kind": kind, "ref": ref, "base": base, "head": head,
                               "repositoryId": identity, "excluded": excluded},
                "left": left, "right": right, "blobs": blobs, "rightCommitted": right_committed}
    snapshot["comparison"]["fingerprint"] = digest(snapshot)
    return omit_sources(snapshot) if omit_source else snapshot


def omit_sources(snapshot):
    from build_guide import changed_files
    with snapshot_trees(snapshot) as (repo, left, right):
        files = changed_files(repo, left, right)
    result = copy.deepcopy(snapshot)
    result.update(sourceMode="project", files=strip_gaps(files))
    result.pop("blobs", None)
    result["comparison"]["fingerprint"] = digest(result)
    return result


def strip_gaps(files):
    files = copy.deepcopy(files)
    for file in files.values():
        for row in file["rows"]:
            if row["kind"] == "gap" and "lines" in row:
                lines = row.pop("lines")
                row.update(oldStart=lines[0]["old"], newStart=lines[0]["new"], count=len(lines))
                links = {str(line["new"]): line["links"] for line in lines if line.get("links")}
                if links:
                    row["links"] = links
    return files


def check_baseline(repo, snapshot):
    base = snapshot["comparison"]["base"]
    if base is not None:
        try:
            git(repo, "cat-file", "-e", base + "^{commit}")
        except ValueError as error:
            raise ValueError(f"Baseline commit {base} is unavailable") from error


def baseline_source(repo, snapshot, path):
    check_baseline(repo, snapshot)
    base = snapshot["comparison"]["base"]
    if base is None:
        return b""
    return git(repo, "show", f"{base}:{valid_path(path)}")


def reconstruct_source(file, before):
    if file.get("notice"):
        raise ValueError("Text source is unavailable for this file")
    text = before.decode("utf-8")
    old = text.split("\n") if text else []
    if text.endswith("\n"):
        old.pop()
    result, cursor = [], 0
    for row in file["rows"]:
        kind = row["kind"]
        if kind == "hunk":
            continue
        if kind == "gap":
            start = row.get("oldStart", row.get("lines", [{}])[0].get("old"))
            new = row.get("newStart", row.get("lines", [{}])[0].get("new"))
            count = row.get("count", len(row.get("lines", [])))
            if start != cursor + 1 or new != len(result) + 1 or count < 1 or cursor + count > len(old):
                raise ValueError("Invalid unchanged source range")
            result.extend(old[cursor:cursor + count])
            cursor += count
            continue
        if kind not in ("context", "del", "add"):
            raise ValueError("Invalid diff row")
        if kind != "add":
            if row["old"] != cursor + 1 or cursor >= len(old) or row["text"] != old[cursor]:
                raise ValueError("Diff does not match baseline source")
            cursor += 1
        if kind != "del":
            if row["new"] != len(result) + 1:
                raise ValueError("Invalid current source numbering")
            result.append(row["text"])
    if cursor != len(old) or len(old) != file["oldLineCount"] or len(result) != file["lineCount"]:
        raise ValueError("Incomplete source reconstruction")
    return ("\n".join(result) + ("\n" if file["newEndsWithNewline"] else "")).encode("utf-8")


def read_snapshot_source(snapshot, repo, path, side="right"):
    path = valid_path(path)
    if side not in ("left", "right"):
        raise ValueError("Invalid source side")
    entry = snapshot[side][path]
    if entry["mode"] == "160000":
        raise ValueError("Submodule gitlink; no text source")
    if snapshot["sourceMode"] == "embedded":
        content = decode_entry(snapshot, entry)
    else:
        check_baseline(repo, snapshot)
        file = snapshot["files"].get(path) if side == "right" else None
        if file:
            before = b"" if file["oldMode"] == "000000" else baseline_source(repo, snapshot, file["oldPath"])
            content = reconstruct_source(file, before)
        else:
            content = baseline_source(repo, snapshot, path)
    if blob_oid(content, snapshot["objectFormat"]) != entry["oid"]:
        raise ValueError("Source blob does not match its object ID")
    return content


def restore_sources(snapshot, repo):
    """Transient reconstruction for building; never write reconstructed blobs to artifacts."""
    if snapshot["sourceMode"] == "embedded":
        return snapshot
    result = copy.deepcopy(snapshot)
    check_baseline(repo, snapshot)
    actual = tree_entries(repo, snapshot["comparison"]["base"])
    if any(entry != actual.get(path) for path, entry in snapshot["left"].items()):
        raise ValueError("Baseline source does not match its captured object IDs")
    baseline = read_blobs(repo, snapshot["left"])
    contents = {}
    for side in ("left", "right"):
        for path, entry in list(result[side].items()):
            if entry["mode"] == "160000":
                continue
            file = snapshot["files"].get(path)
            if file and file.get("notice"):
                del result[side][path]
                continue
            if side == "left":
                content = baseline[entry["oid"]]
            elif file:
                before = b"" if file["oldMode"] == "000000" else baseline[snapshot["left"][file["oldPath"]]["oid"]]
                content = reconstruct_source(file, before)
            else:
                content = baseline[entry["oid"]]
            if blob_oid(content, snapshot["objectFormat"]) != entry["oid"]:
                raise ValueError("Source blob does not match its object ID")
            if is_binary(content):
                del result[side][path]
                continue
            contents[entry["oid"]] = content
    result.update(sourceMode="embedded", blobs=compact_sources(result["left"], result["right"], contents))
    return result


def load_snapshot(path, repo):
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    if snapshot.get("schemaVersion") != 3 or snapshot.get("sourceMode") not in ("embedded", "project") or snapshot.get("objectFormat") not in ("sha1", "sha256"):
        raise ValueError("Unsupported snapshot format")
    if snapshot["comparison"]["repositoryId"] != repository(repo)[1]:
        raise ValueError("Snapshot belongs to a different repository")
    expected = 40 if snapshot["objectFormat"] == "sha1" else 64
    referenced = set()
    for side in ("left", "right"):
        for path, entry in snapshot[side].items():
            valid_path(path)
            if entry["mode"] not in ("100644", "100755", "120000", "160000"):
                raise ValueError("Unsupported source mode")
            oid = entry["oid"]
            if len(oid) != expected or any(c not in "0123456789abcdef" for c in oid):
                raise ValueError("Invalid source object ID")
            if entry["mode"] != "160000":
                referenced.add(oid)
    if snapshot["sourceMode"] == "project":
        if "blobs" in snapshot or not isinstance(snapshot.get("files"), dict):
            raise ValueError("Invalid source-free snapshot")
    elif set(snapshot["blobs"]) != referenced:
        raise ValueError("Snapshot source blobs do not match tree references")
    for oid in referenced if snapshot["sourceMode"] == "embedded" else ():
        content = decode_entry(snapshot, {"oid": oid})
        if blob_oid(content, snapshot["objectFormat"]) != oid:
            raise ValueError("Source blob does not match its object ID")
    if snapshot["comparison"]["fingerprint"] != digest(snapshot):
        raise ValueError("Snapshot fingerprint does not match its contents")
    return snapshot


@contextmanager
def snapshot_trees(snapshot):
    """Materialize only in a private object database; no filters/hooks or source index writes."""
    with tempfile.TemporaryDirectory(prefix="codex-deck-diff-git-") as directory:
        repo = Path(directory)
        environment = private_git_env()
        subprocess.run(["git", "init", "--quiet", "--object-format=" + snapshot["objectFormat"], str(repo)],
                       env=environment, check=True, capture_output=True)
        objects = repo / ".git/objects"
        trees = []
        for side in ("left", "right"):
            records = []
            for path, entry in sorted(snapshot[side].items()):
                oid = entry["oid"]
                if entry["mode"] != "160000":
                    target = objects / oid[:2] / oid[2:]
                    if not target.exists():
                        content = decode_entry(snapshot, entry)
                        raw = b"blob " + str(len(content)).encode() + b"\0" + content
                        if hashlib.new(snapshot["objectFormat"], raw).hexdigest() != oid:
                            raise ValueError("Source blob does not match its object ID")
                        target.parent.mkdir(exist_ok=True)
                        target.write_bytes(zlib.compress(raw))
                records.append(f'{entry["mode"]} {oid}\t{path}'.encode() + b"\0")
            index_env = dict(environment, GIT_INDEX_FILE=str(repo / (side + ".index")))
            for arguments, content in ((["read-tree", "--empty"], None),
                                       (["update-index", "-z", "--index-info"], b"".join(records))):
                result = subprocess.run(["git", *arguments], cwd=repo, env=index_env,
                                        input=content, capture_output=True)
                if result.returncode:
                    raise ValueError(result.stderr.decode(errors="replace"))
            result = subprocess.run(["git", "write-tree"], cwd=repo, env=index_env, capture_output=True)
            if result.returncode:
                raise ValueError(result.stderr.decode(errors="replace"))
            trees.append(result.stdout.decode().strip())
        yield repo, trees[0], trees[1]


def private_git_env():
    environment = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_TEMPLATE_DIR="", GIT_OPTIONAL_LOCKS="0")
    return environment
