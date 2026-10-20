// App-only enhancement for generated guides. It runs inside the existing sandbox
// and deliberately has no access to the app's DOM, transport, or stored artifacts.
export const diffGuideTranslationRuntime = String.raw`(function (token) {
  const requestType = 'codex-deck:diff-guide:translate';
  const responseType = 'codex-deck:diff-guide:translation';
  const autoTranslateType = 'codex-deck:diff-guide:auto-translate';
  const states = new Map();
  const navStates = new Map();
  const pending = new Map();
  const queue = [];
  const decorated = new WeakSet();
  let sequence = 0;
  let autoTranslate = false;
  let currentStep = null;
  let mobileButton = null;
  let mobileError = null;
  const nav = document.getElementById('step-nav');
  const guide = document.getElementById('guide');
  const select = document.getElementById('step-select');
  if (!nav || !guide) return;

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function getState(step, kind, index, targets) {
    const originals = targets.map(element => element.textContent || '');
    if (!originals.some(text => text.trim())) return null;
    const key = JSON.stringify([step, kind, index, originals]);
    if (!states.has(key)) states.set(key, {
      step, kind, originals, translated: null, showing: false, wantsTranslation: false,
      status: 'idle', error: null, bindings: new Set()
    });
    return states.get(key);
  }

  function makeButton(kind) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'deck-diff-translate';
    button.dataset.translationKind = kind;
    return button;
  }

  function makeError() {
    const error = document.createElement('p');
    error.className = 'deck-diff-translation-error';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;
    return error;
  }

  function renderControl(button, error, state) {
    const loading = state.status === 'loading' || state.status === 'queued';
    const failed = state.status === 'error';
    const label = loading ? 'Translating to Chinese…' : failed ? 'Retry translation to Chinese' :
      state.showing ? 'Show original' : 'Translate to Chinese';
    button.disabled = loading;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(state.showing));
    button.setAttribute('aria-busy', String(loading));
    button.title = failed ? 'Translation failed: ' + state.error + '. Click to retry.' : label;
    if (button.dataset.translationStatus !== state.status) {
      button.dataset.translationStatus = state.status;
      // Use the same Languages icon as message-block translation controls.
      button.innerHTML = loading ?
        '<svg class="deck-diff-spinner" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a9 9 0 1 0 9 9"/></svg>' :
        '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
    }
    error.hidden = !failed;
    setText(error, failed ? 'Translation failed: ' + state.error : '');
  }

  function displayed(state) {
    return state.showing && state.translated ? state.translated : state.originals;
  }

  function updateMobile() {
    if (!select || !mobileButton) return;
    const state = navStates.get(Number(select.value));
    mobileButton.hidden = !state;
    if (state) renderControl(mobileButton, mobileError, state);
    for (const option of select.options) {
      const optionState = navStates.get(Number(option.value));
      if (optionState) setText(option,
        String(Number(option.value) + 1).padStart(2, '0') + ' · ' + displayed(optionState)[0]);
    }
  }

  function render(state) {
    const texts = displayed(state);
    for (const binding of state.bindings) {
      if (!binding.button.isConnected) { state.bindings.delete(binding); continue; }
      binding.targets.forEach((target, index) => setText(target, texts[index]));
      if (binding.navButton) binding.navButton.setAttribute('aria-label',
        binding.navNumber + ' ' + texts[0]);
      renderControl(binding.button, binding.error, state);
    }
    updateMobile();
  }

  function pump() {
    // Bound bulk translation requests, and prioritize the selected step over
    // sidebar titles so long guides remain responsive without flooding the bridge.
    while (pending.size < 4 && queue.length) {
      const visible = queue.findIndex(state => state.kind !== 'step' && state.step === currentStep);
      const [state] = queue.splice(visible < 0 ? 0 : visible, 1);
      if (!state.wantsTranslation) continue;
      state.status = 'loading';
      const requestId = String(++sequence);
      pending.set(requestId, state);
      render(state);
      window.parent.postMessage({ type: requestType, token, requestId, texts: state.originals }, '*');
    }
  }

  function showTranslation(state) {
    state.wantsTranslation = true;
    if (state.translated) {
      state.showing = true;
      render(state);
      return;
    }
    if (state.status === 'loading' || state.status === 'queued') return;
    state.status = 'queued';
    state.error = null;
    queue.push(state);
    render(state);
    pump();
  }

  function toggle(state) {
    if (!state || state.status === 'loading' || state.status === 'queued') return;
    if (state.showing) {
      state.wantsTranslation = false;
      state.showing = false;
      render(state);
    } else showTranslation(state);
  }

  function visibleDescriptions() {
    return [...states.values()].filter(state => state.step === currentStep && state.kind !== 'step' &&
      [...state.bindings].some(binding => binding.button.isConnected));
  }

  function setAutoTranslate(enabled) {
    if (autoTranslate === enabled) return;
    autoTranslate = enabled;
    if (enabled) {
      decorate();
      visibleDescriptions().forEach(showTranslation);
      navStates.forEach(showTranslation);
    } else {
      queue.length = 0;
      for (const state of states.values()) {
        state.wantsTranslation = false;
        state.showing = false;
        if (state.status === 'queued') state.status = 'idle';
        render(state);
      }
    }
  }

  function bind(state, targets, originalButton, kind) {
    const row = document.createElement('div');
    row.className = 'deck-diff-translation-block deck-diff-' + kind;
    const button = makeButton(kind);
    const error = makeError();
    originalButton.replaceWith(row);
    row.append(originalButton);
    if (kind === 'main') row.append(targets[1]);
    // Keep independent buttons as siblings, while positioning the translation
    // control inside the card instead of reserving a separate text column.
    row.append(button, error);
    const binding = { button, error, targets };
    if (kind === 'step') {
      binding.navButton = originalButton;
      binding.navNumber = originalButton.querySelector('.nav-num')?.textContent || '';
    }
    state.bindings.add(binding);
    button.addEventListener('click', event => {
      event.stopPropagation();
      toggle(state);
    });
    render(state);
  }

  function decorate() {
    for (const originalButton of nav.querySelectorAll('.nav-step')) {
      if (decorated.has(originalButton)) continue;
      decorated.add(originalButton);
      const step = Number(originalButton.dataset.step);
      const title = originalButton.querySelector('.nav-title');
      if (!Number.isInteger(step) || !title) continue;
      const state = getState(step, 'step', 0, [title]);
      if (!state) continue;
      navStates.set(step, state);
      bind(state, [title], originalButton, 'step');
      if (autoTranslate && state.status === 'idle') showTranslation(state);
    }
    const current = nav.querySelector('.nav-step[aria-current="step"]');
    const step = Number(current?.dataset.step ?? select?.value);
    if (!Number.isInteger(step)) return;
    const stepChanged = step !== currentStep;
    currentStep = step;
    const newDescriptions = [];
    const heading = guide.querySelector('#step-heading');
    const why = guide.querySelector('.why');
    if (heading && why && !decorated.has(heading)) {
      decorated.add(heading);
      const state = getState(step, 'main', 0, [heading, why]);
      if (state) {
        bind(state, [heading, why], heading, 'main');
        newDescriptions.push(state);
      }
    }
    for (const originalButton of guide.querySelectorAll('.note-button')) {
      if (decorated.has(originalButton)) continue;
      decorated.add(originalButton);
      const index = Number(originalButton.dataset.note);
      const title = originalButton.querySelector('.note-title');
      const body = originalButton.querySelector('.note-body');
      if (!Number.isInteger(index) || !title || !body) continue;
      const state = getState(step, 'note', index, [title, body]);
      if (state) {
        bind(state, [title, body], originalButton, 'note');
        newDescriptions.push(state);
      }
    }
    // Discard references to descriptions replaced by the guide's renderer.
    for (const state of states.values()) {
      for (const binding of state.bindings) if (!binding.button.isConnected) state.bindings.delete(binding);
    }
    // Only activate descriptions on entering a step (or adding a new block).
    // Text mutations and note selection must preserve individual original toggles.
    if (autoTranslate) {
      const descriptions = stepChanged ? visibleDescriptions() :
        newDescriptions.filter(state => state.status === 'idle');
      descriptions.forEach(showTranslation);
    }
    updateMobile();
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.token !== token) return;
    if (data.type === autoTranslateType && typeof data.enabled === 'boolean') {
      setAutoTranslate(data.enabled);
      return;
    }
    if (data.type !== responseType || typeof data.requestId !== 'string') return;
    const state = pending.get(data.requestId);
    if (!state) return;
    if (typeof data.error === 'string') {
      state.status = 'error';
      state.error = data.error;
      state.translated = null;
      state.showing = false;
    } else if (Array.isArray(data.texts) && data.texts.length === state.originals.length &&
      data.texts.every(text => typeof text === 'string')) {
      state.status = data.partial === true ? 'loading' : 'ready';
      state.translated = data.texts;
      state.showing = state.wantsTranslation;
      if (data.partial === true) {
        render(state);
        return;
      }
    } else return;
    pending.delete(data.requestId);
    render(state);
    pump();
  });

  if (select) {
    mobileButton = makeButton('mobile-step');
    mobileError = makeError();
    select.after(mobileButton, mobileError);
    mobileButton.addEventListener('click', () => toggle(navStates.get(Number(select.value))));
    select.addEventListener('change', () => queueMicrotask(decorate));
  }
  const observer = new MutationObserver(decorate);
  observer.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current'] });
  observer.observe(guide, { childList: true, subtree: true });
  decorate();
})`;

export const diffGuideTranslationStyles = `
.deck-diff-translation-block { --deck-diff-action-size: 28px; position: relative; min-width: 0; }
.deck-diff-translation-block > .deck-diff-translate { position: absolute; inset-block-start: 4px; inset-inline-end: 4px; }
.deck-diff-step > .nav-step { min-width: 0; }
.deck-diff-step .nav-step > div { min-width: 0; flex: 1; }
.deck-diff-step .nav-title { display: block; }
.deck-diff-step .nav-title::before, .deck-diff-main h2::before { content: ''; float: right; width: calc(var(--deck-diff-action-size) + 4px); height: var(--deck-diff-action-size); }
.deck-diff-step .nav-title::after { content: ''; display: block; clear: both; }
.deck-diff-main { display: flow-root; margin-bottom: 25px; }
.deck-diff-main > .why { margin-bottom: 0; }
.deck-diff-main > .deck-diff-translate { inset-block-start: 0; inset-inline-end: 0; }
.deck-diff-note { margin: 8px 0; }
.deck-diff-note > .note-button { min-width: 0; margin: 0; }
.deck-diff-note > .deck-diff-translate { inset-block-start: 8px; inset-inline-end: 8px; }
.deck-diff-note .note-top { flex-wrap: wrap; min-height: 20px; padding-inline-end: calc(var(--deck-diff-action-size) + 4px); }
.deck-diff-translation-block .nav-title, .deck-diff-translation-block .note-title,
.deck-diff-translation-block .nav-file, .deck-diff-translation-block .note-body, .deck-diff-main h2 { overflow-wrap: anywhere; }
.deck-diff-translate { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; min-height: 28px; padding: 5px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); }
.deck-diff-translate:hover { background: var(--blue-soft); color: var(--blue); }
.deck-diff-translate[aria-pressed=true] { color: var(--blue); background: var(--blue-soft); }
.deck-diff-translate[data-translation-status=error] { color: var(--red); }
.deck-diff-translation-error { margin-top: 4px; font-size: 11px; line-height: 1.6; color: var(--red); overflow-wrap: anywhere; }
.deck-diff-translate[hidden], .deck-diff-translation-error[hidden] { display: none; }
.deck-diff-spinner { animation: deck-diff-translation-spin 1s linear infinite; }
@keyframes deck-diff-translation-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .deck-diff-spinner { animation: none; } }
@media (max-width:850px), (max-width:950px) and (max-height:500px) {
  .deck-diff-translate { min-width: 44px; min-height: 44px; }
  .deck-diff-translation-block { --deck-diff-action-size: 44px; }
  .deck-diff-note .note-top { min-height: 36px; }
  .mobile-step { position: relative; flex-wrap: wrap; }
  .mobile-step > select { flex: 1; width: 100%; padding-inline-end: 66px; }
  .mobile-step > .deck-diff-translate { position: absolute; inset-block-start: 0; inset-inline-end: 18px; }
  .mobile-step > .deck-diff-translation-error { flex-basis: 100%; }
}
`;
