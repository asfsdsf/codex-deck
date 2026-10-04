/* Syntax colors are presentation only: source text and link offsets stay unchanged. */
const TourSyntax = (() => {
  'use strict';
  const extensions = {
    py: 'python', pyi: 'python', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    cjs: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    sh: 'bash', bash: 'bash', zsh: 'bash', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    cs: 'csharp', css: 'css', go: 'go', graphql: 'graphql', gql: 'graphql', ini: 'ini',
    toml: 'ini', java: 'java', json: 'json', kt: 'kotlin', kts: 'kotlin', less: 'less',
    lua: 'lua', md: 'markdown', markdown: 'markdown', m: 'objectivec', pl: 'perl',
    php: 'php', r: 'r', rb: 'ruby', rs: 'rust', scss: 'scss', sql: 'sql', swift: 'swift',
    vb: 'vbnet', wat: 'wasm', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    yml: 'yaml', yaml: 'yaml', diff: 'diff', patch: 'diff',
  };
  const entities = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'"};

  function language(path) {
    const name = path.split('/').pop().toLowerCase();
    if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
    if (name === 'gemfile' || name === 'rakefile') return 'ruby';
    const extension = name.split('.').pop();
    return Object.prototype.hasOwnProperty.call(extensions, extension) ? extensions[extension] : undefined;
  }

  function lines(source, path, highlighter) {
    const plain = () => source.split('\n').map(() => []);
    const lang = language(path);
    if (!lang || !highlighter?.getLanguage(lang)) return plain();
    try {
      const markup = highlighter.highlight(source, {language: lang, ignoreIllegals: true}).value;
      const result = [[]];
      const scopes = [];
      let decoded = '', offset = 0, consumed = 0;
      // Accept only highlight.js's span/text output. Never insert its HTML into the DOM.
      // Decoding here also preserves CRLF and UTF-16 offsets used by definition links.
      const parts = /<span class="([\w -]+)">|(<\/span>)|([^<]+)/g;
      for (const match of markup.matchAll(parts)) {
        if (match.index !== consumed) return plain();
        consumed += match[0].length;
        if (match[1]) scopes.push(match[1]);
        else if (match[2]) {
          if (!scopes.length) return plain();
          scopes.pop();
        } else {
          const text = match[3].replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, entity => entities[entity]);
          decoded += text;
          text.split('\n').forEach((piece, index) => {
            if (index) { result.push([]); offset = 0; }
            if (piece.length && scopes.length) {
              result[result.length - 1].push({start: offset, end: offset + piece.length, classes: scopes.join(' ')});
            }
            offset += piece.length;
          });
        }
      }
      return consumed === markup.length && !scopes.length && decoded === source ? result : plain();
    } catch {
      // Unsupported or malformed input must never prevent reading the original diff.
      return plain();
    }
  }

  function rows(items, path, highlighter) {
    const tokens = lines(items.map(row => row.text).join('\n'), path, highlighter);
    items.forEach((row, index) => { row.syntax = tokens[index]; });
  }

  function file(file, highlighter) {
    const items = file.rows.flatMap(row => row.kind === 'gap' ? row.lines : row.kind === 'hunk' ? [] : [row]);
    // Parse each complete snapshot independently, including hidden context. A deletion
    // must not change how the following added lines are interpreted (or vice versa).
    rows(items.filter(row => row.old != null), file.oldPath, highlighter);
    items.forEach(row => { row.oldSyntax = row.syntax; });
    rows(items.filter(row => row.new != null), file.path, highlighter);
  }

  function append(parent, row, start = 0, end = row.text.length) {
    const doc = parent.ownerDocument;
    let cursor = start;
    for (const token of row.syntax || []) {
      const left = Math.max(start, token.start), right = Math.min(end, token.end);
      if (left >= right) continue;
      if (cursor < left) parent.append(doc.createTextNode(row.text.slice(cursor, left)));
      const span = doc.createElement('span');
      span.className = token.classes;
      span.textContent = row.text.slice(left, right);
      parent.append(span);
      cursor = right;
    }
    if (cursor < end) parent.append(doc.createTextNode(row.text.slice(cursor, end)));
  }

  return {language, lines, rows, file, append};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TourSyntax;
