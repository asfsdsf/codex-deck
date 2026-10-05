/* Reader comments are local to a repository snapshot, never part of the source manifest. */
const TourReview = (() => {
  'use strict';
  function init({data, currentFile, showCode, reveal, sourceUrl}) {
    const el = id => document.getElementById(id);
    const dialog = el('review-dialog');
    const key = 'codex-deck-diff.review.v1:' + JSON.stringify([data.comparison.repositoryId, data.comparison.fingerprint]);
    const sources = new Map();
    let comments = [], selection = null, selecting = false, draft = null, downloadUrl = '';
    let importItems = null, importRead = 0;
    const importLimit = 10 * 1024 * 1024;
    let storageState = 'loading', storedComments = [], saving = true, database = null;
    const node = (tag, text = '', cls = '') => {
      const n = document.createElement(tag);
      n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
    const button = (text, action, cls = '') => {
      const n = node('button', text, cls);
      n.type = 'button';
      n.addEventListener('click', action);
      return n;
    };
    function source(file, side) {
      const id = JSON.stringify([file, side]);
      if (!sources.has(id)) {
        const column = side === 'left' ? 'old' : 'new';
        const rows = data.files[file].rows.flatMap(row => row.kind === 'gap' ? (row.lines || []) : [row]);
        sources.set(id, new Map(rows.filter(row => Number.isInteger(row[column])).map(row => [row[column], row.text])));
      }
      return sources.get(id);
    }
    function valid(c) {
      return c && typeof c.id === 'string' && typeof c.file === 'string' && Object.hasOwn(data.files, c.file) &&
        ['left', 'right'].includes(c.side) && Number.isInteger(c.start) && Number.isInteger(c.end) &&
        c.start > 0 && c.end >= c.start && c.end <= (c.side === 'left' ? data.files[c.file].oldLineCount : data.files[c.file].lineCount) &&
        typeof c.body === 'string' && c.body.trim().length > 0 && c.body.length <= 10000 &&
        typeof c.createdAt === 'string' && typeof c.updatedAt === 'string';
    }
    function readComments(text) {
      const parsed = text === null ? [] : JSON.parse(text);
      if (!Array.isArray(parsed) || !parsed.every(valid) || new Set(parsed.map(c => c.id)).size !== parsed.length) throw new Error('invalid');
      return parsed;
    }
    function openDatabase() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('codex-deck-diff-review', 1);
        let failed = false;
        request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
        request.onerror = () => {
          failed = true;
          reject(request.error);
        };
        request.onblocked = () => { failed = true; reject(new Error('Review storage blocked')); };
        request.onsuccess = () => {
          const db = request.result;
          if (failed) { db.close(); return; }
          db.onversionchange = () => db.close();
          resolve(db);
        };
      });
    }
    function transaction(update) {
      return new Promise((resolve, reject) => {
        // The read and write must share one transaction. Web Locks alone cannot
        // make another WebKit process's localStorage cache current.
        const tx = database.transaction('snapshots', 'readwrite');
        const store = tx.objectStore('snapshots');
        let result, failure;
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && typeof request.result !== 'string') throw new Error('Invalid review record');
            result = update(request.result, store);
          }
          catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || new Error('Review transaction aborted'));
      });
    }
    async function load() {
      // A restricted viewer may still read its old comments even when opening
      // IndexedDB fails. They remain exportable; never write a fallback copy.
      try { comments = readComments(localStorage.getItem(key)); } catch {}
      try {
        database = await openDatabase();
        comments = await transaction((text, store) => {
          comments = readComments(text === undefined ? localStorage.getItem(key) : text);
          // Keep old HTML data intact. New and old viewers do not live-sync.
          if (text === undefined) store.put(JSON.stringify(comments), key);
          return comments;
        });
        storedComments = comments.slice();
        storageState = 'ready';
      } catch { storageState = 'unavailable'; }
      finally {
        saving = false; refresh();
        if (dialog.open && !el('review-list').hidden) list();
        else if (importItems) previewImport();
      }
    }

    function storageLabel() {
      el('review-storage').textContent = storageState === 'loading'
        ? '저장한 코멘트를 불러오는 중입니다.'
        : storageState === 'saved'
        ? '이 브라우저에 저장됨 · HTML 파일에는 포함되지 않습니다.'
        : storageState === 'ready'
          ? '저장한 코멘트는 이 브라우저에 보관됩니다. HTML 파일에는 포함되지 않습니다.'
          : storageState === 'conflict'
            ? '다른 탭에서 코멘트가 변경되어 저장을 중단했습니다. 현재 메모는 이 화면에만 있습니다. 먼저 JSON을 다운로드한 뒤 새로고침하세요.'
            : '브라우저 저장을 사용할 수 없습니다. 닫기 전에 JSON을 다운로드하세요.';
    }
    const sameComment = (a, b) => a === b || Boolean(a && b &&
      ['id', 'file', 'side', 'start', 'end', 'body', 'createdAt', 'updatedAt'].every(field => a[field] === b[field]));
    async function persist() {
      if (!['ready', 'saved'].includes(storageState)) { refresh(); return; }
      saving = true; refresh();
      const desired = comments.slice();
      const write = async () => {
        const next = await transaction((text, store) => {
          const latest = readComments(text === undefined ? null : text);
          const before = new Map(storedComments.map(c => [c.id, c]));
          const after = new Map(desired.map(c => [c.id, c]));
          const merged = new Map(latest.map(c => [c.id, c]));
          for (const id of new Set([...before.keys(), ...after.keys()])) {
            if (sameComment(before.get(id), after.get(id))) continue;
            if (!sameComment(merged.get(id), before.get(id)) && !sameComment(merged.get(id), after.get(id))) {
              storageState = 'conflict'; return null;
            }
            if (after.has(id)) merged.set(id, after.get(id)); else merged.delete(id);
          }
          const next = [...merged.values()];
          store.put(JSON.stringify(next), key);
          return next;
        });
        if (next === null) return;
        storedComments = next.slice(); comments = next;
        storageState = 'saved';
      };
      try {
        if (navigator.locks?.request) await navigator.locks.request(key, write);
        else await write();
      } catch { storageState = 'unavailable'; }
      finally {
        saving = false; refresh();
      }
    }
    const pathOf = c => c.side === 'left' ? data.files[c.file].oldPath : c.file;
    const label = c => `${pathOf(c)} · ${c.side === 'left' ? '변경 전' : '변경 후'} L${c.start}${c.end === c.start ? '' : '–' + c.end}`;
    function codeOf(c) {
      const lines = source(c.file, c.side);
      return Array.from({length: c.end - c.start + 1}, (_, i) => lines.get(c.start + i)).join('\n');
    }
    function payload() {
      return JSON.stringify({schemaVersion: 1, kind: 'codex-deck-diff-review',
        repositoryId: data.comparison.repositoryId, snapshot: data.comparison.fingerprint,
        comments: comments.map(c => ({id: c.id, path: pathOf(c), side: c.side,
          source: c.side === 'left' ? data.comparison.base : data.comparison.fingerprint, startLine: c.start, endLine: c.end,
          code: codeOf(c), body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt}))}, null, 2);
    }
    function copyText() {
      const items = comments.map((c, index) => {
        const title = label(c).replace(/[\\`*_\[\]<>]/g, '\\$&');
        const url = sourceUrl(pathOf(c), c.start, c.end, c.side);
        const heading = url.startsWith('#') ? title : `[${title}](<${url}>)`;
        const code = codeOf(c);
        const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(match => match[0].length + 1)));
        return `## ${index + 1}. ${heading}\n\n${c.body}\n\n${fence}\n${code}\n${fence}`;
      });
      return `# ${data.repositoryName} · 리뷰 코멘트\n\n${data.comparisonLabel} · Snapshot ${data.comparison.fingerprint}\n\n${items.join('\n\n')}`;
    }
    function parseImport(text) {
      if (new Blob([text]).size > importLimit) throw new Error('JSON 파일은 10 MiB 이하여야 합니다.');
      let saved;
      try { saved = JSON.parse(text); }
      catch { throw new Error('JSON을 읽을 수 없습니다. 파일 내용 전체를 확인해 주세요.'); }
      if (!saved || saved.kind !== 'codex-deck-diff-review' || saved.schemaVersion !== 1 || !Array.isArray(saved.comments)) {
        throw new Error('Not a Codex Deck Diff comments JSON file. Supported format: version 1.');
      }
      if (saved.repositoryId !== data.comparison.repositoryId || saved.snapshot !== data.comparison.fingerprint) {
        throw new Error('Repository or snapshot differs. Open the guide used to export this JSON.');
      }
      if (saved.comments.length > 1000) throw new Error('한 번에 가져올 수 있는 코멘트는 1,000개까지입니다.');
      const ids = new Set();
      return saved.comments.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id.length || item.id.length > 200 || ids.has(item.id) ||
            !['left', 'right'].includes(item.side) || typeof item.path !== 'string') {
          throw new Error('코멘트 정보가 올바르지 않거나 파일 안에 중복 ID가 있습니다.');
        }
        ids.add(item.id);
        const matches = Object.keys(data.files).filter(file =>
          (item.side === 'left' ? data.files[file].oldPath : file) === item.path &&
          (item.side === 'left' ? data.files[file].oldLineCount : data.files[file].lineCount) > 0);
        if (matches.length !== 1) throw new Error('코멘트의 파일 경로를 이 가이드에서 찾을 수 없습니다.');
        const c = {id:item.id, file:matches[0], side:item.side, start:item.startLine, end:item.endLine,
          body:item.body, createdAt:item.createdAt, updatedAt:item.updatedAt};
        if (!valid(c) || !Number.isFinite(Date.parse(c.createdAt)) || !Number.isFinite(Date.parse(c.updatedAt))) {
          throw new Error('코멘트의 줄 범위, 내용 또는 날짜가 올바르지 않습니다.');
        }
        if (item.source !== (c.side === 'left' ? data.comparison.base : data.comparison.fingerprint) || item.code !== codeOf(c)) {
          throw new Error('코멘트에 담긴 코드가 이 가이드의 원문과 다릅니다. 원래 내보낸 JSON을 확인해 주세요.');
        }
        return c;
      });
    }
    function importPlan() {
      const byId = new Map(comments.map(c => [c.id, c]));
      const plan = {added:[], same:[], conflicts:[]};
      for (const incoming of importItems || []) {
        const existing = byId.get(incoming.id);
        if (!existing) plan.added.push(incoming);
        else if (['file', 'side', 'start', 'end', 'body'].every(field => existing[field] === incoming[field])) plan.same.push(incoming);
        else plan.conflicts.push({existing, incoming});
      }
      return plan;
    }
    function clearImportPreview() {
      importItems = null;
      el('review-import-preview').hidden = true;
      el('review-import-error').textContent = '';
    }
    function updateImportAction() {
      const plan = importPlan();
      const replacing = el('review-import-policy').value === 'replace';
      el('review-import-apply').disabled = saving || (!plan.added.length && !(replacing && plan.conflicts.length));
    }
    function previewImport() {
      clearImportPreview();
      try { importItems = parseImport(el('review-import-text').value); }
      catch (error) { el('review-import-error').textContent = error.message; return; }
      const plan = importPlan();
      const added = plan.added.length, same = plan.same.length, conflicts = plan.conflicts.length;
      el('review-import-summary').textContent = `새 코멘트 ${added}개 · 중복 ${same}개 · 충돌 ${conflicts}개`;
      el('review-import-policy').value = 'keep';
      el('review-import-conflict-options').hidden = !conflicts;
      const cards = el('review-import-conflicts'); cards.replaceChildren();
      for (const {existing, incoming} of plan.conflicts) {
        const card = node('article', '', 'review-card');
        card.append(node('strong', '기존 코멘트'), node('p', label(existing), 'review-editor-location'), node('p', existing.body, 'review-body'),
          node('strong', '가져올 코멘트'), node('p', label(incoming), 'review-editor-location'), node('p', incoming.body, 'review-body'));
        cards.append(card);
      }
      el('review-import-preview').hidden = false;
      updateImportAction();
    }
    function refresh() {
      for (const id of ['review-open', 'review-menu-open']) el(id).textContent = `코멘트 (${comments.length})`;
      el('review-copy').disabled = el('review-download').disabled = comments.length === 0;
      el('review-save').disabled = saving || !el('review-text').value.trim();
      dialog.setAttribute('aria-busy', String(saving));
      dialog.querySelectorAll('.review-card-actions button, #review-feedback button').forEach(b => { b.disabled = saving; });
      updateImportAction();
      el('review-add-from-list').disabled = el('review-add').disabled = !data.files[currentFile()]?.rows.some(r => r.kind === 'gap' || Number.isInteger(r.old) || Number.isInteger(r.new));
      storageLabel();
      decorate();
    }
    function decorate() {
      el('diff-body').querySelectorAll('tr').forEach(row => {
        const inRange = c => c.file === currentFile() && Number(c.side === 'left' ? row.dataset.oldLine : row.dataset.line) >= c.start &&
          Number(c.side === 'left' ? row.dataset.oldLine : row.dataset.line) <= c.end;
        row.classList.toggle('review-selected', Boolean(selection && inRange(selection)));
        row.dataset.reviewSide = selection?.side || '';
        for (const b of row.querySelectorAll('.review-line')) {
          const hasComment = comments.some(c => c.side === b.dataset.side && inRange(c));
          b.classList.toggle('has-comment', hasComment);
          b.setAttribute('aria-pressed', String(Boolean(selection && selection.side === b.dataset.side && inRange(selection))));
          b.title = hasComment ? '이 줄에 코멘트가 있습니다.' : '줄 선택 후 코멘트 작성';
        }
      });
    }
    function cancelSelection() {
      selecting = false; selection = null;
      document.body.dataset.reviewSelecting = 'false';
      el('review-selection').hidden = true;
      decorate();
    }
    function scrollToRow(row, side) {
      if (!row) return;
      const scroll = el('diff-scroll');
      el('diff-body').closest('table').style.setProperty('--focus-tail', `${Math.max(0, scroll.clientHeight - 56)}px`);
      const table = el('diff-body').closest('table');
      scroll.scrollLeft = table.dataset.view === 'split' && (side || table.dataset.focusSide) === 'right' ? row.querySelector('.line-new')?.offsetLeft || 0 : 0;
      scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - (table.dataset.view === 'split' ? 40 : 28);
    }
    function begin(focusCurrent = true) {
      dialog.close(); showCode(); selecting = true; selection = null;
      document.body.dataset.reviewSelecting = 'true';
      el('review-selection').hidden = false;
      selectionLabel(); decorate();
      if (focusCurrent) requestAnimationFrame(() => scrollToRow(el('diff-body').querySelector('tr.focus')));
      el('review-cancel-selection').focus({preventScroll: true});
    }
    function selectionLabel() {
      el('review-selection-label').textContent = selection ? label(selection) : '줄 번호를 선택하세요. 다른 줄을 누르면 범위가 됩니다.';
      el('review-write').disabled = !selection;
    }
    function select(file, side, line) {
      const first = !selecting;
      if (first) begin(false);
      if (!selection || selection.file !== file || selection.side !== side) selection = {file, side, start: line, end: line, anchor: line};
      else { selection.start = Math.min(selection.anchor, line); selection.end = Math.max(selection.anchor, line); }
      selectionLabel(); decorate();
      if (first) requestAnimationFrame(() => {
        const attr = side === 'left' ? 'data-old-line' : 'data-line';
        scrollToRow(el('diff-body').querySelector(`tr[${attr}="${line}"]`), side);
      });
    }
    function lineButton(number, side) {
      if (!Number.isInteger(number)) return document.createTextNode('');
      const b = button(String(number), () => select(currentFile(), side, number), 'review-line');
      b.dataset.side = side;
      b.setAttribute('aria-label', `${side === 'left' ? '변경 전' : '변경 후'} L${number} 코멘트 줄 선택`);
      return b;
    }
    function view(name) {
      importRead++;
      for (const id of ['list', 'editor', 'export', 'import']) el(`review-${id}`).hidden = id !== name;
      el('review-exports').hidden = name !== 'list';
      el('review-feedback').textContent = '';
      el('review-title').textContent = name === 'editor' ? '코멘트 작성' : name === 'export' ? '코멘트 복사' : name === 'import' ? 'JSON 불러오기' : '리뷰 코멘트';
      storageLabel();
      if (!dialog.open) dialog.showModal();
    }
    function list() {
      draft = null; view('list');
      const container = el('review-items');
      container.replaceChildren();
      if (!comments.length) container.append(node('p', '읽다가 궁금한 점이나 수정 의견을 코드 줄에 남겨보세요.', 'review-empty'));
      for (const c of comments) {
        const card = node('article', '', 'review-card');
        const jump = button(label(c), () => { dialog.close(); cancelSelection(); reveal(c); }, 'review-location');
        const actions = node('div', '', 'review-card-actions');
        actions.append(button('수정', () => edit(c)), button('삭제', async () => {
          if (saving) return;
          const viewId = importRead;
          comments = comments.filter(item => item.id !== c.id); await persist();
          if (!dialog.open || viewId !== importRead) return;
          list();
          const undo = button('삭제 취소', async () => {
            if (saving) return;
            const viewId = importRead;
            comments = comments.concat(c); await persist();
            if (dialog.open && viewId === importRead) list();
          });
          el('review-feedback').replaceChildren(node('span', '코멘트를 삭제했습니다. '), undo);
        }));
        card.append(jump, node('p', c.body, 'review-body'), actions);
        container.append(card);
      }
      refresh();
      el('review-close').focus({preventScroll: true});
    }
    function edit(c) {
      draft = {...c}; view('editor');
      el('review-location').textContent = label(c);
      el('review-code').textContent = codeOf(c);
      el('review-text').value = c.body || '';
      el('review-save').disabled = saving || !el('review-text').value.trim();
      el('review-text').focus();
    }
    function open() {
      if (draft) { const pending = {...draft, body: el('review-text').value}; edit(pending); }
      else list();
    }
    el('review-open').addEventListener('click', open);
    el('review-menu-open').addEventListener('click', open);
    el('review-add').addEventListener('click', () => begin());
    el('review-add-from-list').addEventListener('click', () => begin());
    el('review-cancel-selection').addEventListener('click', cancelSelection);
    el('review-write').addEventListener('click', () => { if (selection) edit(selection); });
    el('review-close').addEventListener('click', () => dialog.close());
    el('review-cancel-edit').addEventListener('click', list);
    el('review-text').addEventListener('input', () => { el('review-save').disabled = saving || !el('review-text').value.trim(); });
    el('review-save').addEventListener('click', async () => {
      const body = el('review-text').value.trim();
      if (saving || !draft || !body || body.length > 10000) return;
      const viewId = importRead;
      const now = new Date().toISOString();
      const c = {id: draft.id || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
        file: draft.file, side: draft.side, start: draft.start, end: draft.end, body,
        createdAt: draft.createdAt || now, updatedAt: now};
      if (!valid(c)) return;
      draft = c;
      const savedDraft = draft;
      const index = comments.findIndex(item => item.id === c.id);
      if (index < 0) comments.push(c); else comments[index] = c;
      cancelSelection(); await persist();
      if (draft === savedDraft && el('review-text').value.trim() === body) draft = null;
      if (!draft && dialog.open && viewId === importRead) list();
    });
    el('review-copy').addEventListener('click', async () => {
      const text = copyText();
      try {
        await navigator.clipboard.writeText(text);
        el('review-feedback').textContent = '코멘트를 복사했습니다. AI 대화에 붙여넣으세요.';
      } catch {
        view('export');
        el('review-export-text').value = text;
        el('review-export-text').focus(); el('review-export-text').select();
      }
    });
    el('review-export-back').addEventListener('click', list);
    el('review-import-open').addEventListener('click', () => {
      clearImportPreview(); view('import');
      el('review-import-text').value = '';
      el('review-import-filename').textContent = '';
      el('review-import-file').value = '';
      el('review-import-file-button').focus();
    });
    el('review-import-cancel').addEventListener('click', list);
    dialog.addEventListener('close', () => { importRead++; });
    el('review-import-text').addEventListener('input', () => { importRead++; clearImportPreview(); });
    el('review-import-file-button').addEventListener('click', () => el('review-import-file').click());
    el('review-import-file').addEventListener('change', async () => {
      const file = el('review-import-file').files[0];
      if (!file) return;
      const read = ++importRead;
      clearImportPreview();
      el('review-import-filename').textContent = file.name;
      el('review-import-text').value = '';
      if (file.size > importLimit) { el('review-import-error').textContent = 'JSON 파일은 10 MiB 이하여야 합니다.'; return; }
      try {
        const text = await file.text();
        if (read !== importRead || !dialog.open || el('review-import').hidden) return;
        el('review-import-text').value = text;
        previewImport();
      } catch {
        if (read === importRead && dialog.open) el('review-import-error').textContent = '파일을 읽을 수 없습니다. 다시 선택하거나 JSON을 붙여넣어 주세요.';
      }
    });
    el('review-import-check').addEventListener('click', previewImport);
    el('review-import-policy').addEventListener('change', updateImportAction);
    el('review-import-apply').addEventListener('click', async () => {
      if (saving || !importItems) return;
      const viewId = importRead;
      const plan = importPlan(), replacing = el('review-import-policy').value === 'replace';
      const replacements = new Map(replacing ? plan.conflicts.map(({incoming}) => [incoming.id, incoming]) : []);
      comments = comments.map(c => replacements.get(c.id) || c).concat(plan.added);
      const added = plan.added.length, replaced = replacements.size, skipped = plan.same.length + (replacing ? 0 : plan.conflicts.length);
      importItems = null; await persist();
      if (!dialog.open || viewId !== importRead) return;
      list();
      el('review-feedback').textContent = `${added}개 추가 · ${replaced}개 교체 · ${skipped}개 건너뜀`;
    });
    el('review-download').addEventListener('click', () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([payload()], {type: 'application/json'}));
      const a = node('a'); a.href = downloadUrl;
      a.download = `diff-review-${data.comparison.fingerprint.slice(0, 8)}.json`;
      document.body.append(a); a.click(); a.remove();
    });
    // Preserve an unfinished editor when Escape or Close dismisses the sheet.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && selecting && !document.querySelector('dialog[open]') && el('code-menu-toggle').getAttribute('aria-expanded') !== 'true') {
        event.preventDefault(); event.stopImmediatePropagation(); cancelSelection();
      }
    }, true);
    refresh();
    load();
    return {lineButton, refresh, cancelSelection, invalidateSources: () => sources.clear()};
  }
  return {init};
})();
