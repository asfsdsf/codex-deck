/* Reader preferences only; resizing never changes guide data or review comments. */
const TourLayout = (() => {
  'use strict';
  function init({workspace, mobileQuery}) {
    const sidebarHandle = document.getElementById('sidebar-resizer');
    const paneHandle = document.getElementById('pane-resizer');
    const footer = document.querySelector('.bottom-bar');
    const key = 'codex-deck-diff.pane-widths.v1';
    const minimum = {sidebar:160, guide:260, code:320};
    const handlesWidth = 16;
    const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
    let preferred = null;
    let sizes = null;
    let drag = null;
    let width = 0;
    try {
      const stored = JSON.parse(localStorage.getItem(key));
      if (stored && stored.version === 1 && Number.isFinite(stored.sidebar) &&
          Number.isFinite(stored.guide) && stored.sidebar >= minimum.sidebar &&
          stored.sidebar <= 360 && stored.guide >= minimum.guide && stored.guide <= 10000) {
        preferred = {sidebar:stored.sidebar, guide:stored.guide};
      }
    } catch {}

    const codeFirst = () => workspace.dataset.layout === 'code-first';
    function bounds(handle) {
      if (handle === sidebarHandle) {
        const neighbor = codeFirst() ? 'code' : 'guide';
        return {min:minimum.sidebar, max:Math.min(360, sizes.sidebar + sizes[neighbor] - minimum[neighbor]), value:sizes.sidebar};
      }
      const left = codeFirst() ? 'code' : 'guide';
      const right = codeFirst() ? 'guide' : 'code';
      return {min:minimum[left], max:sizes[left] + sizes[right] - minimum[right], value:sizes[left]};
    }

    function render() {
      if (mobileQuery.matches) return;
      width = workspace.clientWidth;
      const available = width - handlesWidth;
      const style = getComputedStyle(workspace);
      const desired = preferred || {sidebar:parseFloat(style.getPropertyValue('--sidebar-width')),
        guide:parseFloat(style.getPropertyValue('--guide-width'))};
      const sidebar = clamp(desired.sidebar, minimum.sidebar, Math.min(360, available - minimum.guide - minimum.code));
      const guide = clamp(desired.guide, minimum.guide, available - sidebar - minimum.code);
      sizes = {sidebar, guide, code:available - sidebar - guide};
      workspace.style.setProperty('--resized-sidebar-width', `${sidebar}px`);
      workspace.style.setProperty('--resized-guide-width', `${guide}px`);
      footer.style.setProperty('--resized-sidebar-width', `${sidebar}px`);
      for (const handle of [sidebarHandle, paneHandle]) {
        const range = bounds(handle);
        handle.setAttribute('aria-valuemin', Math.round(range.min));
        handle.setAttribute('aria-valuemax', Math.round(range.max));
        handle.setAttribute('aria-valuenow', Math.round(range.value));
        handle.setAttribute('aria-valuetext', `${Math.round(range.value)} 픽셀`);
      }
    }

    function persist() {
      try {
        if (preferred) localStorage.setItem(key, JSON.stringify({version:1, ...preferred}));
        else localStorage.removeItem(key);
      } catch {} // A blocked preference store must not prevent resizing offline.
    }

    function move(handle, value, origin) {
      const next = {...origin};
      if (handle === sidebarHandle) {
        const neighbor = codeFirst() ? 'code' : 'guide';
        next.sidebar = clamp(value, minimum.sidebar, Math.min(360, origin.sidebar + origin[neighbor] - minimum[neighbor]));
        next[neighbor] = origin[neighbor] - (next.sidebar - origin.sidebar);
      } else {
        const left = codeFirst() ? 'code' : 'guide';
        const right = codeFirst() ? 'guide' : 'code';
        next[left] = clamp(value, minimum[left], origin[left] + origin[right] - minimum[right]);
        next[right] = origin[right] - (next[left] - origin[left]);
      }
      preferred = {sidebar:next.sidebar, guide:next.guide};
      render();
    }

    function finish(cancel = false) {
      if (!drag) return;
      const currentDrag = drag;
      drag = null;
      if (cancel) preferred = currentDrag.preferred;
      else persist();
      delete document.body.dataset.paneDragging;
      delete currentDrag.handle.dataset.dragging;
      if (currentDrag.handle.hasPointerCapture(currentDrag.id)) currentDrag.handle.releasePointerCapture(currentDrag.id);
      render();
    }

    function reset() {
      finish(true);
      preferred = null;
      persist();
      render();
      document.getElementById('status-live').textContent = '영역 너비를 기본값으로 되돌렸습니다.';
    }

    for (const handle of [sidebarHandle, paneHandle]) {
      handle.title = '드래그로 너비 조절 · 방향키로 미세 조절 · 더블클릭 또는 Enter로 전체 너비 초기화';
      handle.addEventListener('pointerdown', event => {
        if (mobileQuery.matches || !event.isPrimary || event.button !== 0 || drag) return;
        event.preventDefault();
        handle.focus({preventScroll:true});
        drag = {handle, id:event.pointerId, x:event.clientX, value:bounds(handle).value,
          origin:{...sizes}, preferred:preferred && {...preferred}};
        handle.setPointerCapture(event.pointerId);
        handle.dataset.dragging = 'true';
        document.body.dataset.paneDragging = 'true';
      });
      handle.addEventListener('pointermove', event => {
        if (drag?.handle !== handle || drag.id !== event.pointerId) return;
        move(handle, drag.value + event.clientX - drag.x, drag.origin);
      });
      handle.addEventListener('pointerup', event => {
        if (drag?.id !== event.pointerId) return;
        move(handle, drag.value + event.clientX - drag.x, drag.origin);
        finish();
      });
      handle.addEventListener('pointercancel', () => finish(true));
      handle.addEventListener('lostpointercapture', () => finish(true));
      handle.addEventListener('dblclick', reset);
      handle.addEventListener('keydown', event => {
        if (mobileQuery.matches || drag) return;
        if (event.key === 'Enter') { event.preventDefault(); reset(); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const range = bounds(handle);
        const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 50 : 10);
        move(handle, event.key === 'Home' ? range.min : event.key === 'End' ? range.max : range.value + delta, sizes);
        persist();
      });
    }
    document.addEventListener('keydown', event => {
      if (drag && event.key === 'Escape') { event.preventDefault(); finish(true); }
    });
    window.addEventListener('blur', () => finish(true));
    function layoutChanged() {
      finish(true);
      paneHandle.setAttribute('aria-controls', codeFirst() ? 'code-pane' : 'guide');
      paneHandle.setAttribute('aria-label', codeFirst() ? '코드 영역 너비' : '설명 영역 너비');
      render();
    }
    mobileQuery.addEventListener('change', () => { finish(true); render(); });
    new ResizeObserver(() => {
      if (!mobileQuery.matches && workspace.clientWidth !== width) { finish(true); render(); }
    }).observe(workspace);
    layoutChanged();
    return {layoutChanged};
  }
  return {init};
})();
