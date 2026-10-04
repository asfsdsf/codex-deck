/* Authored connections cite source; a citation is not a proof of execution flow. */
const TourTransitions = (() => {
  'use strict';
  const labels = {source: '코드 근거 첨부', inferred: '추론 포함', reading: '이해를 위한 읽기 순서', missing: '연결 근거 미작성'};
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(step, nextStep, summary, sourceUrl) {
    const card = make('section', 'next-flow');
    card.setAttribute('aria-label', nextStep ? '다음 단계 연결' : '읽기 완료');
    card.append(make('strong', '', nextStep ? `다음 · ${nextStep.title}` : '읽기 완료'));
    const transition = nextStep && step.transition;
    if (nextStep && (transition || summary?.enabled)) {
      const basis = transition?.basis || 'missing';
      const badge = make('span', `transition-badge ${basis}`, labels[basis]);
      card.append(badge);
    }
    card.append(make('p', 'transition-reason', step.next));
    if (transition?.basis === 'inferred') {
      const uncertainty = make('p', 'transition-uncertainty');
      uncertainty.append(make('b', '', '확인하지 못한 부분'), document.createTextNode(`: ${transition.uncertainty}`));
      card.append(uncertainty);
    }
    if (transition?.evidence?.length) {
      const evidence = make('details', 'transition-evidence');
      evidence.append(make('summary', '', `연결 근거 보기 · ${transition.evidence.length}곳`));
      // Highlight on first expansion; unopened citations add no parsing work.
      evidence.addEventListener('toggle', () => {
        if (!evidence.open || evidence.dataset.rendered) return;
        evidence.dataset.rendered = 'true';
        for (const ref of transition.evidence) {
          const excerpt = make('div', 'transition-excerpt');
          const side = ref.side === 'left' ? '변경 전' : '변경 후';
          const location = `${ref.path} · ${side} · L${ref.start}–${ref.end}`;
          excerpt.append(make('p', 'transition-location', location), make('p', '', ref.text));
          const pre = make('pre', 'transition-code');
          pre.tabIndex = 0;
          pre.setAttribute('role', 'region');
          pre.setAttribute('aria-label', location);
          TourSyntax.rows(ref.rows, ref.path, globalThis.hljs);
          ref.rows.forEach(row => {
            const line = make('span', 'transition-line');
            const number = make('span', 'transition-line-number', String(row.line));
            number.setAttribute('aria-hidden', 'true');
            const code = make('span', 'transition-line-source code-cell');
            TourSyntax.append(code, row);
            line.append(number, code);
            pre.append(line);
          });
          const link = make('a', 'transition-source', '해당 코드의 원본 ↗');
          link.href = sourceUrl(ref.path, ref.start, ref.end, ref.side);
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          excerpt.append(pre, link);
          evidence.append(excerpt);
        }
        evidence.append(make('p', 'transition-limit', '원본과 줄 범위를 확인한 인용입니다. 연결의 의미는 작성자의 해석입니다.'));
      });
      card.append(evidence);
    }
    if (summary?.enabled) {
      const overview = make('details', 'transition-overview');
      overview.append(make('summary', '', `가이드 전체 연결 · ${summary.total}개`));
      const list = make('ul');
      for (const basis of ['source', 'inferred', 'reading', 'missing']) {
        list.append(make('li', '', `${labels[basis]}: ${summary[basis]}`));
      }
      overview.append(list, make('p', '', '작성된 연결 설명의 현황이며, 실행 경로의 완전성이나 정확성을 뜻하지 않습니다.'));
      card.append(overview);
    }
    return card;
  }
  return {render};
})();
