#!/usr/bin/env python3
"""Build a standalone reading guide for local Git changes and authored guide.json notes."""

import argparse
import copy
import html
import io
import json
import re
import subprocess
import tempfile
import tokenize
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

from git_snapshot import capture, load_snapshot, private_git_env, selection, selectors, snapshot_trees


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--overwrite', action='store_true', help='Update this existing guide intentionally')
    parser.add_argument('--language', choices=('ko', 'en'), help='Override the manifest UI language')
    parser.add_argument('--snapshot', type=Path, help='Use captured source contents instead of recapturing current code')
    selectors(parser)
    args = parser.parse_args()
    if args.output.exists() and not args.overwrite:
        parser.error('Output exists; choose another filename or use --overwrite for an intentional update.')
    try:
        manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
        require(isinstance(manifest, dict), 'manifest: expected an object')
        if args.language:
            require(isinstance(manifest, dict), 'manifest: expected an object')
            manifest['language'] = args.language
        validate_manifest(manifest)
        if args.snapshot:
            require(not args.exclude, '--exclude applies during capture; recapture to change exclusions')
            snapshot = load_snapshot(args.snapshot, args.repo)
            kind, ref = selection(args)
            if kind != 'worktree':
                require((kind, ref) == (snapshot['comparison']['kind'], snapshot['comparison']['ref']),
                        'Revision selector does not match the captured comparison')
        else:
            excludes = [Path(p) for p in manifest.get('comparison', {}).get('excluded', [])]
            snapshot = capture(args.repo, *selection(args),
                               excludes=[*excludes, *args.exclude, args.manifest.absolute(), args.output.absolute()])
        data = build(args.repo.resolve(), manifest, snapshot)
        template = (Path(__file__).resolve().parents[1] / 'assets/guide.html').read_text(encoding='utf-8')
        page = render(template, data)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('w' if args.overwrite else 'x', encoding='utf-8') as target:
            target.write(page)
        print(json.dumps({'path': str(args.output.resolve()), 'comparison': data['comparison'],
                          'files': len(data['files']), 'steps': len(data['steps']),
                          'definitions': len(data['definitions']), 'bytes': len(page.encode()),
                          'unavailable': [p for p, f in data['files'].items() if f.get('notice')],
                          'transitions': data['transitionSummary'],
                          'warnings': data['warnings'],
                          'source_lines_verified': True}, ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Guide build failed: {error}\n')


def build(repo, manifest, snapshot=None):
    validate_manifest(manifest)
    if snapshot is None:
        snapshot = capture(repo, excludes=[Path(p) for p in manifest['comparison'].get('excluded', [])])
    require(manifest['comparison'] == snapshot['comparison'],
            'Manifest comparison does not match source snapshot; recapture and reauthor, or use --snapshot')
    with snapshot_trees(snapshot) as (private_repo, left, right):
        return build_snapshot(private_repo, manifest, snapshot, left, right)


def build_snapshot(repo, manifest, snapshot, base, head):
    manifest = copy.deepcopy(manifest)
    # The supplied revision is the baseline itself, never its merge base.
    merge = base
    files = changed_files(repo, merge, head)
    require(files, 'This snapshot has no changed files.')
    definitions = {}
    for key, spec in manifest.get('definitions', {}).items():
        side = spec.get('side', 'right')
        require(side in ('left', 'right'), f'{key}: invalid definition side')
        lines = source(repo, merge if side == 'left' else head, spec['path'])
        check_range(spec, len(lines), f'definition {key}')
        definitions[key] = dict(spec, name=spec.get('name', key), qualified=spec.get('name', key), side=side,
                                rows=[dict(text=lines[i-1], new=i) for i in range(spec['start'], spec['end']+1)])
        require(spec.get('description'), f'{key}: write a short definition description')
    links = collect_links(repo, head, manifest, definitions)
    for path, file in files.items():
        for row in flatten(file['rows']):
            if row.get('new') is not None:
                row['links'] = links.get((path, row['new']), [])
    for definition in definitions.values():
        for row in definition['rows']:
            if definition['side'] == 'right':
                row['links'] = links.get((definition['path'], row['new']), [])
    steps = manifest['steps']
    require(steps, 'Write at least one reading step.')
    ids = set()
    for step in steps:
        require(re.fullmatch(r'[a-z0-9][a-z0-9-]*', step['id']) and step['id'] not in ids,
                'Each step needs a unique lowercase hash id.')
        ids.add(step['id'])
        for field in ('group', 'title', 'heading', 'why', 'check', 'next'):
            require(isinstance(step[field], str) and step[field], f'{step["id"]}: missing {field}')
        require(step['file'] in files, f'{step["id"]}: file is not in this diff')
        step.setdefault('notes', [])
        file = files[step['file']]
        for note in step['notes']:
            side = note.get('side', 'left' if file['status'] == 'D' else 'right')
            require(side in ('left', 'right'), f'{step["id"]}: invalid note side')
            note['side'] = side
            column = 'old' if side == 'left' else 'new'
            present = {r.get(column) for r in file['rows'] if r['kind'] not in ('gap', 'hunk')}
            check_range(note, file['oldLineCount'] if side == 'left' else file['lineCount'], step['id'])
            require(all(i in present for i in range(note['start'], note['end']+1)),
                    f'{step["id"]}: note must point to visible diff lines; use a definition/reference for omitted code')
            require(note.get('title') and note.get('text'), f'{step["id"]}: missing note text')
        if 'reference' in step:
            ref = step['reference']
            ref.setdefault('side', 'right')
            require(ref['side'] in ('left', 'right'), 'Invalid reference side')
            lines = source(repo, merge if ref['side'] == 'left' else head, ref['path'])
            check_range(ref, len(lines), 'reference')
            ref['code'] = '\n'.join(f'{i}  {lines[i-1]}' for i in range(ref['start'], ref['end']+1))
        if step.get('finding'):
            require(urlsplit(step['finding']['url']).scheme == 'https', 'Review link must use HTTPS')
    require({s['file'] for s in steps} == set(files),
            'Every changed file needs a reading step, including deleted, binary, and metadata-only files.')
    transitions, warnings = build_transitions(repo, steps, head, merge)
    language = manifest.get('language', 'en')
    if language == 'en':
        for file in files.values():
            for key in ('notice', 'changeNote'):
                if key in file:
                    file[key] = localize(file[key], language)
            for row in file['rows']:
                if row['kind'] == 'hunk' and row['text'].startswith('\\ '):
                    row['text'] = localize(row['text'], language)
    comparison = snapshot['comparison']
    baseline = comparison['ref'] or ('HEAD' if comparison['base'] else 'empty tree')
    requested = {'left': set(), 'right': set()}
    for path, file in files.items():
        requested['left'].add(file['oldPath'])
        requested['right'].add(path)
    for spec in [*manifest.get('definitions', {}).values(),
                 *(s['reference'] for s in steps if 'reference' in s),
                 *(ref for s in steps for ref in s.get('transition', {}).get('evidence', []))]:
        requested[spec.get('side', 'right')].add(spec['path'])
    sources = {'left': {}, 'right': {}}
    from git_snapshot import decode_entry
    for side, paths in requested.items():
        for path in paths:
            entry = snapshot[side].get(path)
            if entry and entry['mode'] != '160000':
                content = decode_entry(snapshot, entry)
                try:
                    if b'\0' not in content:
                        sources[side][path] = code_lines(content.decode('utf-8'))
                except UnicodeDecodeError:
                    pass
    return dict(schemaVersion=1, language=language, attribution=manifest.get('attribution'),
                repositoryUrl=snapshot.get('repositoryUrl'), repositoryName=snapshot['repositoryName'],
                comparison=comparison, comparisonLabel=f'{baseline} → current code',
                rightCommitted=snapshot['rightCommitted'], sources=sources,
                title=manifest['title'], overview=manifest.get('overview', localize('변경된 코드의 역할과 연결을 따라 읽습니다.', language)),
                date=manifest.get('date', date.today().isoformat()),
                files=files, steps=steps, definitions=definitions,
                transitionSummary=transitions, warnings=warnings,
                added=sum(f['added'] or 0 for f in files.values()),
                removed=sum(f['removed'] or 0 for f in files.values()))


def validate_manifest(manifest):
    """Reject malformed authored data before it can break the standalone viewer."""
    def obj(value, label):
        require(isinstance(value, dict), f'{label}: expected an object')

    def string(value, label):
        require(isinstance(value, str) and value.strip(), f'{label}: expected a nonempty string')

    def fields(value, names, label):
        obj(value, label)
        for name in names:
            string(value.get(name), f'{label}.{name}')

    def array(value, label):
        require(isinstance(value, list), f'{label}: expected an array')

    def location(value, label):
        fields(value, ('path',), label)
        require(type(value.get('start')) is int and type(value.get('end')) is int,
                f'{label}: start and end must be integers')

    fields(manifest, ('title',), 'manifest')
    obj(manifest.get('comparison'), 'comparison')
    fields(manifest['comparison'], ('fingerprint', 'repositoryId', 'kind'), 'comparison')
    require(manifest.get('language', 'en') in ('ko', 'en'), 'language must be ko or en')
    if 'attribution' in manifest:
        fields(manifest['attribution'], ('title', 'text', 'url'), 'attribution')
        require(urlsplit(manifest['attribution']['url']).scheme == 'https', 'Attribution URL must use HTTPS')
    for name in ('overview', 'date'):
        if name in manifest:
            string(manifest[name], name)
    if 'date' in manifest:
        date.fromisoformat(manifest['date'])
    steps = manifest.get('steps')
    array(steps, 'steps')
    for index, step in enumerate(steps):
        label = f'steps[{index}]'
        fields(step, ('id', 'file', 'group', 'title', 'heading', 'why', 'check', 'next'), label)
        notes = step.get('notes', [])
        array(notes, f'{label}.notes')
        for number, note in enumerate(notes):
            fields(note, ('title', 'text'), f'{label}.notes[{number}]')
        if 'reference' in step:
            fields(step['reference'], ('label', 'text'), f'{label}.reference')
            location(step['reference'], f'{label}.reference')
        if 'transition' in step:
            transition = step['transition']
            target = f'{label}.transition'
            fields(transition, ('to', 'basis'), target)
            require(set(transition) <= {'to', 'basis', 'evidence', 'uncertainty'},
                    f'{target}: unknown field')
            require(index + 1 < len(steps), f'{target}: the final step cannot have a transition')
            require(isinstance(steps[index + 1], dict) and transition['to'] == steps[index + 1].get('id'),
                    f'{target}: to must match the next reading step')
            require(transition['basis'] in ('source', 'inferred', 'reading'), f'{target}: invalid basis')
            if transition['basis'] == 'inferred':
                string(transition.get('uncertainty'), f'{target}.uncertainty')
            else:
                require('uncertainty' not in transition,
                        f'{target}: use inferred when the connection has uncertainty')
            evidence = transition.get('evidence', [])
            array(evidence, f'{target}.evidence')
            require(transition['basis'] != 'source' or evidence,
                    f'{target}: source requires at least one evidence range')
            for number, ref in enumerate(evidence):
                evidence_label = f'{target}.evidence[{number}]'
                fields(ref, ('text', 'side'), evidence_label)
                location(ref, evidence_label)
                require(set(ref) <= {'path', 'side', 'start', 'end', 'text'},
                        f'{evidence_label}: author ranges, not source code or URLs')
                require(ref['side'] in ('left', 'right'), f'{evidence_label}: invalid side')
        if 'recap' in step:
            array(step['recap'], f'{label}.recap')
            for item in step['recap']:
                string(item, f'{label}.recap item')
        if 'finding' in step:
            fields(step['finding'], ('title', 'body', 'fix', 'url'), f'{label}.finding')
            if 'label' in step['finding']:
                string(step['finding']['label'], f'{label}.finding.label')
    definitions = manifest.get('definitions', {})
    obj(definitions, 'definitions')
    for key, definition in definitions.items():
        string(key, 'definition id')
        location(definition, f'definitions.{key}')
        fields(definition, ('description',), f'definitions.{key}')
        if 'name' in definition:
            string(definition['name'], f'definitions.{key}.name')
    mappings = manifest.get('pythonSymbols', {})
    obj(mappings, 'pythonSymbols')
    for path, mapping in mappings.items():
        string(path, 'pythonSymbols path')
        obj(mapping, f'pythonSymbols.{path}')
        for name, target in mapping.items():
            string(name, 'local identifier')
            string(target, 'definition id')
            require(target in definitions, f'Unknown definition {target}')
    links = manifest.get('links', [])
    array(links, 'links')
    for index, link in enumerate(links):
        label = f'links[{index}]'
        fields(link, ('path', 'text', 'definition'), label)
        require(type(link.get('line')) is int, f'{label}.line: expected an integer')
        if 'column' in link:
            require(type(link['column']) is int, f'{label}.column: expected an integer')


def build_transitions(repo, steps, head, merge):
    """Verify citations, not the author's interpretation of their relationship."""
    summary = dict(enabled=any('transition' in step for step in steps),
                   total=max(0, len(steps) - 1), source=0, inferred=0, reading=0, missing=0)
    warnings = []
    sources = {}
    for index, step in enumerate(steps[:-1]):
        transition = step.get('transition')
        if transition is None:
            summary['missing'] += 1
            if summary['enabled']:
                warnings.append(f'{step["id"]} -> {steps[index + 1]["id"]}: transition evidence not authored')
            continue
        summary[transition['basis']] += 1
        for ref in transition.setdefault('evidence', []):
            key = (ref['path'], ref['side'])
            if key not in sources:
                snapshot = merge if ref['side'] == 'left' else head
                require(git(repo, 'cat-file', '-t', f'{snapshot}:{ref["path"]}').strip() == b'blob',
                        'Transition evidence must reference a file blob, not a directory or submodule')
                sources[key] = source(repo, snapshot, ref['path'])
                require(not any('\0' in line for line in sources[key]), 'Transition evidence must be text source')
            lines = sources[key]
            check_range(ref, len(lines), f'{step["id"]} transition evidence')
            ref['rows'] = [dict(line=i, text=lines[i-1]) for i in range(ref['start'], ref['end']+1)]
    return summary, warnings


def changed_files(repo, base, head):
    entries = git(repo, 'diff', '--raw', '-z', '--no-abbrev', '--find-renames',
                  '--ignore-submodules=none', base, head).split(b'\0')
    files = {}
    cursor = 0
    while cursor < len(entries)-1:
        metadata = entries[cursor].decode().split()
        cursor += 1
        old_path = entries[cursor].decode('utf-8')
        cursor += 1
        old_mode, new_mode, old_oid, new_oid, status = metadata
        path = old_path
        if status.startswith(('R', 'C')):
            path = entries[cursor].decode('utf-8')
            cursor += 1
        file = dict(path=path, oldPath=old_path, status=status[0], rows=[], added=0, removed=0,
                    lineCount=0, oldLineCount=0, oldMode=old_mode.lstrip(':'), newMode=new_mode)
        files[path] = file
        if '160000' in (old_mode.lstrip(':'), new_mode):
            file['notice'] = f'서브모듈 참조 변경 · {old_oid[:8]} → {new_oid[:8]}'
            continue
        before = b'' if set(old_oid) == {'0'} else git(repo, 'cat-file', 'blob', old_oid)
        after = b'' if set(new_oid) == {'0'} else git(repo, 'cat-file', 'blob', new_oid)
        try:
            require(b'\0' not in before + after, 'binary')
            old = code_lines(before.decode('utf-8'))
            new = code_lines(after.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            file.update(notice='Binary or non-UTF-8 file; a text preview is unavailable.', added=None, removed=None)
            continue
        file['lineCount'], file['oldLineCount'] = len(new), len(old)
        with tempfile.TemporaryDirectory(prefix='codex-deck-diff-') as directory:
            a, b = Path(directory)/'before', Path(directory)/'after'
            a.write_bytes(before)
            b.write_bytes(after)
            result = subprocess.run(['git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv',
                                     '--no-color', '--unified=3', '--', str(a), str(b)],
                                    cwd=repo, capture_output=True, env=private_git_env())
            require(result.returncode in (0, 1), result.stderr.decode(errors='replace'))
        rows = parse_patch(result.stdout.decode('utf-8'))
        file['added'] = sum(r['kind'] == 'add' for r in rows)
        file['removed'] = sum(r['kind'] == 'del' for r in rows)
        file['rows'] = with_gaps(rows, old, new)
        for key, expected in (('old', old), ('new', new)):
            actual = [r for r in flatten(file['rows']) if r.get(key) is not None]
            require([r[key] for r in actual] == list(range(1, len(expected)+1)), f'{path}: invalid {key} numbering')
            require([r['text'] for r in actual] == expected, f'{path}: {key} source mismatch')
        if before == after:
            file['changeNote'] = ('빈 파일이 추가되었습니다.' if file['status'] == 'A' else
                                  '빈 파일이 삭제되었습니다.' if file['status'] == 'D' else
                                  '이름·경로 또는 파일 속성이 바뀌었습니다. 코드 내용은 같습니다.')
        elif '120000' in (old_mode.lstrip(':'), new_mode):
            file['changeNote'] = 'Symbolic link target; the linked file is not read.'
    return files


def parse_patch(patch):
    rows = []
    old = new = 0
    in_hunk = False
    for line in code_lines(patch):
        if line.startswith('@@ '):
            match = re.match(r'@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@', line)
            require(match, 'Unrecognized hunk header')
            old, new = int(match[1]), int(match[2])
            rows.append(dict(kind='hunk', text=line, old=None, new=None))
            in_hunk = True
        elif in_hunk and line[:1] in (' ', '+', '-'):
            sign = line[0]
            rows.append(dict(kind={' ': 'context', '+': 'add', '-': 'del'}[sign], text=line[1:],
                             old=old if sign != '+' else None, new=new if sign != '-' else None))
            old += sign != '+'
            new += sign != '-'
        elif in_hunk and line.startswith('\\ No newline'):
            rows.append(dict(kind='hunk', text='\\ 파일 끝에 줄바꿈 없음', old=None, new=None))
    return rows


def with_gaps(rows, old, new):
    complete = []
    old_cursor = new_cursor = 1

    def gap(old_end, new_end):
        nonlocal old_cursor, new_cursor
        require(old_end-old_cursor == new_end-new_cursor and old_end >= old_cursor, 'Unaligned unchanged code')
        if new_end == new_cursor:
            return
        lines = []
        while new_cursor < new_end:
            require(old[old_cursor-1] == new[new_cursor-1], 'Gap contains changed code')
            lines.append(dict(kind='context', text=new[new_cursor-1], old=old_cursor, new=new_cursor))
            old_cursor += 1
            new_cursor += 1
        complete.append(dict(kind='gap', id=str(lines[0]['new']), lines=lines))

    for row in rows:
        if row['kind'] == 'hunk':
            if row['text'].startswith('@@ '):
                match = re.match(r'@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@', row['text'])
                gap(max(1, int(match[1])), max(1, int(match[2])))
        else:
            if row['old'] is not None:
                require(row['old'] == old_cursor, 'Invalid old diff line')
                old_cursor += 1
            if row['new'] is not None:
                require(row['new'] == new_cursor, 'Invalid new diff line')
                new_cursor += 1
        complete.append(row)
    gap(len(old)+1, len(new)+1)
    return complete


def flatten(rows):
    return [line for row in rows for line in (row['lines'] if row['kind'] == 'gap' else [row])]


def collect_links(repo, head, manifest, definitions):
    links = {}
    for path, mapping in manifest.get('pythonSymbols', {}).items():
        lines = source(repo, head, path)
        try:
            for token in tokenize.generate_tokens(io.StringIO('\n'.join(lines)).readline):
                if token.type == tokenize.NAME and token.string in mapping:
                    append_link(links, definitions, path, lines, token.start[0], token.string,
                                mapping[token.string], token.start[1])
        except (tokenize.TokenError, IndentationError, SyntaxError) as error:
            raise ValueError(f'{path}: Python tokenization failed; use a compatible Python or explicit links: {error}') from error
    for spec in manifest.get('links', []):
        lines = source(repo, head, spec['path'])
        require(1 <= spec['line'] <= len(lines), 'Definition link line is out of range')
        text = lines[spec['line']-1]
        column = spec.get('column')
        if column is None:
            require(text.count(spec['text']) == 1, 'Ambiguous link occurrence; specify zero-based column')
            column = text.index(spec['text'])
        append_link(links, definitions, spec['path'], lines, spec['line'], spec['text'], spec['definition'], column)
    for occurrences in links.values():
        occurrences.sort(key=lambda item: item['start'])
        require(all(a['end'] <= b['start'] for a, b in zip(occurrences, occurrences[1:])), 'Overlapping definition links')
    return links


def append_link(links, definitions, path, lines, line, text, definition, column):
    require(definition in definitions, f'Unknown definition {definition}')
    require(text and column >= 0 and lines[line-1][column:column+len(text)] == text, f'{path}:{line}: link text mismatch')
    # Browser slice offsets count UTF-16 units; Python columns count Unicode code points.
    start = len(lines[line-1][:column].encode('utf-16-le'))//2
    end = start + len(text.encode('utf-16-le'))//2
    links.setdefault((path, line), []).append(dict(start=start, end=end, name=definition))


def source(repo, ref, path):
    require(isinstance(path, str) and path and not path.startswith('/') and '..' not in Path(path).parts,
            'Source paths must be repository-relative')
    return code_lines(git(repo, 'show', f'{ref}:{path}').decode('utf-8'))


def code_lines(text):
    if not text:
        return []
    lines = text.split('\n')
    return lines[:-1] if lines[-1] == '' else lines


def check_range(spec, length, label):
    require(type(spec.get('start')) is int and type(spec.get('end')) is int and
            1 <= spec['start'] <= spec['end'] <= length, f'{label}: source range is out of bounds')


def render(template, data):
    assets = Path(__file__).resolve().parents[1] / 'assets'
    template = template.replace('__REVIEW_CSS__', (assets / 'review.css').read_text(encoding='utf-8'))
    template = template.replace('__TRANSITION_CSS__', (assets / 'transitions.css').read_text(encoding='utf-8'))
    template = template.replace('__LAYOUT_CSS__', (assets / 'layout.css').read_text(encoding='utf-8'))
    template = template.replace('__SPLIT_CSS__', (assets / 'split.css').read_text(encoding='utf-8'))
    template = template.replace('__THEME_CSS__', (assets / 'theme.css').read_text(encoding='utf-8'))
    template = localize(template, data.get('language', 'en'))
    template = template.replace('<html lang="ko">', f'<html lang="{data.get("language", "en")}">')
    values = {'GUIDE_TITLE': data['title'], 'REPOSITORY_NAME': data['repositoryName'],
              'SHORT_SNAPSHOT': data['comparison']['fingerprint'][:8], 'COMPARISON_LABEL': data['comparisonLabel'],
              'DATE': data['date'], 'TOTAL_FILES': len(data['files']),
              'ADDITIONS': data['added'], 'DELETIONS': data['removed'], 'STEP_COUNT': len(data['steps']),
              'OVERVIEW': data['overview']}
    require(template.count('__GUIDE_DATA__') == 1, 'Missing template data slot')
    for key, value in values.items():
        template = template.replace(f'__{key}__', html.escape(str(value), quote=True))
    require(template.count('__SYNTAX_ASSETS__') == 1, 'Missing syntax asset slot')
    require(not re.search(r'__[A-Z_]+__', template.replace('__GUIDE_DATA__', '').replace('__SYNTAX_ASSETS__', '')),
            'Unresolved template token')
    license_text = (assets / 'vendor/highlightjs/LICENSE').read_text(encoding='utf-8')
    scripts = '\n'.join((assets / name).read_text(encoding='utf-8') for name in
                        ['vendor/highlightjs/highlight.min.js', 'syntax.js'])
    # Bundle pinned local assets and their license; viewing never needs a CDN.
    reviews = localize((assets / 'review.js').read_text(encoding='utf-8'), data.get('language', 'en'))
    transitions = localize((assets / 'transitions.js').read_text(encoding='utf-8'), data.get('language', 'en'))
    layout = localize((assets / 'layout.js').read_text(encoding='utf-8'), data.get('language', 'en'))
    bundled = f'/* highlight.js 11.12.0\n{license_text}*/\n{scripts}\n{reviews}\n{transitions}\n{layout}'
    bundled = re.sub(r'</script', r'<\\/script', bundled, flags=re.IGNORECASE)
    template = template.replace('__SYNTAX_ASSETS__', bundled)
    license_text = (assets.parent / 'LICENSE').read_text(encoding='utf-8')
    page = template.replace('__GUIDE_DATA__', json.dumps(data, ensure_ascii=False).replace('<', '\\u003c'))
    return page.replace('</body>', '<!-- Renderer license\n' + license_text + '-->\n</body>')


def localize(text, language):
    """Translate only renderer-owned text, before inserting user content or source code."""
    if language == 'ko':
        return text
    path = Path(__file__).resolve().parents[1] / 'assets/locales' / f'{language}.json'
    translations = json.loads(path.read_text(encoding='utf-8'))
    pattern = '|'.join(re.escape(key) for key in sorted(translations, key=len, reverse=True))
    return re.sub(pattern, lambda match: translations[match[0]], text)


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, stderr=subprocess.PIPE, env=private_git_env())


def require(condition, message):
    if not condition:
        raise ValueError(message)


if __name__ == '__main__':
    main()
