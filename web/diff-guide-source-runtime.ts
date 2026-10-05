// Injected into the guide's renderer only in the app. Saved HTML has no transport dependency.
export const diffGuideSourceRuntime = String.raw`(function(token, data, controls) {
  const pending = new Map();
  const cache = new Map();
  let sequence = 0, epoch = 0, sourceVersion = 0, definitionVersion = 0;
  const el = id => document.getElementById(id);
  const original = controls.original;
  const definitionLinks = new Map();
  // Every source operation goes through Git, including guides that embedded source.
  data.sources = {left: {}, right: {}};
  for (const [name, definition] of Object.entries(data.definitions)) {
    definitionLinks.set(name, new Map(definition.rows.map(row => [row.new, row.links || []])));
    definition.rows = [];
  }
  for (const step of data.steps) {
    if (step.reference) step.reference.code = '';
    for (const ref of step.transition?.evidence || []) ref.rows = [];
  }
  function request(path, side, start, limit) {
    return new Promise((resolve, reject) => {
      const requestId = String(++sequence);
      pending.set(requestId, {resolve, reject});
      window.parent.postMessage({type: 'codex-deck:diff-guide:source', token, requestId, path, side, start, limit}, '*');
    });
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || !message || message.token !== token ||
        message.type !== 'codex-deck:diff-guide:source-result') return;
    const job = pending.get(message.requestId);
    if (!job) return;
    pending.delete(message.requestId);
    if (typeof message.error === 'string') job.reject(new Error(message.error));
    else if (message.source && Array.isArray(message.source.lines) && message.source.lines.every(line => typeof line === 'string')) job.resolve(message.source);
    else job.reject(new Error('Invalid source response'));
  });
  function load(path, side = 'right', start = 1, end = Infinity) {
    const key = JSON.stringify([path, side, start, end === Infinity ? null : end]);
    if (cache.has(key)) return cache.get(key);
    const result = (async () => {
      let next = start;
      const lines = [];
      while (next !== null && next <= end) {
        const page = await request(path, side, next, Math.min(1000, end - next + 1));
        if (page.path !== path || page.side !== side || page.lineStart !== next ||
            !Number.isSafeInteger(page.totalLines) || page.totalLines < 0 ||
            (page.nextLine !== null && (!Number.isSafeInteger(page.nextLine) || page.nextLine <= next || page.nextLine !== next + page.lines.length)))
          throw new Error('Invalid source continuation');
        lines.push(...page.lines);
        next = page.nextLine;
      }
      if (end !== Infinity && lines.length !== end - start + 1) throw new Error('Source range is unavailable');
      return lines;
    })().catch(error => {cache.delete(key); throw error;});
    cache.set(key, result);
    return result;
  }
  data.loadReviewSources = async comments => {
    const seen = new Set();
    for (const comment of comments) {
      if (!comment || !['left', 'right'].includes(comment.side)) continue;
      const file = Object.hasOwn(data.files, comment.file || '') ? data.files[comment.file] :
        Object.values(data.files).find(file => (comment.side === 'left' ? file.oldPath : file.path) === comment.path);
      if (!file) continue;
      const path = comment.side === 'left' ? file.oldPath : file.path;
      const key = JSON.stringify([path, comment.side]);
      if (seen.has(key)) continue;
      seen.add(key);
      data.sources[comment.side][path] = await load(path, comment.side);
    }
  };
  function message(container, text, retry) {
    const p = document.createElement('p');
    p.className = 'deck-diff-source-status';
    p.setAttribute('role', 'status');
    p.textContent = text;
    const content = container.tagName === 'TBODY' ? document.createElement('td') : container;
    if (content !== container) {
      content.colSpan = 2;
      const row = document.createElement('tr'); row.append(content); container.replaceChildren(row);
    }
    content.replaceChildren(p);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'gap-button'; button.textContent = 'Retry';
      button.addEventListener('click', retry); content.append(button);
    }
  }
  const errorText = error => error instanceof Error ? error.message : String(error);
  // Relative links in srcdoc resolve against the host URL, not about:srcdoc.
  document.addEventListener('click', event => {
    const hash = event.target.closest('a')?.hash;
    if (!hash?.startsWith('#source?')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openSource(hash);
  }, true);
  function contextMessage(text, retry) {
    let box = el('deck-diff-source-status');
    if (!box) { box = document.createElement('div'); box.id = 'deck-diff-source-status'; el('code-pane').querySelector('.code-tools').append(box); }
    message(box, text, retry);
  }
  async function hydrate(path) {
    const file = data.files[path];
    const side = file.status === 'D' ? 'left' : 'right';
    const lines = await load(side === 'left' ? file.oldPath : path, side);
    for (const gap of file.rows.filter(row => row.kind === 'gap')) {
      const count = gap.count ?? gap.lines.length;
      const oldStart = gap.oldStart ?? gap.lines[0].old;
      const newStart = gap.newStart ?? gap.lines[0].new;
      const start = side === 'left' ? oldStart : newStart;
      if (start + count - 1 > lines.length) throw new Error('Unchanged source range is unavailable');
      gap.lines = Array.from({length: count}, (_, i) => ({kind:'context', text:lines[start + i - 1], old:oldStart + i, new:newStart + i, links:gap.links?.[newStart + i] || []}));
    }
    controls.highlight(file);
  }
  async function contextAction(action) {
    const saved = epoch, path = controls.getFile();
    contextMessage('Loading source…');
    try {
      await hydrate(path);
      if (saved !== epoch) return;
      el('deck-diff-source-status')?.remove();
      action();
    } catch (error) {
      if (saved === epoch) contextMessage('Source unavailable: ' + errorText(error), () => contextAction(action));
    }
  }
  async function openSource(hash) {
    const params = new URLSearchParams(hash.slice('#source?'.length));
    const path = params.get('path'), side = params.get('side');
    const saved = epoch, version = ++sourceVersion;
    el('source-title').textContent = path + ' · ' + (side === 'left' ? 'Baseline' : 'Captured current code');
    message(el('source-body'), 'Loading source…');
    if (!el('source-dialog').open) el('source-dialog').showModal();
    try {
      const lines = await load(path, side);
      if (saved !== epoch || version !== sourceVersion || !el('source-dialog').open) return;
      data.sources[side][path] = lines;
      original.openSource(hash);
    } catch (error) {
      if (saved === epoch && version === sourceVersion && el('source-dialog').open)
        message(el('source-body'), 'Source unavailable: ' + errorText(error), () => openSource(hash));
    }
  }
  async function renderDefinition(name) {
    const definition = data.definitions[name], saved = epoch, version = ++definitionVersion;
    el('definition-title').textContent = definition.qualified;
    el('definition-description').textContent = definition.description;
    message(el('definition-body'), 'Loading source…');
    try {
      const lines = await load(definition.path, definition.side, definition.start, definition.end);
      if (saved !== epoch || version !== definitionVersion || !el('definition-dialog').open) return;
      definition.rows = lines.map((text, i) => ({text, new: definition.start + i, links: definitionLinks.get(name)?.get(definition.start + i) || []}));
      controls.clearDefinition(name);
      original.renderDefinition(name);
    } catch (error) {
      if (saved === epoch && version === definitionVersion && el('definition-dialog').open)
        message(el('definition-body'), 'Source unavailable: ' + errorText(error), () => renderDefinition(name));
    }
  }
  async function revealComment(comment) {
    const saved = epoch;
    contextMessage('Loading source…');
    try {
      await hydrate(comment.file);
      if (saved !== epoch) return;
      el('deck-diff-source-status')?.remove();
      original.revealComment(comment);
    } catch (error) {
      if (saved === epoch) contextMessage('Source unavailable: ' + errorText(error), () => revealComment(comment));
    }
  }
  const decorated = new WeakSet();
  function decorateReferences() {
    const step = data.steps[controls.getStep()];
    if (!step) return;
    const reference = el('guide').querySelector('.reference');
    if (reference && !decorated.has(reference) && step.reference) {
      decorated.add(reference);
      const ref = step.reference, pre = reference.querySelector('pre');
      const show = async () => {
        if (!reference.open) return;
        const saved = epoch;
        pre.textContent = 'Loading source…';
        try {
          const lines = await load(ref.path, ref.side, ref.start, ref.end);
          if (saved === epoch && reference.isConnected && reference.open)
            pre.textContent = lines.map((line, i) => (ref.start + i) + '  ' + line).join('\n');
        } catch (error) {
          if (saved === epoch && reference.isConnected) pre.textContent = 'Source unavailable: ' + errorText(error) + '. Close and reopen to retry.';
        }
      };
      reference.addEventListener('toggle', show);
    }
    const evidence = el('guide').querySelector('.transition-evidence');
    if (evidence && !decorated.has(evidence)) {
      decorated.add(evidence);
      const refs = step.transition?.evidence || [];
      evidence.addEventListener('toggle', async () => {
        if (!evidence.open) return;
        const saved = epoch;
        const targets = evidence.querySelectorAll('.transition-code');
        await Promise.all(refs.map(async (ref, i) => {
          const pre = targets[i]; if (!pre) return;
          pre.textContent = 'Loading source…';
          try {
            const lines = await load(ref.path, ref.side, ref.start, ref.end);
            if (saved === epoch && pre.isConnected && evidence.open)
              pre.textContent = lines.map((line, j) => (ref.start + j) + '  ' + line).join('\n');
          } catch (error) {
            if (saved === epoch && pre.isConnected) pre.textContent = 'Source unavailable: ' + errorText(error) + '. Close and reopen to retry.';
          }
        }));
      });
    }
  }
  new MutationObserver(decorateReferences).observe(el('guide'), {childList:true, subtree:true});
  el('source-dialog').addEventListener('close', () => { sourceVersion++; });
  el('definition-dialog').addEventListener('close', () => { definitionVersion++; });
  return {
    toggleContext: () => contextAction(() => original.toggleContext()),
    expandGap: (gap, direction, previousRow) => contextAction(() => original.expandGap(gap, direction, previousRow)),
    renderDefinition, openSource, revealComment,
    sourceUrl: (path, start, end, side = 'right') => '#source?' + new URLSearchParams({path, side, start:start || '', end:end || start || ''}),
    renderStep: (...args) => { epoch++; el('deck-diff-source-status')?.remove(); return original.renderStep(...args); }
  };
})`;

export const diffGuideSourceStyles = `
.deck-diff-source-status { padding: 10px 12px; color: var(--muted); overflow-wrap: anywhere; font-size: 12px; }
#deck-diff-source-status { flex-basis: 100%; min-width: 0; }
.code-tools:has(#deck-diff-source-status) { flex-wrap: wrap; }
`;
