# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/kimak010204/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/kimak010204/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in for marked 18.1.3 (default options: gfm
on, breaks off, pedantic off, async off). `parse(markdown)` returns,
byte for byte, the HTML that `marked.parse(markdown)` returns.
720/720 practice cases match, ~1,5x faster than marked.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## Files

- `parse.js` — the renderer. A single dependency-free ES module that
  exports `parse(markdown)`. It is a from-scratch implementation of
  marked's CommonMark + GFM behaviour: block structure (headings,
  lists, block quotes, fenced/indented code, tables, HTML blocks,
  link reference definitions), inline parsing (emphasis and strong
  emphasis with marked's delimiter scan, strikethrough, code spans,
  links and images, autolinks and GFM extended autolinks, entities
  and backslash escapes), and the same HTML escaping and attribute
  order as marked. It keeps no state between calls, reads no files,
  and uses no network, so its output for a string depends only on
  that string.
- `main.ts` — the program the harness runs. It reads every case from
  `$MAKEFUN_INPUT_DIR/cases.json`, renders each with `parse`, and
  writes `$MAKEFUN_OUTPUT_DIR/html.json` (the HTML strings in the
  cases' order). Node 22 strips its types natively; it uses erasable
  syntax only and Node built-ins only.
- `LICENSE` — MIT.

## Checking it

Against the practice set in the kit (`practice/input/cases.json` and
`practice/reference/expected.json`): render all 720 cases with
`main.ts` and compare `html.json` with the reference — all 720 must
match, code unit for code unit.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t87hzjc5&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
