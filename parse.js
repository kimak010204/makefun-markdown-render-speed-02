// parse.js — a fast CommonMark + GFM renderer, byte-compatible with
// marked 18.1.3's default options (gfm on, breaks off, pedantic off).
// Written from scratch for the make.fun markdown-render-speed-02 bounty:
// it parses markdown into HTML with no dependencies and no network.
// `parse(markdown)` returns exactly the string marked.parse(markdown)
// returns for the same input (default options).

// ------------------------------------------------------------------
// Small text helpers
// ------------------------------------------------------------------

// HTML-escape. With `full`, every & < > " ' is escaped. Otherwise only
// < > " ' are escaped, and & is escaped only when it does not start a
// valid character reference (so &amp; &copy; &#169; survive untouched).
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_FULL = /[&<>"']/g;
const ESC_PART = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST_FULL = /[&<>"']/;
const ESC_TEST_PART = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function esc(s, full) {
  if (full) {
    return ESC_TEST_FULL.test(s) ? s.replace(ESC_FULL, (c) => ESC_MAP[c]) : s;
  }
  return ESC_TEST_PART.test(s) ? s.replace(ESC_PART, (c) => ESC_MAP[c]) : s;
}

// Decode numeric character references in inline text. A bare & that does
// not start a reference becomes &amp;. Named references are left alone
// (marked keeps them as-is; only numeric ones are decoded).
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeRefs(s) {
  // A numeric reference needs '&#' first; most text has none.
  if (s.indexOf('&#') === -1 || !NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Encode a link/image href the way marked does: encodeURI, then put back
// %25 as %. Returns null when the URI cannot be encoded.
const PCT25 = /%25/g;
// encodeURI only escapes characters outside this set, and its only
// change inside it is % -> %25, which the %25 -> % step undoes — so
// for such a href the result is the input unchanged.
const HREF_SAFE = /^[A-Za-z0-9;,/?:@&=+$\-_.!~*'()#%]*$/;
function encodeHref(href) {
  if (HREF_SAFE.test(href)) return href;
  try {
    return encodeURI(href).replace(PCT25, '%');
  } catch {
    return null;
  }
}

// Normalize a link reference label: trim, collapse inner whitespace to
// single spaces, then case-fold (lower then upper then lower, as marked).
const WS_RUN = /\s+/g;
function normLabel(s) {
  // Fast path: printable ASCII, no uppercase, no whitespace — the trim,
  // whitespace collapse and case fold are all identities then.
  if (!/[^!-~]|[A-Z]/.test(s)) return s;
  return s.trim().replace(WS_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove a backslash before any punctuation character.
const BACKSLASH_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapePunct(s) {
  return s.indexOf('\\') === -1 ? s : s.replace(BACKSLASH_PUNCT, '$1');
}

// Expand tabs to spaces, tracking the visual column (tab stops of 4).
function expandTabs(s, col) {
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Strip trailing characters equal to `ch` from the end of `s`.
function stripTrail(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Drop trailing blank lines, keeping at most one (marked's rule for
// indented code blocks and raw HTML blocks).
const BLANK_LINE = /^[ \t]*$/;
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// Parenthesis balance check used for link destinations: scans `s` for the
// first unmatched close paren of the pair, skipping backslash escapes.
// Returns its index, -2 when an opener is left unmatched, -1 when balanced.
function parenBalance(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split one table row on unescaped pipes. With `count`, the result is
// padded with '' or cut down to exactly that many cells.
const PIPE = /\|/g;
function splitRow(s, count) {
  // Fast path: with no backslash no pipe can be escaped, so the cells
  // are just s split on '|' (the trim loop below finishes the job).
  const noBS = s.indexOf('\\') === -1;
  const cells = noBS ? s.split('|') : s.replace(PIPE, (m, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  }).split(' |');
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = noBS ? cells[i].trim() : cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ------------------------------------------------------------------
// Block grammar (GFM). These patterns are the CommonMark/GFM rules;
// each tokenizer below anchors on the start of the remaining source.
// ------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const reBlank = /^(?:[ \t]*(?:\n|$))+/;
const reIndentedCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const reFence = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const reHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const reAtx = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const reHtmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Raw HTML block (7 CommonMark types): script/pre/style/textarea,
// comment, processing instruction, declaration, CDATA, block-level tag
// runs, and other tags. Built from the same alternation marked uses.
const reHtmlBlock = new RegExp(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|comment[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|<(?!((?:script|pre|style|textarea)(?![a-z0-9-])))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
  '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i'
).source
  .replace('comment', reHtmlComment.source)
  .replace('tag', BLOCK_TAGS)
  .replace(
    'attribute',
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/.source
  );
const reHtml = new RegExp(reHtmlBlock, 'i');

// Link reference definition: [label]: <dest> or dest, optional title.
const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/.source;
const TITLE_PAT = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/.source;
const reDef = new RegExp(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)'
    .replace('label', LABEL_INNER)
    .replace('title', TITLE_PAT)
);

// Non-capturing twin of the hr pattern: used inside other patterns where
// a capturing group would shift the group numbers that follow it (marked
// does the same in its setext rule).
const HR_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';

// GFM table: header line, delimiter line, then body rows. The html
// alternative is built once (it holds the block-tag list) and is
// substituted last, so later substitutions never touch the tag names.
const HTML_ALT =
  ' {0,3}(?:</?(?:' +
  BLOCK_TAGS +
  ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const reTable = buildPattern(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  [
    [/hr/g, reHr],
    [/heading/g, ' {0,3}#{1,6}(?:\\s|$)'],
    [/blockquote/g, ' {0,3}>'],
    [/code/g, '(?: {4}| {0,3}\t)[^\\n]'],
    [/fences/g, ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    [/list/g, ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
    [/html/g, HTML_ALT],
  ]
);

// Setext heading, GFM flavour: the text may not itself start a block
// construct, and the underline may not be interrupted by one either.
const reSetextBase = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const reSetext = buildPattern(reSetextBase, [
  [/bull/g, ' {0,3}(?:[*+-]|\\d{1,9}[.)])'],
  [/blockCode/g, '(?: {4}| {0,3}\\t)'],
  [/fences/g, ' {0,3}(?:`{3,}|~{3,})'],
  [/blockquote/g, ' {0,3}>'],
  [/heading/g, ' {0,3}#{1,6}(?:\\s|$)'],
  [/hr/g, HR_NC],
  [/html/g, ' {0,3}<[^\\n>]+>\\n'],
  [/\|table/g, ''],
]);

// A paragraph: lines of text that do not start (or continue into) another
// block construct. Only a "1." / "1)" ordered list may interrupt one.
const reParagraphBase = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const reParagraph = buildPattern(reParagraphBase, [
  [/\|lheading/g, ''],
  [/hr/g, reHr],
  [/heading/g, ' {0,3}#{1,6}(?:\\s|$)'],
  [/blockquote/g, ' {0,3}>'],
  [/fences/g, ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  [/list/g, ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
  [/html/g, HTML_ALT],
  [/table/g, reTable],
]);

const reText = /^[^\n]+/;
const reListStart = /^ {0,3}(?:[*+-]|\d{1,9}[.)])([ \t][^\n]*?)?(?:\n|$)/;
const reBullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

// Blockquote: lines beginning with `>`, plus lazy continuation lines.
// Its inner paragraph pattern lets any list marker interrupt a line.
const reBQParagraph = buildPattern(reParagraphBase, [
  [/\|lheading/g, ''],
  [/hr/g, HR_NC],
  [/heading/g, ' {0,3}#{1,6}(?:\\s|$)'],
  [/blockquote/g, ' {0,3}>'],
  [/fences/g, ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  [/list/g, ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'],
  [/html/g, HTML_ALT],
  [/\|table/g, ''],
]);
const reBlockquote = buildPattern(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+',
  [[/paragraph/g, reBQParagraph]]
);

// Small patterns used inside the blockquote and list tokenizers.
const reBQStart = /^ {0,3}>/;
const reBQMarkerWs = /^( {0,3}>)([ \t]+)/gm;
const reBQSetext = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const reBQStrip = /^ {0,3}>[ \t]?/gm;
const reCodeIndent = /^(?: {0,3}\t| {1,4})/gm;
const reFenceIndent = /^(\s+)(?:```)/;
const reLeadWs = /^[ \t]+/;
const reNonSpace = /[^ ]/;
const reBlankOrEnd = /^[ \t]*$/;
const reDoubleBlank = /\n[ \t]*\n[ \t]*$/;
const reAnyLine = /\n.*\n/;
const reListTask = /^\[[ xX]\][ \t]+\S/;
const reListTaskStrip = /^\[[ xX]\][ \t]+/;
const reCheckbox = /\[[ xX]\]/;
const reSetextLine = /^ {0,3}(?:=+|-+) *$/;
const reAngleStart = /^</;
const reAngleEnd = />$/;
const reHrefBrackets = /^<(.*)>$/;
const reTableDelim = /[:|]/;
const reTableEdge = /^\||\| *$/g;
const reAlignRight = /^ *-+: *$/;
const reAlignCenter = /^ *:-+: *$/;
const reAlignLeft = /^ *:-+ *$/;
const reEndingHash = /#$/;
const reEndingSpace = / $/;
const reStartSpace = /^ /;
const reListNesting = /^ {1,4}(?=( {4})*[^ ])/g;


// ------------------------------------------------------------------
// Block lexer. Turns the source into block tokens; inline content is
// queued and lexed afterwards, once every link definition is known.
// A token's `tokens` field is filled by the queue step, not here.
// ------------------------------------------------------------------

// Per-document lexer state shared by the block and inline passes.
function newCtx() {
  return {
    links: Object.create(null), // normalized label -> {href, title}
    linkDefs: 0,                // link definitions registered so far
    queue: [],                  // inline jobs: {src, tokens}
    top: true,                  // inside a top-level (paragraph) context
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
}

// Queue one inline lexing job and return the token array it will fill.
function queueInline(ctx, src) {
  const tokens = [];
  ctx.queue.push({ src, tokens });
  return tokens;
}

// --- individual block tokenizers (each returns a token or null) ---

function tokSpace(src) {
  const m = reBlank.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  return null;
}

function tokIndentedCode(src) {
  const m = reIndentedCode.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(reCodeIndent, '') };
}

function tokFences(src) {
  const m = reFence.exec(src);
  if (!m) return null;
  let text = m[3] || '';
  const ind = m[0].match(reFenceIndent);
  if (ind !== null) {
    const pad = ind[1];
    text = text.split('\n').map((line) => {
      const ws = line.match(reLeadWs);
      if (ws === null) return line;
      return line.slice(Math.min(ws[0].length, pad.length));
    }).join('\n');
  }
  return {
    type: 'code',
    raw: m[0],
    lang: m[2] ? unescapePunct(m[2].trim()) : m[2],
    text,
  };
}

function tokHeading(src, ctx) {
  const m = reAtx.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (reEndingHash.test(text)) {
    const stripped = stripTrail(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return {
    type: 'heading',
    raw: stripTrail(m[0], '\n'),
    depth: m[1].length,
    text,
    tokens: queueInline(ctx, text),
  };
}

function tokHr(src) {
  const m = reHr.exec(src);
  if (!m) return null;
  return { type: 'hr', raw: stripTrail(m[0], '\n') };
}

function tokHtml(src) {
  const m = reHtml.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
    text: raw,
  };
}

function tokDef(src) {
  const m = reDef.exec(src);
  if (!m) return null;
  if (!reAngleStart.test(m[2]) && parenBalance(m[2], '()') !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2] ? unescapePunct(m[2].replace(reHrefBrackets, '$1')) : '';
  const title = m[3] ? unescapePunct(m[3].substring(1, m[3].length - 1)) : m[3];
  return { type: 'def', tag, raw: stripTrail(m[0], '\n'), href, title };
}

function tokTable(src, ctx) {
  const m = reTable.exec(src);
  if (!m || !reTableDelim.test(m[2])) return null;
  const headerCells = splitRow(m[1]);
  const delimCells = m[2].replace(reTableEdge, '').split('|');
  const bodyLines = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  if (headerCells.length !== delimCells.length) return null;
  const tok = { type: 'table', raw: stripTrail(m[0], '\n'), header: [], align: [], rows: [] };
  for (const cell of delimCells) {
    if (reAlignRight.test(cell)) tok.align.push('right');
    else if (reAlignCenter.test(cell)) tok.align.push('center');
    else if (reAlignLeft.test(cell)) tok.align.push('left');
    else tok.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    tok.header.push({ text: headerCells[i], tokens: queueInline(ctx, headerCells[i]), header: true, align: tok.align[i] });
  }
  for (const line of bodyLines) {
    tok.rows.push(
      splitRow(line, tok.header.length).map((cell, i) => ({
        text: cell,
        tokens: queueInline(ctx, cell),
        header: false,
        align: tok.align[i],
      }))
    );
  }
  return tok;
}

function tokSetext(src, ctx) {
  // Cheap guard: a setext underline must be a line of only = or - (up to
  // 3 leading spaces) inside the upcoming paragraph, before its first
  // blank line. Without one the full regex cannot match.
  let p = src.indexOf('\n');
  if (p === -1) return null;
  p += 1;
  let found = false;
  while (p < src.length) {
    let e = src.indexOf('\n', p);
    if (e === -1) e = src.length;
    const line = src.slice(p, e);
    if (/^[ \t]*$/.test(line)) break;
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) { found = true; break; }
    p = e + 1;
  }
  if (!found) return null;
  const m = reSetext.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  return {
    type: 'heading',
    raw: stripTrail(m[0], '\n'),
    depth: m[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(ctx, text),
  };
}

function tokParagraph(src, ctx) {
  const m = reParagraph.exec(src);
  if (!m) return null;
  let text = m[1];
  if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(ctx, text) };
}

function tokText(src, ctx) {
  const m = reText.exec(src);
  if (!m) return null;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(ctx, m[0]) };
}

// Blockquote: strips the `>` markers, then re-lexes the inner text.
// Lazy continuation lines and nested blockquotes/lists are handled by
// re-lexing the combined remainder when the inner pass ends in one.
function tokBlockquote(src, ctx) {
  const m = reBlockquote.exec(src);
  if (!m) return null;
  let lines = stripTrail(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let chunk = [];
    let seen = false;
    let p = 0;
    for (; p < lines.length; p++) {
      if (reBQStart.test(lines[p])) { chunk.push(lines[p]); seen = true; }
      else if (!seen) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const inner = joined
      .replace(reBQMarkerWs, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(reBQSetext, '\n    $1')
      .replace(reBQStrip, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + inner : inner;
    const savedTop = ctx.top;
    ctx.top = true;
    lexBlocks(inner, ctx, true, tokens);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last) break;
    if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
    if (last.type === 'blockquote') {
      const rest = lines.join('\n');
      const combined = last.raw + '\n' + rest.replace(reBQStrip, '');
      const merged = tokBlockquote(combined, ctx);
      tokens[tokens.length - 1] = merged;
      const tail = combined.substring(merged.raw.length).replace(/^\n/, '');
      const tailLines = tail ? tail.split('\n').length : 0;
      const consumed = tailLines ? lines.slice(0, lines.length - tailLines) : lines;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + merged.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && reBQStart.test(lines[0])) continue;
      break;
    }
    if (last.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const merged = tokList(combined, ctx);
      tokens[tokens.length - 1] = merged;
      const extra = merged.raw.length > last.raw.length
        ? combined.slice(last.raw.length + 1, merged.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const add = lines.slice(0, extra).join('\n');
        raw += '\n' + add;
        text += '\n' + add;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}


// List: collects items, computes each item's content indent, gathers
// continuation lines, then lexes every item's text as blocks.
// Item-start regexes, one per bullet shape (a list's marker never
// changes mid-list, so building one per tokList call was pure overhead).
const ITEM_RE = {
  '*': /^( {0,3}\*)((?:[ \t][^\n]*)?(?:\n|$))/,
  '+': /^( {0,3}\+)((?:[ \t][^\n]*)?(?:\n|$))/,
  '-': /^( {0,3}\-)((?:[ \t][^\n]*)?(?:\n|$))/,
  '.': /^( {0,3}\d{1,9}\.)((?:[ \t][^\n]*)?(?:\n|$))/,
  ')': /^( {0,3}\d{1,9}\))((?:[ \t][^\n]*)?(?:\n|$))/,
};

// Count of leading ' ' characters (the string must have no leading tab;
// list lines are tab-expanded before this is called).
function countLeadingSpaces(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  return i;
}

// Expand leading tabs to spaces (column 0); a no-op when the leading
// whitespace run has no tab. The run is scanned by hand: a regex exec
// per line was measurable in list-heavy inputs.
function expandLeading(cur) {
  if (cur.charCodeAt(0) !== 32 && cur.charCodeAt(0) !== 9) return cur;
  let i = 0;
  while (i < cur.length) {
    const c = cur.charCodeAt(i);
    if (c === 9) break;
    if (c !== 32) return cur;
    i++;
  }
  if (i >= cur.length || cur.charCodeAt(i) !== 9) return cur;
  return cur.replace(reLeadWs, (ws) => expandTabs(ws, 0));
}

// Break-test regexes for list items, pre-built once per clamped indent
// value (0..3) so tokList never constructs a RegExp per item.
function makeListBreak(bi) {
  return {
    nextBullet: new RegExp(`^ {0,${bi}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
    hr: new RegExp(`^ {0,${bi}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
    fence: new RegExp(`^ {0,${bi}}(?:\`\`\`|~~~)`),
    heading: new RegExp(`^ {0,${bi}}#{1,6}(?:\\s|$)`),
    html: new RegExp(
      `^ {0,${bi}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i'
    ),
    bq: new RegExp(`^ {0,${bi}}>`),
  };
}
const LIST_BREAK = [makeListBreak(0), makeListBreak(1), makeListBreak(2), makeListBreak(3)];

// Manual equivalent of /\n[ \t]*\n[ \t]*$/ (a double blank line at the end).
function hasDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s.charCodeAt(i - 1) === 32 || s.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || s.charCodeAt(i - 1) !== 10) return false;
  let j = i - 1;
  while (j > 0 && (s.charCodeAt(j - 1) === 32 || s.charCodeAt(j - 1) === 9)) j--;
  if (j === 0 || s.charCodeAt(j - 1) !== 10) return false;
  return true;
}

// Does a line start a block construct that ends a list item (or a lazy
// continuation line)? The construct must start within the first `bi`
// spaces, so one look at the first non-space character tells which
// regexes can possibly match — the others are skipped outright.
function lineBreaks(cur, br, bi, mask) {
  let k = 0;
  while (k <= bi && cur.charCodeAt(k) === 32) k++;
  if (k > bi) return false;
  const c = cur.charCodeAt(k);
  if (c === 96 || c === 126) return (mask & 1) !== 0 && br.fence.test(cur);
  if (c === 35) return (mask & 2) !== 0 && br.heading.test(cur);
  if (c === 60) return (mask & 4) !== 0 && br.html.test(cur);
  if (c === 62) return (mask & 8) !== 0 && br.bq.test(cur);
  if (c === 42 || c === 45) {
    return ((mask & 16) !== 0 && br.nextBullet.test(cur)) || ((mask & 32) !== 0 && br.hr.test(cur));
  }
  if (c === 43 || (c >= 48 && c <= 57)) return (mask & 16) !== 0 && br.nextBullet.test(cur);
  if (c === 95) return (mask & 32) !== 0 && br.hr.test(cur);
  return false;
}

function tokList(src, ctx) {
  const open = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/.exec(src);
  if (!open) return null;
  let rest = src;
  const startLen = src.length;
  const marker = open[1].trim();
  const ordered = marker.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const itemRe = ordered ? ITEM_RE[marker.slice(-1)] : ITEM_RE[marker];
  let gapSeen = false; // a double blank line was seen in an earlier item
  while (rest) {
    let blankItem = false;
    const itemParts = [];
    const it = itemRe.exec(rest);
    if (!it || reHr.test(rest)) break;
    const itemStart = startLen - rest.length;
    rest = rest.substring(it[0].length);
    const nl2 = it[2].indexOf('\n');
    let prevLine = nl2 === -1 ? it[2] : it[2].slice(0, nl2);
    const bulletW = it[1].length;
    prevLine = prevLine.replace(reLeadWs, (ws) => expandTabs(ws, bulletW));
    const nl3 = rest.indexOf('\n');
    const nextLine = nl3 === -1 ? rest : rest.slice(0, nl3);
    let prevBlank = !prevLine.trim();
    let indent;
    if (prevBlank) {
      indent = bulletW + 1;
      itemParts.push(prevLine);
    } else {
      indent = prevLine.search(reNonSpace);
      indent = indent > 4 ? 1 : indent;
      itemParts.push(prevLine.slice(indent));
      prevLine = prevLine.slice(indent);
      indent += bulletW;
    }
    if (prevBlank && reBlankOrEnd.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      blankItem = true;
    }
    if (!blankItem) {
      // Break-test regexes: marked clamps the allowed leading spaces to
      // clamp(indent - 1, 0, 3) — a construct at the item's own content
      // indent belongs to the item, only one with fewer spaces breaks out.
      const bi = Math.max(0, Math.min(3, indent - 1));
      const br = LIST_BREAK[bi];
      const nextBulletRe = br.nextBullet;
      const hrRe = br.hr;
      const fenceRe = br.fence;
      const headingRe = br.heading;
      const htmlRe = br.html;
      const bqRe = br.bq;
      while (rest) {
        const nl = rest.indexOf('\n');
        const cur = nl === -1 ? rest : rest.slice(0, nl);
        const expanded = expandLeading(cur);
        if (lineBreaks(cur, br, bi, 63)) break;
        const content = expanded.slice(indent);
        if (countLeadingSpaces(expanded) >= indent || !cur.trim()) {
          itemParts.push(content);
        } else {
          const prevNoTab = prevLine.indexOf('\t') === -1 ? prevLine : prevLine.replace(/\t/g, '    ');
          if (prevBlank || countLeadingSpaces(prevNoTab) >= 4 || lineBreaks(prevLine, br, bi, 39)) break;
          let q = cur;
          if (reSetextLine.test(cur) && reSetext.test(prevLine + '\n' + cur)) {
            q = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          itemParts.push(q);
        }
        prevBlank = !cur.trim();
        rest = nl === -1 ? '' : rest.substring(nl + 1);
        prevLine = content;
      }
    }
    const itemRaw = src.slice(itemStart, startLen - rest.length);
    if (!list.loose) {
      if (gapSeen) list.loose = true;
      else if (hasDoubleBlank(itemRaw)) gapSeen = true;
    }
    const itemText = itemParts.join('\n');
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: reListTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = src.slice(0, startLen - rest.length).trimEnd();
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = lexBlocks(item.text, ctx, false);
    if (!list.loose) {
      for (const t of item.tokens) {
        if (t.type === 'space' && reAnyLine.test(t.raw)) { list.loose = true; break; }
      }
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
      item.text = item.text.replace(reListTaskStrip, '');
      first.raw = first.raw.replace(reListTaskStrip, '');
      first.text = first.text.replace(reListTaskStrip, '');
      for (let g = ctx.queue.length - 1; g >= 0; g--) {
        if (reListTask.test(ctx.queue[g].src)) {
          ctx.queue[g].src = ctx.queue[g].src.replace(reListTaskStrip, '');
          break;
        }
      }
      const cb = reCheckbox.exec(item.raw);
      if (cb) {
        const chk = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = chk.checked;
        // The checkbox goes inside the first paragraph when the LIST is
        // loose (marked checks the list flag here, before items are
        // marked loose below); otherwise it stays a top-level token.
        if (list.loose) {
          if (first && (first.type === 'paragraph' || first.type === 'text') && first.tokens) {
            first.raw = chk.raw + first.raw;
            first.text = chk.raw + first.text;
            first.tokens.unshift(chk);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: chk.raw, text: chk.raw, tokens: [chk] });
          }
        } else {
          item.tokens.unshift(chk);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// Cheap necessary condition for a GFM table: the second line must be a
// delimiter line (only | : - and spaces, with at least one -). Most
// inputs fail it, so the big table regex never runs on them.
function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let i = nl + 1;
  const end = src.indexOf('\n', i);
  const stop = end === -1 ? src.length : end;
  let hasDash = false;
  for (; i < stop; i++) {
    const c = src.charCodeAt(i);
    if (c === 45) hasDash = true;
    else if (c !== 124 && c !== 58 && c !== 32) return false;
  }
  return hasDash;
}

// The block loop: tries each tokenizer in order and advances the source.
// Merges a paragraph or indented code block into a preceding paragraph
// or text token, and a definition into a preceding paragraph, exactly
// as the reference does; a definition elsewhere registers its link.
function lexBlocks(src, ctx, nested, out) {
  const toks = out || [];
  while (src) {
    const before = src.length;
    // Dispatch on the first non-space character (at most 3 leading
    // spaces): most tokenizers can only match one start, so trying the
    // others is pure overhead. The guards keep the original order.
    let sp = 0;
    while (sp < 4 && sp < src.length && src.charCodeAt(sp) === 32) sp++;
    const fc = sp < src.length ? src.charCodeAt(sp) : -1;
    const tryIndented = sp >= 4 || fc === 9;
    const tryFences = fc === 96 || fc === 126;
    const tryHeading = fc === 35;
    const tryHr = fc === 45 || fc === 95 || fc === 42;
    const tryBlockquote = fc === 62;
    const tryList = fc === 42 || fc === 45 || fc === 43 || (fc >= 48 && fc <= 57);
    const tryHtml = fc === 60;
    const tryDef = fc === 91;
    let tok = tokSpace(src);
    if (tok) {
      src = src.slice(tok.raw.length);
      const prev = toks[toks.length - 1];
      if (tok.raw.length === 1 && prev) prev.raw += '\n';
      else toks.push(tok);
    } else if (tryIndented && (tok = tokIndentedCode(src))) {
      src = src.slice(tok.raw.length);
      const prev = toks[toks.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        toks.push(tok);
      }
    } else if (tryFences && (tok = tokFences(src))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if (tryHeading && (tok = tokHeading(src, ctx))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if (tryHr && (tok = tokHr(src))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if (tryBlockquote && (tok = tokBlockquote(src, ctx))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if (tryList && (tok = tokList(src, ctx))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if (tryHtml && (tok = tokHtml(src))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if (tryDef && (tok = tokDef(src))) {
      src = src.slice(tok.raw.length);
      const prev = toks[toks.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        if (!Object.hasOwn(ctx.links, tok.tag)) {
          ctx.links[tok.tag] = { href: tok.href, title: tok.title };
          ctx.linkDefs++;
        }
        toks.push(tok);
      }
    } else if (tablePossible(src) && (tok = tokTable(src, ctx))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if ((tok = tokSetext(src, ctx))) {
      src = src.slice(tok.raw.length);
      toks.push(tok);
    } else if (ctx.top && (tok = tokParagraph(src, ctx))) {
      src = src.slice(tok.raw.length);
      const prev = toks[toks.length - 1];
      if (nested && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        toks.push(tok);
      }
      // With no extensions the paragraph consumed exactly the input it
      // was given, so a later paragraph in this same pass cannot merge
      // into this one; only the first paragraph of a nested pass may.
      nested = false;
    } else if ((tok = tokText(src, ctx))) {
      src = src.slice(tok.raw.length);
      const prev = toks[toks.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue[ctx.queue.length - 1].src = prev.text;
      } else {
        toks.push(tok);
      }
    }
    if (src.length === before) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return toks;
}


// ------------------------------------------------------------------
// Inline grammar (GFM). Patterns are built from small templates by
// textual substitution, the same way the reference builds its own.
// ------------------------------------------------------------------

// Substitute named placeholders in a pattern source, in order, and
// build a RegExp. A `^` at the start of (or after a non-`[` in) a
// substituted fragment is dropped, since it would anchor wrongly.
function buildPattern(source, subs, flags) {
  let src = typeof source === 'string' ? source : source.source;
  for (const [name, rep] of subs) {
    const r = typeof rep === 'string' ? rep : rep.source;
    src = src.replace(name, () => r.replace(/(^|[^\[])\^/g, '$1'));
  }
  return new RegExp(src, flags);
}

// Character classes used by the emphasis / strikethrough rules.
const PUNCT = '[\\p{P}\\p{S}]'; // any punctuation or symbol
const PUNCT_NO_TILDE = '(?!~)[\\p{P}\\p{S}]'; // GFM: ~ is not punctuation
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_NO_TILDE = '(?!~)[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_TILDE = '(?:[^\\s\\p{P}\\p{S}]|~)';

const reIsPunct = /[\p{P}\p{S}]/u;
const reIsPunctSpace = /^(?![*_])[\s\p{P}\p{S}]/u;
const reIsAlnum = /[\p{L}\p{N}]/u;
// ASCII punctuation/symbol or whitespace, except * and _ (the regex
// above excludes them): a table lookup replaces a regex test per call.
const PUNCT_SPACE_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) PUNCT_SPACE_ASCII[c] = 1;
for (let c = 33; c <= 47; c++) PUNCT_SPACE_ASCII[c] = 1;
for (let c = 58; c <= 64; c++) PUNCT_SPACE_ASCII[c] = 1;
for (let c = 91; c <= 96; c++) PUNCT_SPACE_ASCII[c] = 1;
for (let c = 123; c <= 126; c++) PUNCT_SPACE_ASCII[c] = 1;
PUNCT_SPACE_ASCII[42] = 0;
PUNCT_SPACE_ASCII[95] = 0;
function isPunctSpaceChar(ch) {
  if (ch === '') return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return PUNCT_SPACE_ASCII[code] === 1;
  return reIsPunctSpace.test(ch);
}

// --- inline token patterns ---
const reEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const reCodeSpan = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const reBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const reHtmlCommentInline = /<!--(?:-?>|[\s\S]*?-->)/;
const reTag = buildPattern(
  /^comment|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  [
    [/comment/g, reHtmlCommentInline],
    [/attribute/g, /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
  ]
);

// A link label: nested brackets, escapes, code spans, or plain text.
const LABEL_SRC = '(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]`])*?';
const LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const reLabel = buildPattern(LABEL_SRC, [[/brackets/g, LABEL_BRACKETS]]);

const HREF_SRC = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const reLink = buildPattern(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  [
    [/label/g, reLabel],
    [/href/g, HREF_SRC],
    [/title/g, TITLE_SRC],
  ]
);

const REF_SRC = '(?:(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n)))+';
const reReflink = buildPattern(/^!?\[(label)\]\[(ref)\]/, [
  [/label/g, reLabel],
  [/ref/g, REF_SRC],
]);
const reNolink = buildPattern(/^!?\[(ref)\](?:\[\])?/, [[/ref/g, REF_SRC]]);

const EMAIL_SRC = "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])";
const reAutolink = buildPattern(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, [
  [/scheme/g, /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
  [/email/g, EMAIL_SRC],
]);

const reUrl = buildPattern(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
  [
    [/emailProtocol/g, buildPattern(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, [[/email/g, /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/]])],
    [/protocol/g, /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/],
    [/email/g, /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/],
  ]
);
const reBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Plain text: consumes up to the next inline construct.
const reInlineText = buildPattern(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  [
    [/emailProtocol/g, /(?:mailto|xmpp):/],
    [/protocol/g, /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/],
    [/wwwStart/g, /(?<![^\s*_~(])www\./],
  ]
);

// Emphasis delimiters (GFM flavours = marked's `ie` ruleset, NOT the
// pedantic `Et` one): left delimiter `lt` (no open-quote check, `~` is not
// punctuation), right asterisk `ht`, right underscore `mt`. Note the
// underscore form has NO intraword closer alternative.
const reEmL = buildPattern(
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  [[/punct/g, PUNCT_NO_TILDE]],
  'u'
);
const EM_R_AST_SRC =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const reEmRAst = buildPattern(EM_R_AST_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE],
  [/punctSpace/g, PUNCT_SPACE_NO_TILDE],
  [/punct/g, PUNCT_NO_TILDE],
], 'gu');
const EM_R_UND_SRC =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const reEmRUnd = buildPattern(EM_R_UND_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
], 'gu');

// Strikethrough delimiters.
const reDelL = buildPattern(/^~~?(?:((?!~)punct)|[^\s~])/, [[/punct/g, PUNCT]], 'u');
const DEL_R_SRC =
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const reDelR = buildPattern(DEL_R_SRC, [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
], 'gu');

// Masking: hide code spans, links, tags and backslash escapes from the
// emphasis / strikethrough scan, keeping every length so indices line up.
const reMaskCode = buildPattern(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  [[/punct/g, PUNCT]],
  'gu'
);
const reMaskLink = /\[(?:[^\[\]`]|`+[^`]*`+)*?\]\((?:\\[\s\S]|[^()\\]|\((?:\\[\s\S]|[^()\\])*\))*\)/g;
const reMaskTag = /<(?! )[^<>]*?>/g;
const reReflinkSearch = buildPattern(/reflink|nolink(?!\()/, [
  [/reflink/g, buildPattern(/^!?\[(label)\]\[(ref)\]/, [[/label/g, reLabel], [/ref/g, REF_SRC]])],
  [/nolink/g, buildPattern(/^!?\[(ref)\](?:\[\])?/, [[/ref/g, REF_SRC]])],
], 'g');
const reLinkStart = /^!?\[/;

// Does `src` contain a link (inline or reference) anywhere?
function linkInText(src, ctx) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(reBlockSkip)) {
    if (reLink.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(reReflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    const refKnown = s.charAt(0) !== '!' && Object.hasOwn(ctx.links, normLabel(s.slice(r + 1, -1)));
    if (refKnown && !(r > 1 && linkInText(s.slice(1, r - 1), ctx))) return true;
  }
  return false;
}

// Matches a whole inline link, a code span, or an HTML tag, for masking.
const reBlockSkip = buildPattern(/link|precode-code|html/, [
  [/link/g, /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/],
  [/precode-/g, /(?<!`)()/],
  [/code/g, /(?<b>`+)[^`]+\k<b>(?!`)/],
  [/html/g, /<(?! )[^<>]*?>/],
], 'g');

// Matches a whole inline link or an HTML tag, for masking. (Code spans
// are left out: reMaskCode already hides their interior delimiters.)
const reBlockSkipLinks = buildPattern(/link|html/, [
  [/link/g, /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/],
  [/html/g, /<(?! )[^<>]*?>/],
], 'g');

function maskInline(src, ctx) {
  // No code span, backslash escape, link, or tag can hide a delimiter
  // here, so the mask is the source itself.
  if (!src.includes('`') && !src.includes('\\') && !src.includes('[') && !src.includes('<')) return src;
  let t = src;
  // Reference links can only resolve when a definition was registered;
  // with none, the masking below is a no-op (maskRef returns r as-is).
  if (ctx.linkDefs > 0 && src.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const label = r.slice(1, o - 1);
        if (linkInText(label, ctx)) {
          return '[' + label.replace(reReflinkSearch, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(reReflinkSearch, maskRef);
  }
  // A delimiter can only be hidden by the masks below; with none left
  // in t, scanClosers finds nothing and both masks are no-ops.
  const hasDelim = t.indexOf('*') !== -1 || t.indexOf('_') !== -1 || t.indexOf('~') !== -1;
  if (
    hasDelim &&
    (t.includes('`') || t.includes('\\'))
  ) {
    t = t.replace(reMaskCode, (m, ticks, punct) => {
      if (punct) return '+'.repeat(m.length);
      // Hide every delimiter inside the code span, so emphasis scanning
      // never sees it; the ticks themselves stay as anchors.
      if (ticks) return ticks + m.slice(ticks.length, -ticks.length).replace(/[*_~`]/g, '+') + ticks;
      return m;
    });
  }
  // Links and tags only need masking when a delimiter could hide in one.
  if (hasDelim && (t.includes('](') || t.includes('<'))) {
    t = t.replace(reBlockSkipLinks, (m) => '[' + 'a'.repeat(Math.max(0, m.length - 2)) + ']');
  }
  return t;
}

// Last index in the masked source where a closer run could start: the
// last run of each delimiter whose preceding character is not whitespace.
function scanClosers(masked) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  for (let s = 0; s < masked.length; s++) {
    const code = masked.charCodeAt(s);
    if (code !== 42 && code !== 95 && code !== 126) continue;
    const before = s === 0 ? 10 : masked.charCodeAt(s - 1);
    let i = s + 1;
    while (i < masked.length && masked.charCodeAt(i) === code) i++;
    if (before !== 32 && before !== 9 && before !== 10 && before !== 13 && before !== 12) {
      if (code === 126) lastDel = s;
      else lastEm[code === 42 ? '*' : '_'] = s;
    }
    s = i - 1;
  }
  return { lastEm, lastDel };
}

// --- inline tokenizers ---

function tryEscape(rest) {
  const m = reEscape.exec(rest);
  if (!m) return null;
  return { type: 'escape', raw: m[0], text: m[1] };
}

function tryTag(rest, ctx) {
  const m = reTag.exec(rest);
  if (!m) return null;
  if (!ctx.inLink && /^<a /i.test(m[0])) ctx.inLink = true;
  else if (ctx.inLink && /^<\/a>/i.test(m[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: ctx.inLink, inRawBlock: ctx.inRawBlock, block: false, text: m[0] };
}

// True when the link label holds a raw HTML tag or autolink that runs
// past the label's end, which disqualifies the whole link.
function linkLabelHasRawHtml(fullSrc, label, bangOffset) {
  if (!fullSrc.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const code = reCodeSpan.exec(label.slice(s));
      if (code) { s += code[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const tag = reTag.exec(fullSrc.slice(bangOffset + s)) || reAutolink.exec(fullSrc.slice(bangOffset + s));
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token from a matched label and destination. The
// label is lexed right now (not queued) so nested links are detected.
function makeLink(m, ref, raw, ctx) {
  const labelText = m[1].replace(/\\([\[\]])/g, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = lexInline(labelText, ctx);
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: ref.href,
    title: ref.title || null,
    text: labelText,
    tokens: inner,
  };
}

function tryLink(rest, ctx) {
  if (!ctx.linkParenPossible) return null;
  const m = reLink.exec(rest);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkLabelHasRawHtml(rest, m[1], bang)) return null;
  const href = m[2].trim();
  if (reAngleStart.test(href)) {
    if (!reAngleEnd.test(href)) return null;
    if ((href.length - stripTrail(href.slice(0, -1), '\\').length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m[2], '()');
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  if ((m[0].length - stripTrail(m[0].slice(0, -1), '\\').length) % 2 === 0) return null;
  let dest = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (reAngleStart.test(dest)) dest = dest.slice(1, -1);
  return makeLink(m, { href: dest && unescapePunct(dest), title: title && unescapePunct(title) }, m[0], ctx);
}

function tryReflink(rest, ctx) {
  const m = reReflink.exec(rest) || reNolink.exec(rest);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkLabelHasRawHtml(rest, m[1], bang)) return null;
  const ref = ctx.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLink(m, ref, m[0], ctx);
}

function tryCodeSpan(rest) {
  const m = reCodeSpan.exec(rest);
  if (!m) return null;
  let text = m[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: m[0], text };
}

function tryBr(rest) {
  const m = reBr.exec(rest);
  if (!m) return null;
  return { type: 'br', raw: m[0] };
}

function tryAutolink(rest) {
  const m = reAutolink.exec(rest);
  if (!m) return null;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tryUrl(rest) {
  const m = reUrl.exec(rest);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    let prev;
    do {
      prev = cur;
      cur = reBackpedal.exec(cur)?.[0] ?? '';
    } while (prev !== cur);
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

// Next inline-text stop: a TEXT_STOP character (a text token must end
// before it, so the next loop iteration can try the real tokenizer),
// a hard break (2+ spaces + newline), a www. start, or a URL scheme.
// One native scan replaces the old per-character loop in tryInlineText.
const TEXT_STOP_RE = /[\\<\[!`*~_]| {2,}\n|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\//g;

// EMAIL_CHAR: characters that may appear in an email local part.
const EMAIL_CHAR = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") EMAIL_CHAR[ch.charCodeAt(0)] = 1;

// True when `www.` starts at j and the character before it allows it
// (start of string, whitespace, *, _, ~, (, or ]).
function isWwwAt(s, j) {
  if (s.charCodeAt(j) !== 119 || s.charCodeAt(j + 1) !== 119 || s.charCodeAt(j + 2) !== 119 || s.charCodeAt(j + 3) !== 46) return false;
  if (j === 0) return true;
  const p = s.charCodeAt(j - 1);
  if (p === 32 || p === 9 || p === 10 || p === 13 || p === 11 || p === 12 || p === 42 || p === 95 || p === 126 || p === 40 || p === 93) return true;
  return p >= 128 && /\s/.test(s[j - 1]);
}

// Positions in `s` where an email address starts (local part + @), for
// positions after the very start — a text token must end before them so
// the email gets its own token. Computed once per inline string.
function findEmailStops(s) {
  const stops = [];
  let at = s.indexOf('@');
  while (at !== -1) {
    let st = at;
    while (st > 0 && s.charCodeAt(st - 1) < 128 && EMAIL_CHAR[s.charCodeAt(st - 1)]) st--;
    if (st < at && st > 0) stops.push(st);
    at = s.indexOf('@', at + 1);
  }
  return stops;
}

function tryInlineText(rest, ctx, offset, emailStops) {
  const n = rest.length;
  if (n === 0) return null;
  const c0 = rest.charCodeAt(0);
  // One non-alphanumeric character before mailto:/xmpp: — the text is
  // just that character, so the URL gets its own token next.
  const isAlnum0 = (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
  if (!isAlnum0 && n > 1 && (rest.startsWith('mailto:', 1) || rest.startsWith('xmpp:', 1))) {
    const raw = rest[0];
    const inRaw = ctx.inRawBlock;
    return { type: 'text', raw, text: inRaw ? raw : decodeRefs(raw), escaped: inRaw };
  }
  // First unit: a run of backticks, a run of tildes, or a single character.
  let i;
  if (c0 === 96) {
    i = 0;
    while (i < n && rest.charCodeAt(i) === 96) i++;
  } else if (c0 === 126) {
    i = 0;
    while (i < n && rest.charCodeAt(i) === 126) i++;
  } else {
    i = 1;
  }
  // First email start after this token's position, in rest coordinates.
  let emailStop = -1;
  for (let k = 0; k < emailStops.length; k++) {
    if (emailStops[k] > offset) { emailStop = emailStops[k] - offset; break; }
  }
  // The stop position: the first TEXT_STOP character, hard break (2+
  // spaces + newline), www. start or URL scheme — found with one native
  // regex scan instead of a per-character loop. A www. candidate is
  // only a stop with an allowed preceding character (isWwwAt).
  let stop = n;
  TEXT_STOP_RE.lastIndex = i;
  let sm;
  while ((sm = TEXT_STOP_RE.exec(rest)) !== null) {
    const p = sm.index;
    if (sm[0] === 'www.' && !isWwwAt(rest, p)) {
      TEXT_STOP_RE.lastIndex = p + 1;
      continue;
    }
    stop = p;
    break;
  }
  if (emailStop !== -1 && emailStop >= i && emailStop < stop) stop = emailStop;
  const raw = rest.slice(0, stop);
  const inRaw = ctx.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : decodeRefs(raw), escaped: inRaw };
}

// Emphasis / strong emphasis: find a closer run for the opener at the
// start of `rest`. `masked` is the whole inline source with code, links
// and tags hidden; `pos` is where `rest` starts inside it.
function tryEmStrong(rest, masked, pos, prevChar, closers, ctx) {
  const m = reEmL.exec(rest);
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const delim = m[0][0];
  let i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = l > 0 ? masked[l - 1] : '';
  const h = p === '*' || p === '_' || isPunctSpaceChar(p);
  const wasDelimBefore = prevChar === delim;
  let prev = prevChar;
  if (l < i) prev = p;
  const u = l < i ? h : isPunctSpaceChar(prev);
  if (m[4] && reIsAlnum.test(prev)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !prev || u) {
    // Opener run length, as [...m[0]].length - 1 but without the spread:
    // the run is ASCII; a trailing char (if any) is one code point.
    let run = 0;
    const dcode = delim.charCodeAt(0);
    while (run < m[0].length && m[0].charCodeAt(run) === dcode) run++;
    const k = run + (m[0].length > run ? 1 : 0) - 1; // opener run length
    let open = k;
    let extra = 0;
    const total = i - l + k;
    const oddOk = p.trim() !== '' && (!!d || (delim === '*' && !h));
    const rRe = delim === '*' ? reEmRAst : reEmRUnd;
    const lastPossible = closers.lastEm[delim];
    const scanStart = pos + k;
    if (lastPossible < scanStart) return null;
    const scanText = masked.slice(scanStart);
    const limit = lastPossible - scanStart;
    rRe.lastIndex = 0;
    let sm;
    while ((sm = rRe.exec(scanText)) !== null && sm.index <= limit) {
      const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
      if (!g) continue;
      const b = g.length; // delimiter run: ASCII only
      if (sm[3] || sm[4]) { open += b; continue; }
      if (sm[5] || sm[6] || oddOk) {
        if (wasDelimBefore && (sm[5] || sm[6])) break;
        if (total % 3 && (total + b) % 3 === 0) { extra += b; continue; }
      }
      open -= b;
      if (open > 0) continue;
      const take = Math.min(b, b + open + extra);
      // Length in UTF-16 units of the match's first code point.
      const firstLen = sm[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = rest.slice(0, k + sm.index + firstLen + take);
      if (Math.min(k, take) % 2 === 1) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: lexInline(inner, ctx) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: lexInline(inner, ctx) };
    }
  }
  return null;
}

// Strikethrough: the closer run must be exactly as long as the opener.
function tryDel(rest, masked, pos, prevChar, closers, ctx) {
  const m = reDelL.exec(rest);
  if (!m) return null;
  if (!((m[1] || '') === '' || !prevChar || isPunctSpaceChar(prevChar))) return null;
  // Opener run length, as [...m[0]].length - 1 but without the spread.
  let run = 0;
  while (run < m[0].length && m[0].charCodeAt(run) === 126) run++;
  const o = run + (m[0].length > run ? 1 : 0) - 1; // opener run length (1 or 2)
  let open = o;
  const lastPossible = closers.lastDel;
  const scanStart = pos + o;
  if (lastPossible < scanStart) return null;
  const scanText = masked.slice(scanStart);
  const limit = lastPossible - scanStart;
  reDelR.lastIndex = 0;
  let sm;
  while ((sm = reDelR.exec(scanText)) !== null && sm.index <= limit) {
    const g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
    if (!g) continue;
    const len = g.length; // tilde run: ASCII only
    if (len !== o) continue;
    if (sm[3] || sm[4]) { open += len; continue; }
    open -= len;
    if (open > 0) continue;
    const take = Math.min(len, len + open);
    // Length in UTF-16 units of the match's first code point.
    const firstLen = sm[0].codePointAt(0) > 0xFFFF ? 2 : 1;
    const raw = rest.slice(0, o + sm.index + firstLen + take);
    const inner = raw.slice(o, -o);
    return { type: 'del', raw, text: inner, tokens: lexInline(inner, ctx) };
  }
  return null;
}

// The inline loop: tries each inline tokenizer in order, merging
// consecutive text tokens, tracking the previous text character for
// the emphasis rules.
function lexInline(src, ctx) {
  const tokens = [];
  // Fast path: no inline construct can start in this string.
  if (!/[\\[`<*_~!]|www\.|:\/\/|@|mailto:|xmpp:| {2,}\n/.test(src)) {
    tokens.push({ type: 'text', raw: src, text: decodeRefs(src) });
    return tokens;
  }
  const savedLPP = ctx.linkParenPossible;
  ctx.linkParenPossible = savedLPP && src.includes(')');
  // tryUrl can only match when the text holds @, ://, or a www. start;
  // checking once here lets the loop skip it for plain prose.
  const hasAt = src.includes('@');
  const hasProto = src.includes('://');
  const emailStops = hasAt ? findEmailStops(src) : [];
  let maskedCache = null;
  let closersCache = null;
  const masked = () => {
    if (maskedCache === null) maskedCache = maskInline(src, ctx);
    return maskedCache;
  };
  const closers = () => {
    if (closersCache === null) closersCache = scanClosers(masked());
    return closersCache;
  };
  try {
    let rest = src;
    let offset = 0;
    let prev = '';
    let prevWasText = false;
    while (rest) {
      const before = rest.length;
      if (!prevWasText) prev = '';
      prevWasText = false;
      let tok = null;
      let isText = false;
      // Dispatch on the first character: each tokenizer can only match
      // one of these starts, so trying the others is pure overhead.
      // Within a start the order below is marked's order.
      const c = rest.charCodeAt(0);
      if (c === 92) {
        // backslash: escape, then hard break (backslash-newline)
        if ((tok = tryEscape(rest))) {
          // plain escape token
        } else if ((tok = tryBr(rest))) {
          // hard break
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (c === 60) {
        // <: tag, then autolink
        if ((tok = tryTag(rest, ctx))) {
          // raw html tag
        } else if ((tok = tryAutolink(rest))) {
          // <...> autolink
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (c === 91) {
        // [: link, then reference link — all three need a ] to close
        // the label, so skip the (expensive, backtracking) patterns
        // outright when there is none after the [.
        if (rest.indexOf(']') !== -1 && (tok = tryLink(rest, ctx))) {
          // inline link / image
        } else if (rest.indexOf(']') !== -1 && (tok = tryReflink(rest, ctx))) {
          isText = tok.type === 'text';
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (c === 33) {
        // !: image link / image reference, only when followed by [
        if (rest.charCodeAt(1) === 91 && rest.indexOf(']') !== -1 && (tok = tryLink(rest, ctx))) {
          // inline link / image
        } else if (rest.charCodeAt(1) === 91 && rest.indexOf(']') !== -1 && (tok = tryReflink(rest, ctx))) {
          isText = tok.type === 'text';
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (c === 42 || c === 95) {
        // * _: emphasis / strong
        if ((tok = tryEmStrong(rest, masked(), offset, prev, closers(), ctx))) {
          // emphasis / strong
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (c === 96) {
        // backtick: code span
        if ((tok = tryCodeSpan(rest))) {
          // code span
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (c === 126) {
        // ~: strikethrough
        if ((tok = tryDel(rest, masked(), offset, prev, closers(), ctx))) {
          // strikethrough
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (c === 32) {
        // space: hard break (two spaces + newline)
        if ((tok = tryBr(rest))) {
          // hard break
        } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
          isText = true;
        }
      } else if (
        !ctx.inLink &&
        (hasAt || hasProto || rest.startsWith('www.')) &&
        (tok = tryUrl(rest))
      ) {
        // extended autolink (www., scheme://, email)
      } else if ((tok = tryInlineText(rest, ctx, offset, emailStops))) {
        isText = true;
      }
      if (!tok) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      if (isText) {
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else {
          tokens.push(tok);
        }
        const lastCh = tok.raw.slice(-1);
        if (lastCh !== '_') prev = lastCh;
        prevWasText = true;
      } else {
        tokens.push(tok);
      }
      rest = rest.slice(tok.raw.length);
      offset += tok.raw.length;
      if (rest.length === before) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    }
    return tokens;
  } finally {
    ctx.linkParenPossible = savedLPP;
  }
}


// ------------------------------------------------------------------
// Rendering. Tokens become the exact HTML strings marked produces.
// ------------------------------------------------------------------

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) out += renderBlock(tok);
  return out;
}

function renderBlock(tok) {
  switch (tok.type) {
    case 'space':
      return '';
    case 'code': {
      const lang = (tok.lang || '').match(/^\S*/)?.[0] || '';
      const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
      const inner = esc(body, true);
      return lang
        ? `<pre><code class="language-${esc(lang)}">${inner}</code></pre>\n`
        : `<pre><code>${inner}</code></pre>\n`;
    }
    case 'heading':
      return `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
    case 'list': {
      let out = '';
      for (const item of tok.items) out += renderListItem(item);
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
      return `<${tag}${start}>\n${out}</${tag}>\n`;
    }
    case 'checkbox':
      return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'html':
      return tok.text;
    case 'def':
      return '';
    case 'paragraph':
      return `<p>${renderInline(tok.tokens)}</p>\n`;
    case 'table': {
      let head = '';
      for (const cell of tok.header) head += renderTableCell(cell);
      let body = '';
      for (const row of tok.rows) {
        let cells = '';
        for (const cell of row) cells += renderTableCell(cell);
        body += `<tr>\n${cells}</tr>\n`;
      }
      return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body ? `<tbody>${body}</tbody>` : ''}</table>\n`;
    }
    case 'text':
      return renderTextToken(tok);
    default:
      throw new Error(`Token with "${tok.type}" type was not found.`);
  }
}

function renderListItem(item) {
  return `<li>${renderBlocks(item.tokens)}</li>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderInline(cell.tokens)}</${tag}>\n`;
}

// Plain-text rendering used for image alt text: no HTML, just the words.
function renderPlain(tokens) {
  let out = '';
  for (const tok of tokens) out += renderPlainToken(tok);
  return out;
}

function renderPlainToken(tok) {
  switch (tok.type) {
    case 'strong':
    case 'em':
    case 'del':
    case 'link':
    case 'image':
      return tok.tokens ? renderPlain(tok.tokens) : tok.text;
    case 'codespan':
    case 'html':
    case 'text':
      return tok.text;
    case 'br':
      return '';
    case 'checkbox':
      return tok.raw;
    default:
      return tok.text || '';
  }
}

function renderTextToken(tok) {
  if (tok.tokens) return renderInline(tok.tokens);
  if (tok.escaped) return tok.text;
  return esc(tok.text);
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) out += renderInlineToken(tok);
  return out;
}

function renderInlineToken(tok) {
  switch (tok.type) {
    case 'escape':
      return renderTextToken(tok);
    case 'html':
      return tok.text;
    case 'link': {
      const inner = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
      const href = encodeHref(tok.href);
      if (href === null) return inner;
      let out = `<a href="${esc(href, tok.autolink)}"`;
      if (tok.title) out += ` title="${esc(tok.title)}"`;
      return out + `>${inner}</a>`;
    }
    case 'image': {
      const alt = tok.tokens ? renderPlain(tok.tokens) : tok.text;
      const href = encodeHref(tok.href);
      if (href === null) return esc(alt);
      let out = `<img src="${esc(href)}" alt="${esc(alt)}"`;
      if (tok.title) out += ` title="${esc(tok.title)}"`;
      return out + '>';
    }
    case 'checkbox':
      return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'strong':
      return `<strong>${renderInline(tok.tokens)}</strong>`;
    case 'em':
      return `<em>${renderInline(tok.tokens)}</em>`;
    case 'codespan':
      return `<code>${esc(tok.text, true)}</code>`;
    case 'br':
      return '<br>';
    case 'del':
      return `<del>${renderInline(tok.tokens)}</del>`;
    case 'text':
      return renderTextToken(tok);
    default:
      throw new Error(`Token with "${tok.type}" type was not found.`);
  }
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

// Render `markdown` to HTML exactly as marked 18.1.3 does with its
// default options. Stateless across calls: no caches carry over.
export function parse(markdown) {
  const ctx = newCtx();
  const md = String(markdown);
  // Most inputs have no CR at all: skip the whole-string replace then.
  const src = md.indexOf('\r') === -1 ? md : md.replace(/\r\n|\r/g, '\n');
  const blocks = lexBlocks(src, ctx, false);
  for (let i = 0; i < ctx.queue.length; i++) {
    const job = ctx.queue[i];
    const toks = lexInline(job.src, ctx);
    for (const t of toks) job.tokens.push(t);
  }
  return renderBlocks(blocks);
}
