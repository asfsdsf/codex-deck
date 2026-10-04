# highlight.js 11.12.0

The unmodified common-language browser bundle is vendored so generated guides
remain one offline HTML file. It runs locally in the browser; no Node.js or
package installation is needed to generate a guide. See `LICENSE` for BSD-3-Clause
terms; the builder also embeds that notice in each generated HTML.

- Bundle: https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/highlight.min.js
- License: https://raw.githubusercontent.com/highlightjs/highlight.js/11.12.0/LICENSE
- Bundle SHA-256: `8ab71eb09c51f501e5e25157d9cff100e46cc29bcbfc744d0b746d451fca7f53`
- License SHA-256: `6c081431591d9df696c82dc598fe1423765b8a299b200ed00b281afd0f64c490`

To update, replace the bundle and license from a pinned official release, update
the version and hashes here and the embedded version in
[`build_guide.py`](../../../scripts/build_guide.py). Run the skill's Python tests
and browser smoke test after an update. Keep the license notice when
redistributing the bundle.

Language selection uses file extensions in `assets/syntax.js`. Unsupported files
remain plain text. Tokenization is separate from authored definition links and
does not imply that the guide can resolve every symbol.
