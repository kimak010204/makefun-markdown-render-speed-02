// Parser Markdown original (CommonMark 0.31.2 + GFM 0.29) yang meniru output
// marked 18.1.3 (default options). Ditulis dari nol berdasarkan spesifikasi
// dan perilaku yang teramati dari contoh-contoh kit; tidak menyalin kode
// marked. Dependency-free, ES module, parse() murni per panggilan.

// ---------- util ----------

function isSpaceCh(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}

function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

const PUNCT_RE = /\p{P}|\p{S}/u;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(ch);
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Baris whitespace-only yang mengandung TAB (mis. "\t") BUKAN baris kosong
// bagi tabel GFM marked: ia jadi baris tabel kosong (probe51). Baris hanya
// spasi / benar-benar kosong tetap mengakhiri tabel.
function isTabOnly(s) {
  let hasTab = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) hasTab = true;
    else if (c !== 32) return false;
  }
  return hasTab;
}

// Hitung indent (kolom) dari awal baris; tab melompat ke kelipatan 4.
function indentInfo(s) {
  let cols = 0;
  let pos = 0;
  while (pos < s.length) {
    const c = s.charCodeAt(pos);
    if (c === 32) {
      cols++;
      pos++;
    } else if (c === 9) {
      cols += 4 - (cols % 4);
      pos++;
    } else break;
  }
  return { cols, pos };
}

// Hapus `cols` kolom dari awal baris; tab yang terpotong jadi spasi.
// Tab-tab berikutnya setelah tab terpotong di-expand ke spasi memakai kolom
// ASLI (bukan kolom hasil strip), agar lebarnya tetap benar saat baris
// hasil strip diproses lagi (mis. indented code di dalam list item).
// Karakter non-whitespace dihitung 1 kolom (dipakai untuk strip prefix
// container seperti marker list / '>'), dan strip berhenti di karakter
// non-whitespace bila kolom belum tercapai.
function stripCols(s, cols) {
  if (cols <= 0) return s;
  let c = 0;
  let pos = 0;
  while (pos < s.length && c < cols) {
    const ch = s.charCodeAt(pos);
    if (ch === 9) {
      const w = 4 - (c % 4);
      if (c + w <= cols) {
        c += w;
        pos++;
      } else {
        // Tab terpotong: sisanya jadi spasi; expand whitespace awal
        // berikutnya ke spasi memakai kolom asli.
        let out = ' '.repeat(c + w - cols);
        c += w;
        pos++;
        while (pos < s.length) {
          const d = s.charCodeAt(pos);
          if (d === 32) {
            out += ' ';
            c++;
            pos++;
          } else if (d === 9) {
            const w2 = 4 - (c % 4);
            out += ' '.repeat(w2);
            c += w2;
            pos++;
          } else break;
        }
        return out + s.slice(pos);
      }
    } else {
      c++;
      pos++;
    }
  }
  return s.slice(pos);
}

// Hapus hingga `n` karakter whitespace awal (spasi/tab, masing-masing 1).
// Dipakai untuk strip indent konten fenced code: tab yang melewati batas
// indent dibuang seluruhnya (bukan jadi spasi parsial).
function stripFenceIndent(s, n) {
  let i = 0;
  while (i < n && i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return s.slice(i);
}

// Strip satu prefix blockquote ('>' + satu spasi/tab opsional) dari awal
// baris; null bila baris bukan baris quote.
function stripQuotePrefix(s) {
  const info = indentInfo(s);
  if (info.cols >= 4) return null;
  if (s.charCodeAt(info.pos) !== 62) return null;
  let stripN = info.cols + 1;
  const afterGt = info.pos + 1;
  if (afterGt < s.length) {
    const d = s.charCodeAt(afterGt);
    if (d === 32 || d === 9) stripN += 1;
  }
  return stripContainer(s, stripN);
}

// Seperti stripCols, ditambah: tab di whitespace awal hasil strip di-expand
// jadi spasi (lebar dari kolom asli, karakter pertama hasil ada di kolom `cols`).
// Dipakai untuk strip container (blockquote / list item).
function stripContainer(s, cols) {
  const r = stripCols(s, cols);
  let c = cols;
  let pos = 0;
  let out = '';
  while (pos < r.length) {
    const ch = r.charCodeAt(pos);
    if (ch === 9) {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
      pos++;
    } else if (ch === 32) {
      out += ' ';
      c++;
      pos++;
    } else break;
  }
  if (pos === 0) return r;
  return out + r.slice(pos);
}

// Escape &, <, >, ", ' tanpa pengecualian (untuk konten code & atribut mentah).
function escAll(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape untuk atribut/teks dengan & yang sadar entity: `&nama;` yang valid
// dipertahankan apa adanya, entitas numerik valid di-decode lalu di-escape.
function escEntityAware(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 38) continue;
    const ent = tryEntity(s, i);
    if (ent) {
      out += escAll(s.slice(start, i)) + ent.text;
      i = ent.end - 1;
      start = ent.end;
    }
  }
  // Sisa: escape & < > " '
  const rest = s.slice(start);
  if (out === '' && start === 0) return escAll(s);
  return out + escAll(rest);
}

// Coba parse entity reference di s mulai index i (s[i] === '&').
// Mengembalikan {end, text} atau null bila bukan entity valid.
function tryEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) {
    // Entitas numerik: &#123; atau &#x1F600;
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      hex = true;
      j++;
    }
    const ds = j;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (hex ? (d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70) : d >= 48 && d <= 57) j++;
      else break;
    }
    if (j === ds || j >= n || s.charCodeAt(j) !== 59) return null;
    const num = s.slice(ds, j);
    let cp = hex ? parseInt(num, 16) : parseInt(num, 10);
    if (!isFinite(cp) || cp > 0x10ffff) return null;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { end: j + 1, text: escAll(String.fromCodePoint(cp)) };
  }
  // Entitas bernama: &huruf[alnum]*;
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return null;
  let j = i + 1;
  while (j < n) {
    const d = s.charCodeAt(j);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57)) j++;
    else break;
  }
  if (j < n && s.charCodeAt(j) === 59) return { end: j + 1, text: s.slice(i, j + 1) };
  return null;
}

// Encode href ala marked/cmark (houdini_escape_uri): encode kontrol, spasi,
// " < > [ \ ] ^ ` { | }, DEL, dan non-ASCII (UTF-8). '%' dan karakter lain
// dibiarkan apa adanya (encodeURI meng-encode '%', jadi tidak dipakai).
function encodeHref(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const need =
      c < 32 || c === 32 || c === 34 || c === 60 || c === 62 || c === 91 || c === 92 ||
      c === 93 || c === 94 || c === 96 || c === 123 || c === 124 || c === 125 || c === 127 || c >= 128;
    if (!need) continue;
    out += s.slice(start, i);
    if (c >= 128) {
      // Non-ASCII: encodeURIComponent per karakter (pasangan surrogate utuh).
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          out += encodeURIComponent(s.slice(i, i + 2));
          i++;
          start = i + 1;
          continue;
        }
      }
      if (c >= 0xd800 && c <= 0xdfff) {
        out += '%EF%BF%BD'; // lone surrogate -> U+FFFD
      } else {
        out += encodeURIComponent(s[i]);
      }
    } else {
      out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
    }
    start = i + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Normalisasi label link reference: lipat whitespace, casefold, unescape.
function normalizeLabel(s) {
  // Normalisasi label: whitespace (termasuk newline) dilipat jadi satu spasi,
  // case-fold Unicode. Backslash dipertahankan apa adanya (label 'foo\!'
  // TIDAK sama dengan 'foo!'). Case-fold khusus: ß/ẞ -> ss.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isSpaceCh(c)) {
      if (out.length > 0 && out[out.length - 1] !== ' ') out += ' ';
    } else {
      out += s[i];
    }
  }
  if (out.endsWith(' ')) out = out.slice(0, -1);
  return out.toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

// ---------- inline parsing ----------

// Node inline: {t:'text',s} {t:'code',s} {t:'html',s} {t:'br'} {t:'delim',ch,n,open,close}
// {t:'open',img} (pembuka link, dirender '[' bila gagal) {t:'link',href,title,kids} {t:'img',src,title,alt}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += nd.s;
    else if (nd.t === 'code') out += '<code>' + escAll(nd.s) + '</code>';
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'br') out += '<br>';
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.n);
    else if (nd.t === 'open') out += nd.img ? '![' : '[';
    else if (nd.t === 'link') {
      out += '<a href="' + escEntityAware(encodeHref(nd.href)) + '"';
      if (nd.title !== null) out += ' title="' + escEntityAware(nd.title) + '"';
      out += '>' + renderNodes(nd.kids) + '</a>';
    } else if (nd.t === 'img') {
      // Alt = teks polos kids (dihitung saat render, setelah emphasis di
      // dalam kids diproses, agar '*bar*' jadi 'bar' bukan '*bar*').
      out += '<img src="' + escEntityAware(encodeHref(nd.src)) + '" alt="' + escEntityAware(altText(nd.kids || [])) + '"';
      if (nd.title !== null) out += ' title="' + escEntityAware(nd.title) + '"';
      out += '>';
    } else if (nd.t === 'em') out += '<em>' + renderNodes(nd.kids) + '</em>';
    else if (nd.t === 'strong') out += '<strong>' + renderNodes(nd.kids) + '</strong>';
    else if (nd.t === 'del') out += '<del>' + renderNodes(nd.kids) + '</del>';
  }
  return out;
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += nd.s;
    else if (nd.t === 'code') out += nd.s;
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.n);
    else if (nd.t === 'open') out += nd.img ? '![' : '[';
    else if (nd.t === 'link' || nd.t === 'img') out += plainText(nd.kids || []);
    else if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') out += plainText(nd.kids);
  }
  return out;
}

// Render teks polos untuk alt image: unescape entitas bernama jadi karakter?
// marked: alt memakai teks link dengan tag dihapus; karakter & dll di-escape
// saat dirender sebagai atribut. plainText sudah memberi teks mentah (dengan
// entity &nama; apa adanya); escEntityAware saat render atribut menanganinya.
function altText(nodes) {
  // Hapus tag HTML mentah dari alt (raw html node tidak masuk plainText).
  return plainText(nodes);
}

function isWordChar(c) {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 128
  );
}

// Parse tag HTML mentah mulai di s[i] === '<'. Atribut boleh lintas baris.
// Mengembalikan {end, text} atau null bila bukan tag valid. Validasi mengikuti
// pola tag CommonMark: nama tag, lalu (whitespace + nama-atribut [ = nilai ])*,
// lalu whitespace opsional + '/' opsional + '>'.
function parseHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  const c = s.charCodeAt(j);
  if (c === 33) {
    // <!-- komentar -->, <![CDATA[...]]>, <!Huruf ...>
    if (s.startsWith('!--', j)) {
      // Cari '-->' mulai dari i+2 agar '<!-->' dan '<!--->' dikenali
      // sebagai komentar kosong.
      const e = s.indexOf('-->', i + 2);
      if (e === -1) return null;
      return { end: e + 3, text: s.slice(i, e + 3) };
    }
    if (s.startsWith('[CDATA[', j + 1)) {
      const e = s.indexOf(']]>', j + 7);
      if (e === -1) return null;
      return { end: e + 3, text: s.slice(i, e + 3) };
    }
    if (j + 1 < n) {
      const d = s.charCodeAt(j + 1);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) {
        const e = s.indexOf('>', j + 1);
        if (e === -1) return null;
        return { end: e + 1, text: s.slice(i, e + 1) };
      }
    }
    return null;
  }
  if (c === 63) {
    const e = s.indexOf('?>', j + 1);
    if (e === -1) return null;
    return { end: e + 2, text: s.slice(i, e + 2) };
  }
  if (c === 47) j++; // tag penutup
  const closing = c === 47;
  // Nama tag: [A-Za-z][A-Za-z0-9-]*
  if (j >= n) return null;
  const d0 = s.charCodeAt(j);
  if (!((d0 >= 65 && d0 <= 90) || (d0 >= 97 && d0 <= 122))) return null;
  j++;
  while (j < n) {
    const d = s.charCodeAt(j);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) j++;
    else break;
  }
  // Tag penutup tidak boleh punya atribut: hanya whitespace lalu '>'.
  if (closing) {
    while (j < n && isSpaceCh(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 62) return { end: j + 1, text: s.slice(i, j + 1) };
    return null;
  }
  // Loop atribut. Atribut harus dipisah whitespace dari nama tag / atribut
  // sebelumnya ('<a href=\'x\'title=y>' bukan tag valid). Whitespace setelah
  // nama atribut tanpa nilai diingat (pendingWs) agar atribut berikutnya
  // tidak ditolak karena pemisahnya sudah dikonsumsi.
  let pendingWs = false;
  while (true) {
    // Lewati whitespace (termasuk newline).
    const wsStart = j;
    while (j < n && isSpaceCh(s.charCodeAt(j))) j++;
    const hadWs = pendingWs || j > wsStart;
    pendingWs = false;
    if (j >= n) return null;
    const d = s.charCodeAt(j);
    if (d === 62) return { end: j + 1, text: s.slice(i, j + 1) };
    if (d === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return { end: j + 2, text: s.slice(i, j + 2) };
      return null;
    }
    if (!hadWs) return null;
    // Nama atribut: [A-Za-z_:][A-Za-z0-9_.:-]*
    const a0 = d;
    if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return null;
    j++;
    while (j < n) {
      const a = s.charCodeAt(j);
      if ((a >= 65 && a <= 90) || (a >= 97 && a <= 122) || (a >= 48 && a <= 57) || a === 95 || a === 46 || a === 58 || a === 45) j++;
      else break;
    }
    let wsAfterName = false;
    while (j < n && isSpaceCh(s.charCodeAt(j))) {
      j++;
      wsAfterName = true;
    }
    if (j < n && s.charCodeAt(j) === 61) {
      j++;
      while (j < n && isSpaceCh(s.charCodeAt(j))) j++;
      if (j >= n) return null;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        // Nilai tanpa kutip: sampai whitespace atau '>' (tak boleh " ' = < > `).
        const vs = j;
        while (j < n) {
          const v = s.charCodeAt(j);
          if (v === 32 || v === 9 || v === 10 || v === 13 || v === 62 || v === 34 || v === 39 || v === 61 || v === 60 || v === 96) break;
          j++;
        }
        if (j === vs) return null;
      }
    } else {
      // Atribut tanpa nilai: ingat whitespace setelah namanya.
      pendingWs = wsAfterName;
    }
  }
}

// Coba parse autolink <...> mulai di s[i] === '<'. Mengembalikan {end, href, text} atau null.
function parseAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // Skema: huruf [huruf/digit/+.-]{1,31} ':'
  if (j < n) {
    const d0 = s.charCodeAt(j);
    if ((d0 >= 65 && d0 <= 90) || (d0 >= 97 && d0 <= 122)) {
      let k = j + 1;
      while (k < n) {
        const d = s.charCodeAt(k);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 43 || d === 45 || d === 46) k++;
        else break;
      }
      if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
        // Isi sampai '>' tanpa spasi / kontrol / '<'
        let e = k + 1;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 62) break;
          if (d === 32 || d === 60 || d < 32) return null;
          e++;
        }
        if (e < n && e > k + 1) {
          const inner = s.slice(i + 1, e);
          return { end: e + 1, href: inner, text: inner };
        }
        return null;
      }
    }
  }
  // Email: lokal@domain
  let e = j;
  while (e < n) {
    const d = s.charCodeAt(e);
    if (d === 62) break;
    if (d === 32 || d === 60 || d < 32) return null;
    e++;
  }
  if (e >= n || e === j) return null;
  const inner = s.slice(i + 1, e);
  if (/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(inner)) {
    return { end: e + 1, href: 'mailto:' + inner, text: inner };
  }
  return null;
}

// Parse destinasi link mulai di s[i]: '<...>' atau bare. Mengembalikan
// {end, dest} atau null. i menunjuk karakter pertama destinasi.
function parseDest(s, i) {
  const n = s.length;
  let j = i;
  // Lewati spasi/newline di awal? Pemanggil sudah memastikan posisi.
  if (j < n && s.charCodeAt(j) === 60) {
    j++;
    let out = '';
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 62) return { end: j + 1, dest: out };
      if (d === 10 || d === 60) return null;
      if (d === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
        out += s[j + 1];
        j += 2;
      } else {
        out += s[j];
        j++;
      }
    }
    return null;
  }
  let out = '';
  let parens = 0;
  while (j < n) {
    const d = s.charCodeAt(j);
    if (d === 32 || d === 10 || d < 32) break;
    if (d === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (d === 40) {
      parens++;
      if (parens > 1) {
        // Paren bersarang lebih dari 1 level tidak diizinkan pada dest bare.
        // (marked mengikuti spesifikasi: dest bare boleh 1 level nested.)
        // Kita tetap terima? Spesifikasi: dest boleh berisi paren seimbang.
        // Di sini: batalkan bila parens > 1? Uji menunjukkan b(c)d diterima
        // (1 level). Untuk keamanan, izinkan seimbang sampai level berapa pun
        // selama seimbang — spesifikasi CommonMark mengizinkan paren bersarang
        // seimbang tanpa batas? Sebenarnya: "a sequence of ... balanced
        // parentheses". Izinkan.
      }
      out += s[j];
      j++;
      continue;
    }
    if (d === 41) {
      if (parens === 0) break;
      parens--;
      out += s[j];
      j++;
      continue;
    }
    out += s[j];
    j++;
  }
  if (out.length === 0 || parens !== 0) return null;
  return { end: j, dest: out };
}

// Parse judul link mulai di s[i] (setelah spasi). Mengembalikan {end, title} atau null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s.charCodeAt(i);
  let close;
  if (q === 34) close = 34;
  else if (q === 39) close = 39;
  else if (q === 40) close = 41;
  else return null;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const d = s.charCodeAt(j);
    if (d === close) {
      if (close === 41) return { end: j + 1, title: out };
      return { end: j + 1, title: out };
    }
    if (d === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (close === 41 && d === 40) return null; // '(' tidak boleh di judul (...)
    out += s[j];
    j++;
  }
  return null;
}

// Lewati spasi/newline (maksimal: spasi boleh lintas baris).
function skipWs(s, i) {
  while (i < s.length && isSpaceCh(s.charCodeAt(i))) i++;
  return i;
}

// Parse `(dest "title")` mulai di s[i] === '('. Mengembalikan {end, dest, title} atau null.
function parseInlineLinkTail(s, i) {
  const n = s.length;
  let j = skipWs(s, i + 1);
  if (j >= n) return null;
  // Destinasi kosong: `[link]()` atau `[link]( )` -> href "".
  if (s.charCodeAt(j) === 41) return { end: j + 1, dest: '', title: null };
  const d = parseDest(s, j);
  if (!d) return null;
  j = d.end;
  let title = null;
  let k = skipWs(s, j);
  if (k < n && s.charCodeAt(k) !== 41) {
    // Harus ada setidaknya satu spasi sebelum judul.
    if (k === j) return null;
    const t = parseTitle(s, k);
    if (!t) return null;
    title = t.title;
    k = skipWs(s, t.end);
  }
  if (k >= n || s.charCodeAt(k) !== 41) return null;
  return { end: k + 1, dest: d.dest, title };
}

// ---------- inline scanner ----------

function flanking(s, i, j) {
  // Delimiter run s[i..j); hitung left/right-flanking dari karakter tetangga.
  const before = i > 0 ? s[i - 1] : '';
  const after = j < s.length ? s[j] : '';
  const beforeWs = before === '' || /\s/.test(before) || before === ' ';
  const afterWs = after === '' || /\s/.test(after) || after === ' ';
  const beforePunct = before !== '' && isPunctCh(before);
  const afterPunct = after !== '' && isPunctCh(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right, before, after };
}

// Quirk marked 18.1.3: tag <a + whitespace (mis. '<a href="x">', '<a  >',
// '<a  />') di dalam paragraf (inline) dianggap membuka link dan TIDAK
// pernah ditutup -> autolink GFM (bare URL, www., email) di semua paragraf
// berikutnya ditekan sampai ada </a> inline. Inline link [x](y) dan
// autolink eksplisit <...> tidak ditekan. Tag '<a>' / '<a/>' TANPA spasi
// tidak memicu. Direset di awal tiap parse().
let suppressAutolink = false;
// Nomor urut unik tiap run delimiter (untuk dedup run di gate: satu run
// mentah hanya dihitung sekali meski terpecah jadi beberapa node residu
// dan wrap yang memakainya).
let delimRunSeq = 0;

// Konsumsi unit kurung bersarang marked (Le di dalam label `re`):
// '[' + (kurung-dalam | escape | karakter-bukan-kurung)* + ']'.
// Kurung-dalam (Le) hanya satu tingkat dan isinya escape / karakter biasa
// (tanpa '[' ketiga, tanpa unit backtick). Kembalikan indeks SETELAH ']'
// penutup, atau -1 bila tidak terbentuk.
function scanNestedBracket(s, p) {
  const n = s.length;
  let q = p + 1;
  while (q < n) {
    const c = s.charCodeAt(q);
    if (c === 93) return q + 1;
    if (c === 92) {
      if (q + 1 >= n) return -1;
      q += 2;
      continue;
    }
    if (c === 91) {
      let r = q + 1;
      let closed = false;
      while (r < n) {
        const d = s.charCodeAt(r);
        if (d === 93) { closed = true; break; }
        if (d === 92) {
          if (r + 1 >= n) return -1;
          r += 2;
          continue;
        }
        if (d === 91) return -1;
        r++;
      }
      if (!closed) return -1;
      q = r + 1;
      continue;
    }
    q++;
  }
  return -1;
}

// Apakah span [teks](tail) mulai di openPos ('[') dan tutup ']' di closePos
// cocok pola blockSkip-link marked (yang menekan emphasis di dalamnya
// bila link gagal)? Label dipindai dengan unit escape, code-span LENIENT
// (ala normalisasi backtick Ot: run buka R dipasangkan run TUTUP pertama
// yang SAMA panjang, konten boleh berisi backtick yang lebih pendek),
// dan karakter biasa (bukan '['/']'/backtick). Tail: '(' + (escape |
// non-paren | '(' + (escape|non-paren)* + ')')* + ')'. Kembalikan indeks
// SETELAH ')' tail, atau -1 bila tidak cocok.
function matchMaskedLink(s, openPos, closePos) {
  const n = s.length;
  let p = openPos + 1;
  while (p < closePos) {
    const c = s.charCodeAt(p);
    if (c === 92) {
      if (p + 1 >= n) return -1;
      p += 2;
      continue;
    }
    if (c === 91 || c === 93) return -1;
    if (c === 96) {
      let q = p;
      while (q < n && s.charCodeAt(q) === 96) q++;
      const run = q - p;
      let r = q;
      let closed = -1;
      while (r < n) {
        if (s.charCodeAt(r) === 96) {
          let m = r;
          while (m < n && s.charCodeAt(m) === 96) m++;
          if (m - r === run) {
            closed = m;
            break;
          }
          r = m;
        } else r++;
      }
      if (closed === -1) return -1;
      p = closed;
      continue;
    }
    p++;
  }
  if (p !== closePos) return -1;
  if (closePos + 1 >= n || s.charCodeAt(closePos + 1) !== 40) return -1;
  let t = closePos + 2;
  while (t < n) {
    const c = s.charCodeAt(t);
    if (c === 92) {
      if (t + 1 >= n) return -1;
      t += 2;
      continue;
    }
    if (c === 40) {
      t++;
      let ok = false;
      while (t < n) {
        const d = s.charCodeAt(t);
        if (d === 41) {
          ok = true;
          break;
        }
        if (d === 92) {
          if (t + 1 >= n) return -1;
          t += 2;
          continue;
        }
        if (d === 40) return -1;
        t++;
      }
      if (!ok) return -1;
      t++;
      continue;
    }
    if (c === 41) return t + 1;
    t++;
  }
  return -1;
}

// Posisi ']' yang mengakhiri teks link mulai di `start` (teks setelah '['),
// menurut regex label marked `re` (dipakai link inline + referensi penuh):
// unit escape, kurung bersarang, code-span lenient, run backtick >= 2 tepat
// sebelum ']', karakter biasa — regex lazy, jadi berhenti di ']' pertama
// yang terjangkau. Kembalikan posisi ']' itu, atau -1 bila label tak bisa
// dikonsumsi penuh (mis. run backtick tanpa penutup sebelum '_]').
// Daerah yang di-mask oleh blockSkip + Ot dari marked saat mendeteksi
// delimiter emphasis. Replikasi setia #n marked (tanpa langkah
// reflinkSearch — lihat catatan di bawah): (1) Ot memasangkan code span
// LENIENT kiri-ke-kanan; backtick di dalam konten code span menjadi '+',
// escape menjadi '+'; (2) blockSkip (link|code|html) berjalan
// kiri-ke-kanan — span LINK dikonsumsi duluan sehingga run backtick di
// dalam label link tak bisa berpasangan dengan run di luar. Semua
// penggantian mempertahankan panjang string, jadi posisi region pada
// string ter-mask sama dengan posisi pada string asli. Region yang
// dicatat HANYA match code-span (grup b); match link/html ikut
// dikonsumsi mesin regex tanpa dicatat.
// Catatan: langkah reflinkSearch #n (masking [..][label] yang labelnya
// ada di defs, sebelum Ot) BELUM direplikasi — sejauh ini belum terbukti
// dibutuhkan oleh doc yang tersisa; bila nanti ada doc yang gagal karena
// itu, tambahkan di sini (butuh refs + normalisasi label F).
const MASK_OT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

function computeCodeRegions(s) {
  const masked = s.replace(MASK_OT_RE, (m, run, esc) =>
    esc ? '+'.repeat(m.length)
      : run ? run + m.slice(run.length, -run.length).replace(/`/g, '+') + run
      : m);
  const regions = [];
  MASK_BLOCKSKIP_RE.lastIndex = 0;
  let m;
  while ((m = MASK_BLOCKSKIP_RE.exec(masked)) !== null) {
    if (m.groups && m.groups.b !== undefined) {
      regions.push([m.index, m.index + m[0].length]);
    }
  }
  return regions;
}

function findLinkTextEnd(s, start) {
  const n = s.length;
  // Pindai label marked (regex `re`) dengan backtracking: di tiap run
  // backtick, coba (A) unit code-span lenient — penutup = run backtick
  // pertama sesudah pembuka, lalu lanjut pindai setelah penutup; bila
  // pindaian lanjutan gagal (mis. run penutup itu sendiri tak bisa
  // dikonsumsi karena tak ada run sesudahnya), backtrack ke (B) unit
  // ``+(?=\])`` — run >= 2 tepat sebelum ']'. Tanpa backtracking, label
  // seperti `less `` a ` b `` ` ditolak padahal marked menerimanya
  // (doc-33): (A) di run `` akhir menelan sampai `a_b` lalu mentok di
  // penutup `a_b` yang tak terkonsumsi, sehingga (B) yang menang.
  const scan = (p) => {
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 93) return p;
      if (c === 92) {
        if (p + 1 >= n) return -1;
        p += 2;
        continue;
      }
      if (c === 91) {
        const e = scanNestedBracket(s, p);
        if (e === -1) return -1;
        p = e;
        continue;
      }
      if (c === 96) {
        let q = p;
        while (q < n && s.charCodeAt(q) === 96) q++;
        const openRun = q - p;
        // (A) unit code-span lenient: penutup = run backtick pertama
        // sesudah pembuka (konten tak boleh berisi backtick).
        let r = q;
        let closed = -1;
        while (r < n) {
          if (s.charCodeAt(r) === 96) {
            let m = r;
            while (m < n && s.charCodeAt(m) === 96) m++;
            closed = m;
            break;
          }
          r++;
        }
        if (closed !== -1) {
          const e = scan(closed);
          if (e !== -1) return e;
        }
        // (B) unit ``+(?=\])`` — run >= 2 tepat sebelum ']'.
        if (openRun >= 2 && q < n && s.charCodeAt(q) === 93) return q;
        return -1;
      }
      p++;
    }
    return -1;
  };
  return scan(start);
}

function parseInline(str, refs) {
  const s = str;
  const n = s.length;
  const nodes = [];
  const openers = []; // index ke nodes untuk {t:'open'}
  // Batas akhir karakter yang sudah masuk ke node autolink GFM yang
  // dipulihkan penuh saat opener gagal (lihat handler ']').
  let gfmExtendUntil = 0;
  // Batas akhir span [teks](tail) yang gagal dan ter-mask (blockSkip):
  // delimiter di bawah batas ini diperlakukan sebagai teks literal.
  let maskUntil = 0;
  // Daerah code-span (asli maupun palsu) dari masking #n marked:
  // delimiter di dalam daerah ini tak terlihat oleh emphasis.
  const codeRegions = computeCodeRegions(s);
  let codeRegIdx = 0;
  // Akhir region [start, end) yang memuat pos, atau 0 bila di luar region.
  const codeRegionEnd = (pos) => {
    while (codeRegIdx < codeRegions.length && pos >= codeRegions[codeRegIdx][1]) codeRegIdx++;
    return codeRegIdx < codeRegions.length && pos >= codeRegions[codeRegIdx][0]
      ? codeRegions[codeRegIdx][1]
      : 0;
  };
  // Akhir teks link per opener (findLinkTextEnd), di-cache per srcPos
  // karena dipakai cabang code-span dan handler ']' untuk opener yang sama.
  const linkEndCache = new Map();
  const getLinkEnd = (srcPos) => {
    let v = linkEndCache.get(srcPos);
    if (v === undefined) {
      v = findLinkTextEnd(s, srcPos);
      linkEndCache.set(srcPos, v);
    }
    return v;
  };
  let buf = '';
  const flush = () => {
    if (buf !== '') {
      nodes.push({ t: 'text', s: escAll(buf) });
      buf = '';
    }
  };
  let i = 0;
  while (i < n) {
    // Karakter di dalam autolink GFM yang dipulihkan penuh sudah menjadi
    // isi node; jangan dipindai ulang sebagai markup.
    if (i < gfmExtendUntil) { i++; continue; }
    const c = s.charCodeAt(i);
    // --- newline: soft / hard break ---
    if (c === 10) {
      // Hard break bila buf berakhir dengan >= 2 spasi.
      let sp = 0;
      let k = buf.length - 1;
      while (k >= 0 && buf.charCodeAt(k) === 32) {
        sp++;
        k--;
      }
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ t: 'br' });
        // Setelah hard break, spasi/tab awal baris berikut dihapus.
        i++;
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    // --- backslash ---
    if (c === 92) {
      if (i + 1 < n && s.charCodeAt(i + 1) === 10) {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        // Setelah hard break, spasi/tab awal baris berikut dihapus.
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) {
        buf += s[i + 1];
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    // --- code span ---
    if (c === 96) {
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const run = j - i;
      // Di dalam opener link, penutup code span harus ada SEBELUM akhir
      // teks link: label regex marked tak mengonsumsi backtick yang
      // menelan '](...)'. Batasnya akhir teks opener TERDALAM yang valid
      // (bila tak ada yang valid, tanpa batas).
      let spanLimit = n;
      if (openers.length > 0) {
        for (let q = openers.length - 1; q >= 0; q--) {
          const le = getLinkEnd(nodes[openers[q]].srcPos);
          if (le !== -1) {
            spanLimit = le;
            break;
          }
        }
      }
      // Cari penutup dengan run yang sama persis.
      let k = j;
      let found = -1;
      while (k < spanLimit) {
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && s.charCodeAt(m) === 96) m++;
          if (m - k === run) {
            found = k;
            break;
          }
          k = m;
        } else k++;
      }
      if (found === -1) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      let content = s.slice(j, found);
      // Baris baru di dalam code span jadi spasi.
      if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = found + run;
      continue;
    }
    // --- entity ---
    if (c === 38) {
      const ent = tryEntity(s, i);
      if (ent) {
        flush();
        nodes.push({ t: 'text', s: ent.text });
        i = ent.end;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }
    // --- '<': autolink atau raw HTML ---
    if (c === 60) {
      const al = parseAutolink(s, i);
      if (al) {
        flush();
        nodes.push({ t: 'link', href: al.href, title: null, kids: [{ t: 'text', s: escAll(al.text) }], auto: true });
        i = al.end;
        continue;
      }
      const tag = parseHtmlTag(s, i);
      if (tag) {
        // marked: inLink hanya disetel oleh `<a` + spasi literal
        // (startATag /^<a /i) dan hanya `</a>` persis yang membersihkannya
        // (endATag /^<\/a>/i). `<a\thref>` / `<a\nhref>` tidak menekan
        // autolink GFM, dan `</a >` tidak membuka penekanan itu.
        const t = tag.text;
        if (
          t.length > 2 &&
          (t.charCodeAt(1) | 32) === 97 &&
          t.charCodeAt(2) === 32
        ) {
          suppressAutolink = true;
        } else if (
          t.length === 4 &&
          t.charCodeAt(1) === 47 &&
          (t.charCodeAt(2) | 32) === 97 &&
          t.charCodeAt(3) === 62
        ) {
          suppressAutolink = false;
        }
        flush();
        nodes.push({ t: 'html', s: tag.text });
        i = tag.end;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    // --- '[' / '![': pembuka link ---
    if (c === 91 || (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91)) {
      const img = c === 33;
      flush();
      const idx = nodes.length;
      // srcPos = indeks awal teks link (untuk label shortcut/collapsed mentah).
      nodes.push({ t: 'open', img, srcPos: i + (img ? 2 : 1) });
      openers.push(idx);
      i += img ? 2 : 1;
      continue;
    }
    // --- ']': coba tutup link ---
    if (c === 93) {
      flush();
      // Cari opener terdekat yang masih aktif.
      let oi = -1;
      for (let q = openers.length - 1; q >= 0; q--) {
        oi = openers[q];
        break;
      }
      if (oi === -1) {
        buf += ']';
        i++;
        continue;
      }
      const opener = nodes[oi];
      // Anak-anak opener: node di antara opener dan akhir saat ini.
      const kids = nodes.slice(oi + 1);
      // Link tidak boleh berisi link lain, TAPI image BOLEH berisi link
      // (alt-nya = teks polos anak-anaknya, termasuk teks link).
      let hasLink = false;
      // Autolink (auto:true, eksplisit <...> maupun GFM) TIDAK dihitung
      // sebagai "link lain": marked membuat link luar meski teksnya berisi
      // autolink (nested <a>). Hanya link biasa yang memblokir.
      for (const kd of kids) if (kd.t === 'link' && !kd.auto) { hasLink = true; break; }
      // Label harus bisa dikonsumsi penuh oleh regex label marked sampai
      // ']' ini — bila tidak (mis. run backtick tanpa penutup sebelum
      // '_]'), link/referensi/shortcut TIDAK resolve, apa pun tail-nya.
      const labelOk = getLinkEnd(opener.srcPos) === i;
      let resolved = null;
      if ((!hasLink || opener.img) && labelOk) {
        const after = i + 1;
        if (after < n && s.charCodeAt(after) === 40) {
          const tail = parseInlineLinkTail(s, after);
          if (tail) resolved = { href: tail.dest, title: tail.title, end: tail.end };
          else {
            // Tail inline gagal -> fallback ke shortcut reference (label
            // = teks link mentah).
            const ref = refs.get(normalizeLabel(s.slice(opener.srcPos, i)));
            if (ref) resolved = { href: ref.dest, title: ref.title, end: i + 1 };
          }
        } else if (after < n && s.charCodeAt(after) === 91) {
          // Referensi penuh [label] atau collapsed [].
          // Label berakhir di ']' pertama yang tidak di-escape; backslash
          // dipertahankan mentah; '[' tanpa escape membuat label invalid.
          // Bila gagal, TIDAK fallback ke shortcut.
          let k = after + 1;
          let label = '';
          let labelOk = true;
          while (k < n) {
            const d = s.charCodeAt(k);
            if (d === 92 && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) {
              label += s[k];
              label += s[k + 1];
              k += 2;
              continue;
            }
            if (d === 91) {
              labelOk = false;
              break;
            }
            if (d === 93) break;
            if (d === 10) { label += ' '; k++; continue; }
            label += s[k];
            k++;
          }
          if (labelOk && k < n && s.charCodeAt(k) === 93) {
            // Label collapsed [] = teks link mentah (sumber, bukan plainText).
            const lab = label === '' ? s.slice(opener.srcPos, i) : label;
            const ref = refs.get(normalizeLabel(lab));
            if (ref) resolved = { href: ref.dest, title: ref.title, end: k + 1 };
          }
        } else {
          // Shortcut reference: label = teks link mentah (sumber, dengan
          // backslash dipertahankan), bukan plainText.
          const ref = refs.get(normalizeLabel(s.slice(opener.srcPos, i)));
          if (ref) resolved = { href: ref.dest, title: ref.title, end: i + 1 };
        }
      }
      if (resolved) {
        // Hapus opener-opener lain di antara opener dan ']' dari stack.
        for (let q = openers.length - 1; q >= 0; q--) {
          if (openers[q] >= oi) openers.splice(q, 1);
          else break;
        }
        // Hapus node anak dari daftar (sudah disalin ke kids).
        nodes.length = oi;
        // Autolink GFM di dalam teks link kembali jadi teks polos
        // (marked menekan url() di dalam teks link yang resolve).
        const cleanKids = stripGfmLinks(kids);
        // Unmask-on-resolve: marked menokenisasi label terpisah, jadi
        // masking code-span dari paragraf luar tak berlaku di dalam label.
        // Delimiter yang region-nya melampaui ']' label (masked > i)
        // menjadi terlihat kembali; yang region-nya utuh di dalam label
        // tetap ter-mask (tokenisasi label saja akan me-mask-nya juga).
        unmaskLabelRegions(cleanKids, i);
        if (opener.img) {
          // Simpan kids agar plainText(img) bisa menelusuri img bersarang
          // saat image ini jadi alt dari image lain. Alt dihitung saat
          // render (setelah processEmphasis memproses kids).
          nodes.push({ t: 'img', src: resolved.href, title: resolved.title, kids: cleanKids });
        } else {
          nodes.push({ t: 'link', href: resolved.href, title: resolved.title, kids: cleanKids });
        }
        i = resolved.end;
        continue;
      }
      // Gagal: opener jadi literal, ']' jadi literal.
      openers.pop();
      // Opener tetap sebagai node {t:'open'} -> dirender '[' / '!['.
      // Bila percobaan inline-link ini cocok pola blockSkip marked
      // ([teks](tail) dengan tail berimbang), emphasis di dalam span
      // ditekan: node delimiter yang sudah terpindai di antara opener
      // dan ']' kembali jadi teks literal, dan delimiter di bagian tail
      // (sampai akhir ')') juga literal via maskUntil. Hanya percobaan
      // inline-link yang me-mask — ref/shortcut tidak.
      if (i + 1 < n && s.charCodeAt(i + 1) === 40) {
        const openPos = opener.srcPos - (opener.img ? 2 : 1);
        const tailEnd = matchMaskedLink(s, openPos, i);
        if (tailEnd !== -1) {
          for (let q = oi + 1; q < nodes.length; q++) {
            const nd = nodes[q];
            if (nd.t === 'delim') nodes[q] = { t: 'text', s: escAll(nd.ch.repeat(nd.n)) };
          }
          if (tailEnd > maskUntil) maskUntil = tailEnd;
        }
      }
      // Bila ada autolink GFM yang sempat dipotong di ']' ini (flag trunc),
      // pulihkan teks/href penuhnya: opener gagal berarti marked jatuh ke
      // url() di dalam teks, jadi autolink itu yang tampil. Karakter
      // setelah ']' sampai fullEnd sudah masuk ke node, jadi dilewati
      // pemindaian lewat gfmExtendUntil dan ']' tidak masuk buf.
      let restoredTrunc = false;
      for (let q = oi + 1; q < nodes.length; q++) {
        const nd = nodes[q];
        if (nd.t === 'link' && nd.gfm && nd.trunc) {
          nd.kids = [{ t: 'text', s: escAll(nd.fullText) }];
          nd.href = nd.fullHref;
          nd.trunc = false;
          if (nd.fullEnd > gfmExtendUntil) gfmExtendUntil = nd.fullEnd;
          restoredTrunc = true;
          break;
        }
      }
      if (!restoredTrunc) buf += ']';
      i++;
      continue;
    }
    // --- '*' '_' '~': delimiter emphasis ---
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      const run = j - i;
      // Di dalam span link gagal yang ter-mask (blockSkip), delimiter
      // adalah teks literal — emphasis ditekan.
      if (i < maskUntil) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      // Run '~' panjang >= 3 BUKAN delimiter (teks literal).
      if (c === 126 && run >= 3) {
        buf += s.slice(i, j);
        i = j;
        continue;
      }
      // Di dalam region code-span (asli/palsu) dari masking #n, delimiter
      // tak terlihat oleh emphasis — tapi TETAP node delim (bukan teks):
      // bila link luarnya resolve, label di-tokenisasi ulang tanpa
      // masking luar, jadi flag `masked` dihapus di handler ']' bila
      // region melampaui ']' label. Akhir region disimpan di `masked`.
      const regEnd = codeRegionEnd(i);
      const fl = flanking(s, i, j);
      let open = false;
      let close = false;
      if (c === 95) {
        open = fl.left && (!fl.right || fl.before === '' || isPunctCh(fl.before));
        close = fl.right && (!fl.left || fl.after === '' || isPunctCh(fl.after));
      } else {
        open = fl.left;
        close = fl.right;
      }
      // '~' hanya membentuk del bila run 1-2; run lebih panjang: pakai 2.
      flush();
      const dn = { t: 'delim', ch: s[i], n: run, open, close, runId: ++delimRunSeq };
      if (regEnd) dn.masked = regEnd;
      nodes.push(dn);
      i = j;
      continue;
    }
    // --- GFM extended autolink: skema (mailto:/xmpp:), www. / http(s)://, email ---
    // Skema autolink GFM hanya 'mailto:' dan 'xmpp:' (lowercase).
    // Autolink GFM BOLEH terbentuk di dalam teks link yang sedang dibuka
    // (marked: url() baru ditekan saat teks link itu di-tokenisasi ulang
    // oleh De() bila link luarnya resolve). Node ditandai gfm:true agar
    // saat opener resolve ia dikembalikan jadi teks polos (stripGfmLinks).
    if ((c === 109 && s.startsWith('mailto:', i)) || (c === 120 && s.startsWith('xmpp:', i))) {
      const prev = i > 0 ? s.charCodeAt(i - 1) : 32;
      const prevOk = i === 0 || isSpaceCh(prev) || isAsciiPunct(prev);
      if (prevOk && !suppressAutolink) {
        const link = scanSchemeAutolink(s, i, nodes);
        if (link) {
          flush();
          nodes.push({ t: 'link', href: link.href, title: null, kids: [{ t: 'text', s: escAll(link.text) }], auto: true, gfm: true });
          i = link.end;
          continue;
        }
      }
      buf += s[i];
      i++;
      continue;
    }
    if (
      (c === 119 && s.startsWith('www.', i)) ||
      ((c === 104 || c === 72) && httpSchemeLen(s, i) > 0)
    ) {
      // Harus didahului awal / whitespace / tanda baca tertentu (bukan huruf/digit).
      const prev = i > 0 ? s.charCodeAt(i - 1) : 32;
      const prevOk = i === 0 || isSpaceCh(prev) || isAsciiPunct(prev);
      if (prevOk && !suppressAutolink) {
        const link = scanGfmUrl(s, i);
        if (link) {
          flush();
          // Di dalam opener, URL tidak boleh menelan ']' penutup label
          // beserta tail-nya: marked menokenisasi label terpisah, jadi
          // url() di dalam label hanya melihat teks sampai ']' itu.
          // Teks URL di dalam label = substring mentah sampai ']' —
          // TANPA backpedal, karena De() menokenisasi label tanpa url()
          // (bukti: doc-33 WANT `most.` — titik dipertahankan) — dikurangi
          // run delimiter emphasis di ujung (itu delimiter, bukan bagian
          // URL). Flag trunc + teks/href penuh disimpan agar jalur gagal
          // handler ']' bisa memulihkan URL penuh seperti marked.
          // Bila cap tak valid, URL tak terbentuk.
          if (openers.length > 0) {
            const innerOpener = nodes[openers[openers.length - 1]];
            const labelEnd = getLinkEnd(innerOpener.srcPos);
            if (labelEnd !== -1 && labelEnd < link.end) {
              let raw = s.slice(i, labelEnd);
              let cut = 0;
              while (cut < raw.length) {
                const d = raw.charCodeAt(cut);
                if (d === 32 || d === 10 || d === 60 || d === 62 || d === 34 || d === 96 || d < 32) break;
                cut++;
              }
              raw = raw.slice(0, cut);
              let e2 = raw.length;
              while (e2 > 0) {
                const d = raw.charCodeAt(e2 - 1);
                if (d === 42 || d === 95 || d === 126) e2--;
                else break;
              }
              const cappedText = raw.slice(0, e2);
              const isScheme = httpSchemeLen(s, i) > 0;
              if (cappedText.length > 0 && urlHostOk(cappedText, isScheme)) {
                const cappedHref = isScheme ? cappedText : 'http://' + cappedText;
                nodes.push({ t: 'link', href: cappedHref, title: null, kids: [{ t: 'text', s: escAll(cappedText) }], auto: true, gfm: true, trunc: true, fullText: link.text, fullHref: link.href, fullEnd: link.end });
                i = i + cappedText.length;
                continue;
              }
              buf += s[i];
              i++;
              continue;
            }
          }
          nodes.push({ t: 'link', href: link.href, title: null, kids: [{ t: 'text', s: escAll(link.text) }], auto: true, gfm: true });
          i = link.end;
          continue;
        }
      }
      buf += s[i];
      i++;
      continue;
    }
    // Email GFM: deteksi saat bertemu '@' dengan kata sebelumnya.
    // Boleh di dalam teks link yang sedang dibuka (lihat komentar di atas).
    if (c === 64) {
      if (!suppressAutolink) {
        const em = scanGfmEmail(s, i, nodes);
        if (em) {
          // Hapus local part dari akhir (buf + nodes): local part bisa
          // menelan delimiter (mis. '_') dan teks sebelumnya. Potongan yang
          // dihapus disimpan (restore) agar bisa dikembalikan jadi teks
          // bila opener luarnya resolve (stripGfmLinks).
          const cut = removeTrailingRaw(nodes, buf, em.local.length);
          if (cut !== null) {
            buf = cut.buf;
            flush();
            nodes.push({ t: 'link', href: 'mailto:' + em.text, title: null, kids: [{ t: 'text', s: escAll(em.text) }], auto: true, gfm: true, restore: cut.removed, localLen: em.local.length });
            i = em.end;
            continue;
          }
        }
      }
      buf += '@';
      i++;
      continue;
    }
    buf += s[i];
    i++;
  }
  flush();
  processEmphasis(nodes);
  return renderNodes(nodes);
}

// Potong teks URL di '(' pertama yang tak punya pasangan ')'.
// _backpedal marked (url GFM): buang tanda baca akhir URL, tapi
// pertahankan grup (...) seimbang dan buang entitas bernama utuh.
// Diterapkan berulang sampai fixpoint, persis seperti tokenizer url()
// marked: do r=t[0], t[0]=_backpedal.exec(t[0])?.[0]??"" while(r!==t[0]).
// Berbeda dari trimUrlTrailing: ')' akhir DIPERTAHANKAN bila ia penutup
// grup seimbang (mis. ...)](./docs/create.md) — pemangkasan lama membuang
// ')' itu karena menghitung kurung tak-seimbang secara global.
const URL_BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedalUrl(text) {
  let prev;
  do {
    prev = text;
    const m = URL_BACKPEDAL_RE.exec(text);
    text = m ? m[0] : '';
  } while (text !== prev);
  return text;
}

// Host URL marked: (?:[a-zA-Z0-9\-]+\.?)+ — tiap label boleh diakhiri
// '.' (mis. img.shields.io. dari https://img.shields.io.\).
const MARKED_URL_HOST_RE = /^(?:[a-zA-Z0-9-]+\.?)+/;

// Validasi host URL GFM: host = awalan rest yang cocok pola host marked,
// harus mengandung '.'; 'www.' harus diikuti domain valid.
function urlHostOk(text, scheme) {
  const rest = scheme ? text.slice(text.indexOf('://') + 3) : text.slice(4);
  const hm = MARKED_URL_HOST_RE.exec(rest);
  const host = hm ? hm[0] : '';
  if (!host || host.indexOf('.') === -1) return false;
  if (!scheme && host.length <= 4) return false;
  return true;
}

// Buang tanda baca akhir URL GFM: ? ! . , : ; * _ ~ ' " dan ')' tak
// seimbang. ';' yang menutup entitas bernama (&nama;) membuang seluruh
// entitas; selain itu hanya ';'-nya yang dibuang.
function trimUrlTrailing(text) {
  while (text.length > 0) {
    const last = text[text.length - 1];
    if (last === ')') {
      let bal = 0;
      for (let q = 0; q < text.length; q++) {
        const ch = text.charCodeAt(q);
        if (ch === 40) bal++;
        else if (ch === 41) bal--;
      }
      if (bal < 0) {
        text = text.slice(0, -1);
        continue;
      }
      break;
    }
    if ('?!.,:;*_~\'"'.includes(last)) {
      if (last === ';') {
        const amp = text.lastIndexOf('&');
        if (amp !== -1 && /^&[a-zA-Z0-9]+;$/.test(text.slice(amp))) {
          text = text.slice(0, amp);
          continue;
        }
      }
      text = text.slice(0, -1);
      continue;
    }
    break;
  }
  return text;
}

// Panjang prefix skema http(s):// (case-insensitive) di s[i]: 8 untuk
// https://, 7 untuk http://, 0 bila bukan. 'www.' tetap case-sensitive.
function httpSchemeLen(s, i) {
  if ((s.charCodeAt(i) | 32) !== 104) return 0; // 'h'
  if ((s.charCodeAt(i + 1) | 32) !== 116) return 0; // 't'
  if ((s.charCodeAt(i + 2) | 32) !== 116) return 0; // 't'
  if ((s.charCodeAt(i + 3) | 32) !== 112) return 0; // 'p'
  const c4 = s.charCodeAt(i + 4) | 32;
  if (c4 === 115) { // 's' -> https://
    if (s.charCodeAt(i + 5) !== 58 || s.charCodeAt(i + 6) !== 47 || s.charCodeAt(i + 7) !== 47) return 0;
    return 8;
  }
  if (c4 === 58) { // ':' -> http://
    if (s.charCodeAt(i + 5) !== 47 || s.charCodeAt(i + 6) !== 47) return 0;
    return 7;
  }
  return 0;
}

// Validasi domain email/URL: label alnum/'-' (awal-akhir alnum), minimal
// satu titik. Sama dengan pola yang dipakai scanGfmEmail sebelumnya.
const EMAIL_DOMAIN_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Apakah ada opener '_' yang belum punya closer di antara node-node ini?
// Dipakai untuk memutuskan apakah run '_' setelah domain email adalah
// penutup emphasis (milik opener itu) atau bagian dari domain.
// Opener dianggap "terbuka" bila tidak ada delimiter '_' yang bisa menutup
// (close=true) setelahnya sebelum posisi saat ini.
function hasUnclosedUnderscoreOpener(nodes) {
  let openIdx = -1;
  for (let k = nodes.length - 1; k >= 0; k--) {
    const nd = nodes[k];
    if (nd.t === 'delim' && nd.ch === '_' && nd.open) {
      openIdx = k;
      break;
    }
  }
  if (openIdx === -1) return false;
  for (let k = openIdx + 1; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'delim' && nd.ch === '_' && nd.close) return false;
  }
  return true;
}

// Pilih domain efektif dari domain mentah s[start..end) (run karakter
// domain yang sudah dipindai). Mengembalikan teks domain atau null.
// Mengikuti marked: (1) domain utuh bila valid; (2) bila diakhiri run '_'
// dan ada opener '_' yang belum tertutup, run '_' itu milik emphasis,
// bukan domain — potong sebelum run; (3) bila tidak, tiru backtrack regex
// marked ke awalan valid terpanjang yang diikuti '.' (mis.
// `table@nimbus.example` dari `table@nimbus.example.com__` tanpa opener).
function pickEmailDomain(s, start, end, nodes) {
  const raw = s.slice(start, end);
  if (raw.length === 0) return null;
  if (EMAIL_DOMAIN_RE.test(raw)) return raw;
  // (2) run '_' penutup emphasis.
  let cut = raw.length;
  while (cut > 0 && raw.charCodeAt(cut - 1) === 95) cut--;
  if (cut < raw.length && hasUnclosedUnderscoreOpener(nodes)) {
    const stripped = raw.slice(0, cut);
    if (EMAIL_DOMAIN_RE.test(stripped)) return stripped;
  }
  // (3) backtrack: awalan valid terpanjang yang diikuti '.'.
  for (let e = raw.length - 1; e >= 1; e--) {
    if (raw.charCodeAt(e) !== 46) continue;
    const cand = raw.slice(0, e);
    if (EMAIL_DOMAIN_RE.test(cand)) return cand;
  }
  return null;
}

// Pindai URL GFM (www. atau http(s)://) mulai di i. Mengembalikan
// {end, href, text} atau null. `limit` (opsional) membatasi akhir
// pemindaian — dipakai saat URL berada di dalam label link: marked
// menokenisasi label terpisah, jadi url() di dalam label tak pernah
// melihat ']' penutup label beserta tail-nya.
function scanGfmUrl(s, i, limit) {
  const n = s.length;
  const lim = limit === undefined ? n : limit;
  let j = i;
  let scheme = false;
  const sl = httpSchemeLen(s, i);
  if (sl > 0) {
    j = i + sl;
    scheme = true;
  } else if (s.startsWith('www.', i)) {
    j = i + 4;
  }
  // Konsumsi sampai whitespace / '<' / '>' / '"' / backtick / kontrol.
  // ')' di tengah URL ikut dikonsumsi; pemangkasan dilakukan setelahnya.
  let end = j;
  while (end < lim) {
    const d = s.charCodeAt(end);
    if (d === 32 || d === 10 || d === 60 || d === 62 || d === 34 || d === 96 || d < 32) break;
    end++;
  }
  let text = backpedalUrl(s.slice(i, end));
  // Host = run terdepan [a-zA-Z0-9.-] setelah skema/www. — karakter sesudah
  // host (mis. `\`, `)`, `]`) adalah bagian URL, bukan host: regex URL
  // marked mengonsumsi host lalu `[^\\s<]*`, dan validasi hanya pada host.
  if (!urlHostOk(text, scheme)) return null;
  const href = scheme ? text : 'http://' + text;
  return { end: i + text.length, href, text };
}

const LOCAL_CHARS = /[a-zA-Z0-9.+_-]/;

// Apakah karakter di s[k] ter-escape (didahului jumlah backslash ganjil)?
function isEscapedAt(s, k) {
  let n = 0;
  let q = k - 1;
  while (q >= 0 && s.charCodeAt(q) === 92) {
    n++;
    q--;
  }
  return n % 2 === 1;
}

// Pindai email GFM saat '@' di posisi i; s = teks paragraf mentah.
// Local part dipindai mundur dari s (bukan dari buf): karakter local-part
// yang ter-escape tidak ikut.
function scanGfmEmail(s, i, nodes) {
  let k = i - 1;
  while (k >= 0 && LOCAL_CHARS.test(s[k]) && !isEscapedAt(s, k)) k--;
  const local = s.slice(k + 1, i);
  if (local.length === 0) return null;
  // Domain: dari i+1 sampai karakter bukan domain.
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const d = s.charCodeAt(j);
    if (
      (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
      d === 45 || d === 46 || d === 95
    ) j++;
    else break;
  }
  const domain = pickEmailDomain(s, i + 1, j, nodes);
  if (!domain) return null;
  const text = local + '@' + domain;
  return { end: i + 1 + domain.length, local, text };
}

// Pindai autolink skema GFM (hanya 'mailto:' dan 'xmpp:') mulai di i.
// Bentuk: skema + email + opsional '/segmen' (segmen = [a-zA-Z0-9.@]+).
function scanSchemeAutolink(s, i, nodes) {
  let scheme = null;
  if (s.startsWith('mailto:', i)) scheme = 'mailto:';
  else if (s.startsWith('xmpp:', i)) scheme = 'xmpp:';
  else return null;
  const n = s.length;
  let j = i + scheme.length;
  // Local part email (maju).
  let k = j;
  while (k < n && LOCAL_CHARS.test(s[k])) k++;
  const local = s.slice(j, k);
  if (local.length === 0 || k >= n || s.charCodeAt(k) !== 64) return null;
  // Domain.
  let d = k + 1;
  while (d < n) {
    const c = s.charCodeAt(d);
    if (
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 45 || c === 46 || c === 95
    ) d++;
    else break;
  }
  const domain = pickEmailDomain(s, k + 1, d, nodes);
  if (!domain) return null;
  let end = k + 1 + domain.length;
  // Segmen path opsional: '/' + [a-zA-Z0-9.@]+ (tepat satu segmen).
  if (end < n && s.charCodeAt(end) === 47) {
    let p = end + 1;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 64
      ) p++;
      else break;
    }
    if (p > end + 1) end = p;
  }
  let text = trimUrlTrailing(s.slice(i, end));
  if (text.length <= scheme.length) return null;
  return { end: i + text.length, href: text, text };
}

// Kembalikan teks dari bentuk ter-escape (untuk menghitung karakter mentah
// saat menghapus local part email dari node teks).
function unescapeText(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Hapus `count` karakter mentah terakhir dari (nodes, buf) — untuk local
// part email GFM yang menelan delimiter (mis. '_') dan teks sebelumnya.
// Mengembalikan {buf, removed} atau null bila tidak bisa (ada node non-teks /
// non-delimiter di jalannya). `removed` = potongan yang dihapus, dalam
// urutan dokumen (node teks/delim yang terpotong, lalu potongan buf),
// sebagai node teks — dipakai untuk mengembalikan email jadi teks polos
// bila link luarnya resolve. Bila null, tidak ada yang diubah.
function removeTrailingRaw(nodes, buf, count) {
  let need = count;
  let bufTake = 0;
  if (buf.length >= need) {
    bufTake = need;
    need = 0;
  } else {
    bufTake = buf.length;
    need -= buf.length;
  }
  // Rencana dulu (tanpa mengubah): node yang akan dipotong, dari belakang.
  const plan = [];
  let k = nodes.length - 1;
  while (need > 0 && k >= 0) {
    const nd = nodes[k];
    if (nd.t === 'text') {
      const rawLen = unescapeText(nd.s).length;
      if (rawLen > need) {
        plan.push({ node: nd, take: need });
        need = 0;
      } else {
        plan.push({ node: nd, take: rawLen });
        need -= rawLen;
      }
    } else if (nd.t === 'delim') {
      if (nd.n > need) {
        plan.push({ node: nd, take: need });
        need = 0;
      } else {
        plan.push({ node: nd, take: nd.n });
        need -= nd.n;
      }
    } else {
      return null;
    }
    k--;
  }
  if (need > 0) return null;
  // Terapkan rencana; kumpulkan potongan dalam urutan dokumen.
  const removed = [];
  for (let p = plan.length - 1; p >= 0; p--) {
    const { node, take } = plan[p];
    if (node.t === 'text') {
      const raw = unescapeText(node.s);
      removed.push({ t: 'text', s: escAll(raw.slice(raw.length - take)) });
      if (take >= raw.length) nodes.splice(nodes.indexOf(node), 1);
      else node.s = escAll(raw.slice(0, raw.length - take));
    } else {
      removed.push({ t: 'text', s: node.ch.repeat(take) });
      if (take >= node.n) nodes.splice(nodes.indexOf(node), 1);
      else node.n -= take;
    }
  }
  let newBuf = buf;
  if (bufTake > 0) {
    removed.push({ t: 'text', s: escAll(buf.slice(buf.length - bufTake)) });
    newBuf = buf.slice(0, buf.length - bufTake);
  }
  return { buf: newBuf, removed };
}

// Ubah node autolink GFM (gfm:true) di dalam kids menjadi teks polos —
// marked menekan url() di dalam teks link yang resolve (De() memakai
// inLink=true saat menokenisasi teks link). Rekursif ke anak link/img.
// Autolink eksplisit `<...>` (tanpa flag gfm) dipertahankan sebagai link.
// Hapus flag `masked` pada delimiter di dalam label link yang resolve,
// bila region code-span-nya melampaui akhir label (labelEnd): tokenisasi
// ulang label oleh marked tak mengenal region itu. Rekursif ke anak link/img.
function unmaskLabelRegions(kids, labelEnd) {
  for (const kd of kids) {
    if (kd.t === 'delim') {
      if (kd.masked && kd.masked > labelEnd) delete kd.masked;
    } else if (kd.kids) {
      unmaskLabelRegions(kd.kids, labelEnd);
    }
  }
}

function stripGfmLinks(kids) {
  const out = [];
  for (const kd of kids) {
    if (kd.t === 'link' && kd.gfm) {
      if (kd.restore) {
        for (const r of kd.restore) out.push(r);
        const tail = kd.kids && kd.kids[0] ? kd.kids[0].s : '';
        out.push({ t: 'text', s: tail.slice(kd.localLen || 0) });
      } else {
        const txt = kd.kids && kd.kids[0] ? kd.kids[0].s : '';
        out.push({ t: 'text', s: txt });
      }
    } else if (kd.t === 'link' || kd.t === 'img') {
      out.push({ ...kd, kids: stripGfmLinks(kd.kids || []) });
    } else if (kd.t === 'em' || kd.t === 'strong' || kd.t === 'del') {
      out.push({ ...kd, kids: stripGfmLinks(kd.kids || []) });
    } else {
      out.push(kd);
    }
  }
  return out;
}

// Karakter pertama/terakhir node sebagaimana tampak di string ter-mask
// marked (#n): teks memakai .s (ter-escape — klasifikasinya sama dengan
// karakter mentah); code/html/link/img ter-mask jadi '[aaa...]' sehingga
// karakternya ']'; br jadi '\n'; delimiter ter-mask jadi 'a'.
function firstCharOf(nd) {
  if (!nd) return '';
  if (nd.t === 'text') return nd.s.charAt(0);
  if (nd.t === 'delim') return nd.masked ? 'a' : nd.ch;
  if (nd.t === 'code' || nd.t === 'html' || nd.t === 'link' || nd.t === 'img') return ']';
  if (nd.t === 'br') return '\n';
  if (nd.t === 'open') return '[';
  if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
    for (const k of nd.kids || []) {
      const c = firstCharOf(k);
      if (c) return c;
    }
  }
  return '';
}

function lastCharOf(nd) {
  if (!nd) return '';
  if (nd.t === 'text') return nd.s.charAt(nd.s.length - 1);
  if (nd.t === 'delim') return nd.masked ? 'a' : nd.ch;
  if (nd.t === 'code' || nd.t === 'html' || nd.t === 'link' || nd.t === 'img') return ']';
  if (nd.t === 'br') return '\n';
  if (nd.t === 'open') return '[';
  if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
    const kids = nd.kids || [];
    for (let q = kids.length - 1; q >= 0; q--) {
      const c = lastCharOf(kids[q]);
      if (c) return c;
    }
  }
  return '';
}

// Flanking dari karakter tetangga (cermin flanking()): before/after bisa ''.
function flankingChars(before, after) {
  const beforeWs = before === '' || /\s/.test(before);
  const afterWs = after === '' || /\s/.test(after);
  const beforePunct = before !== '' && isPunctCh(before);
  const afterPunct = after !== '' && isPunctCh(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right, before, after };
}

// Flag open/close delimiter dari karakter tetangga (aturan sama seperti
// cabang delimiter di parseInline).
function delimFlags(ch, before, after) {
  const fl = flankingChars(before, after);
  if (ch === '_') {
    return {
      open: fl.left && (!fl.right || fl.before === '' || isPunctCh(fl.before)),
      close: fl.right && (!fl.left || fl.after === '' || isPunctCh(fl.after)),
    };
  }
  return { open: fl.left, close: fl.right };
}

// Gate simulasi-m emStrong marked: apakah opener O (indeks oi) boleh
// berpasangan dengan closer C (indeks ci)? Mengembalikan null bila tidak,
// atau {k, b, use} bila ya — k = panjang opener efektif (marked mencoba
// ulang dengan k lebih pendek bila k penuh gagal, karena karakter awal run
// dikonsumsi sebagai teks), b = panjang closer terpakai
// (min(run, run+m+f)), use = 1 (em) bila min(k, b) ganjil, 2 (strong) bila
// genap — persis emStrong marked. Mensimulasikan scan marked dari O ke C:
// kumpulkan delimiter se-char dalam urutan dokumen antara O dan C
// (rekursi ke anak em/strong/del, lewati anak link/img/code/html dan
// delimiter ter-mask), lalu jalankan m: open-only → m += n; both (atau
// close-only bila R) → rule-of-3 (y%3 && (y+n)%3===0 → f += n, lewati;
// bila tidak → m -= n); close-only → m -= n; neither → lewati. Bila
// m <= 0 TEPAT di C → boleh; bila m <= 0 sebelum C, atau m > 0 setelah
// C → tolak (coba k lebih kecil). Kandidat pertama dilewati bila pola
// __...*...__ (opener '*') atau **..._...** (opener '_'): alternatif
// pertama regex RDelim marked menelan delimiter itu sebagai teks. R dan o
// dari node tetangga opener.
function emStrongGate(nodes, oi, ci) {
  const opener = nodes[oi];
  const closer = nodes[ci];
  // Semua delimiter terlihat setelah O (urutan dokumen), sebagaimana
  // tampak di string mentah marked: run yang sudah terpakai membentuk
  // wrap tetap dihitung (dari openRun/closeRun wrap), dan satu run mentah
  // hanya dihitung sekali (dedup runId) meski terpecah jadi residu di
  // dalam/ sesudah wrap. Anak link/img/code/html tidak terlihat.
  // Pre-pass: runId yang dimiliki wrap — delim dengan runId itu adalah
  // residu run wrap tersebut dan dilewati (run penuh dari wrap yang
  // mewakili, agar aritmetika m memakai panjang run penuh seperti scan
  // marked, bukan sisa residu).
  const wrapRunIds = new Set();
  const collectWrapRuns = (list) => {
    for (const nd of list) {
      if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
        if (nd.openRun) wrapRunIds.add(nd.openRun.runId);
        if (nd.closeRun) wrapRunIds.add(nd.closeRun.runId);
        collectWrapRuns(nd.kids || []);
      } else if (nd.kids) {
        collectWrapRuns(nd.kids);
      }
    }
  };
  for (let q = oi + 1; q < nodes.length; q++) collectWrapRuns([nodes[q]]);
  const all = [];
  // Dedup runId: satu run mentah hanya dihitung sekali, dengan panjang
  // run PENUH (n terbesar di antara entri-entri run itu — wrap bisa
  // mencatat run yang sama dengan n residu, mis. closeRun em n=1 vs
  // closeRun strong n=3 untuk run yang sama). Posisi = kemunculan pertama.
  const runById = new Map();
  const runOrder = [];
  const emitRun = (entry) => {
    if (entry.runId == null) return;
    const prev = runById.get(entry.runId);
    if (!prev) {
      runById.set(entry.runId, entry);
      runOrder.push(entry.runId);
    } else if (entry.n > prev.n) {
      runById.set(entry.runId, entry);
    }
  };
  const collectAll = (list) => {
    for (const nd of list) {
      if (nd.t === 'delim') {
        if (!nd.masked && !wrapRunIds.has(nd.runId)) emitRun({ ch: nd.ch, n: nd.n, open: nd.open, close: nd.close, runId: nd.runId, node: nd });
      } else if (nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') {
        if (nd.openRun) emitRun({ ...nd.openRun, node: null });
        collectAll(nd.kids || []);
        if (nd.closeRun) emitRun({ ...nd.closeRun, node: null });
      }
    }
  };
  for (let q = oi + 1; q < nodes.length; q++) collectAll([nodes[q]]);
  for (const id of runOrder) all.push(runById.get(id));
  // Closer harus tampak sebagai run di jangkauan (lewat node-nya sendiri
  // atau lewat run wrap yang memakainya).
  const closerEntry = all.find((d) => d.runId === closer.runId);
  if (!closerEntry) return null;
  if (opener.ch === '~') {
    // Simulasi del marked: kandidat hanya run dengan panjang efektif ==
    // o (grup RDelim (~~?) maks 2 char); open-only → p += o; lainnya
    // (close-only/both) → p -= o; tanpa rule-of-3/R/o-break. Berpasangan
    // di delimiter pertama tempat p <= 0. Retry k dari n ke 1.
    const simDel = all.filter((d) => d.ch === '~');
    for (let k = opener.n; k >= 1; k--) {
      let p = k;
      for (const D of simDel) {
        const l = Math.min(D.n, 2);
        if (l !== k) continue;
        if (D.open && !D.close) {
          p += l;
          continue;
        }
        if (!D.open && !D.close) continue;
        p -= l;
        if (p <= 0) {
          if (D.runId !== closer.runId) return null;
          return { k, b: k, use: k };
        }
      }
    }
    return null;
  }
  // Skip __...*...__ / **..._...**: tiga delimiter pertama setelah O harus
  // [run lawan n>=2, kandidat pertama, run lawan n>=2] tanpa delimiter lain
  // di antaranya — DAN kandidat harus run panjang 1: alternatif regex
  // marked memakai `\*`/`_` tunggal, sehingga run `**`/`__` memblokir
  // lookahead `(?=__)`/`(?=\*\*)` (karakter kedua run bukan `__`/`**`).
  const opp = opener.ch === '*' ? '_' : '*';
  let skipRunId = -1;
  if (all.length >= 3) {
    const a0 = all[0];
    const a1 = all[1];
    const a2 = all[2];
    if (a0.ch === opp && a0.n >= 2 && a1.ch === opener.ch && a1.n === 1 && a2.ch === opp && a2.n >= 2) {
      skipRunId = a1.runId;
    }
  }
  const sim = all.filter((d) => d.ch === opener.ch && d.runId !== skipRunId);
  // R dan o dari node tetangga opener.
  const p = oi > 0 ? lastCharOf(nodes[oi - 1]) : '';
  const nextCh = oi + 1 < nodes.length ? firstCharOf(nodes[oi + 1]) : '';
  const d = nextCh !== '' && isPunctCh(nextCh);
  const h = p === '*' || p === '_' || (p !== '' && isPunctCh(p));
  const R = p !== '' && p.trim() !== '' && (d || (opener.ch === '*' && !h));
  const y = opener.n;
  for (let k = opener.n; k >= 1; k--) {
    const o = k < opener.n || p === opener.ch;
    let m = k;
    let f = 0;
    let pairedD = null;
    let mAtPair = 0;
    let fAtPair = 0;
    let broke = false;
    for (const D of sim) {
      const both = D.open && D.close;
      const openOnly = D.open && !D.close;
      const closeOnly = !D.open && D.close;
      if (!D.open && !D.close) continue;
      if (openOnly) {
        m += D.n;
        continue;
      }
      if (both || (closeOnly && R)) {
        if (o && both) {
          broke = true;
          break;
        }
        if (y % 3 !== 0 && (y + D.n) % 3 === 0) {
          f += D.n;
          continue;
        }
      }
      m -= D.n;
      if (m <= 0) {
        pairedD = D;
        mAtPair = m;
        fAtPair = f;
        break;
      }
    }
    if (pairedD) {
      // Scan marked berhenti di delimiter PERTAMA tempat m <= 0 — opener
      // berpasangan dengan delimiter itu, bukan dengan closer lain. Bila
      // bukan C, pasangan (O, C) ditolak (O akan berpasangan dengan
      // pairedD saat closer loop mencapai pairedD). Perbandingan lewat
      // runId: pairedD bisa berupa run wrap (node null) bila closer adalah
      // residu run itu.
      if (pairedD.runId !== closer.runId) return null;
      // b memakai panjang run yang TERSEDIA di node closer (closer.n) —
      // bila closer adalah residu run yang sebagian sudah dipakai wrap
      // dalam, b dihitung dari sisa itu, bukan dari run penuh (pairedD.n
      // hanya untuk aritmetika m/f scan).
      const b = Math.min(closer.n, closer.n + mAtPair + fAtPair);
      if (b < 1) return null;
      // use dari marked: min(k, b) GANJIL → em (pakai 1), GENAP → strong
      // (pakai 2). Bukan min(k, b) mentah: ***foo*** → em berisi **foo**
      // yang lalu jadi strong di dalam.
      return { k, b, use: Math.min(k, b) % 2 === 1 ? 1 : 2 };
    }
    // broke (o && both → emStrong marked gagal) atau m > 0 setelah akhir
    // jangkauan: coba k lebih kecil (inlineText mengonsumsi satu karakter
    // run sebagai teks lalu mencoba lagi).
    void broke;
  }
  return null;
}

// ---------- emphasis (algoritma CommonMark) ----------

function processEmphasis(nodes) {
  // Proses delimiter di daftar ini (rekursif ke anak link/em/del).
  for (const nd of nodes) {
    if (nd.t === 'link' || nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') processEmphasis(nd.kids);
  }
  // Kumpulkan indeks delimiter.
  let changed = true;
  // openers_bottom: closer "both" yang terpakai memblokir opener sebelumnya
  // bila (closer.n + opener.n) % 3 === 0 (probe66). Nilai closer.n % 3
  // disimpan di opener.blocked; dicek saat mencari opener.
  while (changed) {
    changed = false;
    // Cari closer pertama yang bisa membentuk pasangan.
    for (let ci = 0; ci < nodes.length; ci++) {
      const closer = nodes[ci];
      if (closer.t !== 'delim' || !closer.close || closer.masked) continue;
      // Cari opener dari PALING KIRI (bukan terdekat): marked itu
      // opener-driven — opener paling kiri dievaluasi dulu dan mengambil
      // closer-nya; gate memastikan hanya opener yang scan-m-nya
      // berpasangan dengan closer ini yang diterima, jadi opener kiri
      // yang tak berpasangan akan ditolak gate dan pencarian lanjut ke
      // opener berikutnya.
      for (let oi = 0; oi < ci; oi++) {
        const opener = nodes[oi];
        if (opener.t === 'delim' && opener.ch === closer.ch && opener.open && !opener.masked) {
          // Jangan pakai opener yang sudah dilewati closer ini sebelumnya.
          if (closer.skipped && closer.skipped.has(opener)) continue;
          // (Dihapus: logika blocked/openers_bottom CommonMark — marked
          // tidak memilikinya; gate simulasi-m + pencarian opener dari
          // paling kiri sudah menangani kasus probe66/67. Blocked malah
          // memblokir opener luar yang seharusnya berpasangan per marked,
          // mis. doc-11/doc-30 `**... *...* ...**`.)
          // Gate simulasi-m emStrong marked (doc-11): opener ini hanya
          // boleh berpasangan dengan closer ini bila scan-m marked dari
          // opener mencapai 0 tepat di closer ini. Mengembalikan k/b/use.
          const gateRes = emStrongGate(nodes, oi, ci);
          if (!gateRes) continue;
          // Aturan jumlah 3.
          const oddMatch = (opener.n + closer.n) % 3 === 0 && opener.n % 3 !== 0 && closer.n % 3 !== 0;
          const bothOpenClose =
            (opener.open && opener.close) || (closer.open && closer.close);
          if (oddMatch && bothOpenClose) continue;
          // Gunakan 1 atau 2 delimiter — dari simulasi gate (min(k, b)
          // ganjil → 1, genap → 2), bukan sekadar min run: b bisa < run
          // bila m+f sangat negatif. Untuk '~', gate mengembalikan
          // use = k (panjang retry yang berpasangan).
          let use = gateRes.use;
          const kids = nodes.slice(oi + 1, ci);
          // Penempatan residu ala raw M marked: sisa opener (n-k) jadi teks
          // literal SEBELUM wrap (karakter itu dikonsumsi sebagai teks
          // saat retry), sisa opener (k-use) jadi delimiter di AWAL teks
          // dalam (ditokenisasi ulang bersama kids), sisa closer (b-use)
          // jadi delimiter di AKHIR teks dalam, sisa closer (run-b) jadi
          // delimiter SESUDAH wrap.
          const innerKids = kids.slice();
          const { k, b } = gateRes;
          if (k > use) {
            const afterCh = innerKids.length > 0 ? firstCharOf(innerKids[0]) : '';
            const fl = delimFlags(opener.ch, '', afterCh);
            innerKids.unshift({ t: 'delim', ch: opener.ch, n: k - use, open: fl.open, close: fl.close, runId: opener.runId });
          }
          if (b > use) {
            const beforeCh = innerKids.length > 0 ? lastCharOf(innerKids[innerKids.length - 1]) : '';
            const fl = delimFlags(closer.ch, beforeCh, '');
            innerKids.push({ t: 'delim', ch: closer.ch, n: b - use, open: fl.open, close: fl.close, runId: closer.runId });
          }
          const wrap = opener.ch === '~' ? { t: 'del', kids: innerKids } : use === 2 ? { t: 'strong', kids: innerKids } : { t: 'em', kids: innerKids };
          // Run mentah yang membentuk wrap ini, agar gate simulasi-m
          // (yang melihat string mentah marked) tetap menghitung run ini
          // meski sudah terpakai: openRun di awal kids, closeRun di akhir.
          wrap.openRun = { ch: opener.ch, n: opener.n, open: opener.open, close: opener.close, runId: opener.runId };
          wrap.closeRun = { ch: closer.ch, n: closer.n, open: closer.open, close: closer.close, runId: closer.runId };
          // Sisa delimiter opener/closer.
          const before = nodes.slice(0, oi);
          const after = nodes.slice(ci + 1);
          const mid = [];
          if (opener.n > k) {
            // (n-k) karakter awal run dikonsumsi sebagai teks literal.
            mid.push({ t: 'text', s: escAll(opener.ch.repeat(opener.n - k)) });
          }
          mid.push(wrap);
          if (closer.n > b) {
            const right = { t: 'delim', ch: closer.ch, n: closer.n - b, open: closer.open, close: closer.close, runId: closer.runId };
            if (closer.blocked) right.blocked = new Set(closer.blocked);
            if (closer.skipped) right.skipped = new Set(closer.skipped);
            mid.push(right);
          }
          nodes.length = 0;
          nodes.push(...before, ...mid, ...after);
          changed = true;
          break;
        }
        // Delimiter lain di antaranya tidak menghalangi pencarian opener
        // (delimiter dengan karakter berbeda dilewati).
      }
      if (changed) break;
    }
  }
  // Sisa delimiter jadi teks literal (dirender oleh renderNodes).
  // Proses emphasis di dalam anak-anak link/img/em/strong/del secara
  // rekursif (delimiter di dalam link/image tidak terlihat dari level atas).
  for (const nd of nodes) {
    if (nd.kids) processEmphasis(nd.kids);
  }
}

// ---------- block parsing ----------

const BLOCK_TAGS = new Set(
  'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' ')
);

const SCRIPT_END = /<\/script(\s|>)/i;
const PRE_END = /<\/pre(\s|>)/i;
const STYLE_END = /<\/style(\s|>)/i;
const TEXTAREA_END = /<\/textarea(\s|>)/i;

function setextLevel(line, pos) {
  if (pos >= line.length) return 0;
  const ch = line.charCodeAt(pos);
  if (ch !== 61 && ch !== 45) return 0;
  let i = pos;
  while (i < line.length && line.charCodeAt(i) === ch) i++;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return 0;
    i++;
  }
  return ch === 61 ? 1 : 2;
}

function isHrLine(line, pos) {
  if (pos >= line.length) return false;
  const ch = line.charCodeAt(pos);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let count = 0;
  for (let i = pos; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

function atxInfo(line, pos) {
  if (line.charCodeAt(pos) !== 35) return null;
  let j = pos;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const level = j - pos;
  if (level > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return { level, contentStart: j };
}

function fenceInfo(line, pos) {
  const ch = line.charCodeAt(pos);
  if (ch !== 96 && ch !== 126) return null;
  let j = pos;
  while (j < line.length && line.charCodeAt(j) === ch) j++;
  const len = j - pos;
  if (len < 3) return null;
  const info = line.slice(j);
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch: String.fromCharCode(ch), len, info, indent: indentInfo(line).cols };
}

// Jenis HTML block 1-7 mulai di line[pos]==='<' (indent < 4). null bila bukan.
function htmlBlockType(line, pos) {
  if (line.charCodeAt(pos) !== 60) return 0;
  const rest = line.slice(pos);
  const low = rest.toLowerCase();
  // Tipe 1: script/pre/style/textarea
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (low.startsWith('<' + tag)) {
      const after = low[1 + tag.length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>') return 1;
    }
  }
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (low.startsWith('<!') && low.length > 2) {
    const d = low.charCodeAt(2);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) return 4;
  }
  if (low.startsWith('<![cdata[')) return 5;
  // Tipe 6: tag blok
  let tagName = '';
  let k = pos + 1;
  if (line.charCodeAt(k) === 47) k++;
  const ns = k;
  while (k < line.length) {
    const d = line.charCodeAt(k);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45) k++;
    else break;
  }
  tagName = line.slice(ns, k).toLowerCase();
  if (tagName !== '' && BLOCK_TAGS.has(tagName)) {
    const after = line[k];
    // Terminator: whitespace, akhir baris, '>', atau '/>' (bukan '/' saja).
    if (after === undefined || after === ' ' || after === '\t' || after === '>') return 6;
    if (after === '/' && line[k + 1] === '>') return 6;
  }
  // Tipe 7: tag lengkap sendirian di baris.
  const tag = parseHtmlTag(line, pos);
  if (tag) {
    let e = tag.end;
    while (e < line.length && (line.charCodeAt(e) === 32 || line.charCodeAt(e) === 9)) e++;
    if (e === line.length) return 7;
  }
  return 0;
}

function htmlBlockEnds(line, type) {
  switch (type) {
    case 1: {
      const low = line.toLowerCase();
      return (
        (low.includes('</script') && SCRIPT_END.test(line)) ||
        (low.includes('</pre') && PRE_END.test(line)) ||
        (low.includes('</style') && STYLE_END.test(line)) ||
        (low.includes('</textarea') && TEXTAREA_END.test(line))
      );
    }
    case 2:
      return line.includes('-->');
    case 3:
      return line.includes('?>');
    case 4:
      return line.includes('>');
    case 5:
      return line.includes(']]>');
    default:
      return false;
  }
}

// ---------- link reference definitions ----------

// Coba parse definisi referensi mulai di lines[i] (indent < 4).
// Mengembalikan {end, label, dest, title} (end = indeks baris eksklusif) atau null.
// Chunk = baris-baris sampai baris kosong pertama (atau i+64 / b); judul
// boleh lintas banyak baris. Bila judul gagal / ada sampah setelahnya,
// fallback ke definisi dest-only (bila sisa baris dest hanya whitespace),
// KECUALI bila judul ada di baris yang sama dengan dest dan gagal.
function tryRefDef(lines, i, b) {
  let j = i;
  while (j < b && j < i + 64 && !isBlankLine(lines[j])) j++;
  const chunkLines = lines.slice(i, j);
  const chunk = chunkLines.join('\n');
  // chunkComplete: chunk berakhir di EOF / baris kosong (bukan terpotong).
  const chunkComplete = j >= b || isBlankLine(lines[j]);
  const ind = indentInfo(chunk);
  if (ind.cols >= 4) return null;
  let p = ind.pos;
  if (chunk.charCodeAt(p) !== 91) return null;
  // Label: [ ... ] — berakhir di ']' pertama yang tidak di-escape.
  // Backslash dipertahankan mentah (label 'foo\!' != 'foo!'). '[' tanpa
  // escape membuat label INVALID (ref-def tidak terbentuk).
  let label = '';
  let q = p + 1;
  let closed = -1;
  while (q < chunk.length) {
    const d = chunk.charCodeAt(q);
    if (d === 92 && q + 1 < chunk.length && isAsciiPunct(chunk.charCodeAt(q + 1))) {
      label += chunk[q];
      label += chunk[q + 1];
      q += 2;
      continue;
    }
    if (d === 91) return null;
    if (d === 93) {
      closed = q;
      break;
    }
    if (d === 10) label += ' ';
    else label += chunk[q];
    q++;
  }
  if (closed === -1) return null;
  if (label.trim() === '' || label.length > 999) return null;
  q = closed + 1;
  if (chunk.charCodeAt(q) !== 58) return null;
  q++;
  // Lewati spasi/newline (tanpa melewati baris kosong). Bila newline
  // diikuti akhir chunk: valid hanya bila chunkComplete (EOF / baris kosong).
  const skipWsNoBlank = (pos) => {
    let r = pos;
    while (r < chunk.length) {
      const d = chunk.charCodeAt(r);
      if (d === 32 || d === 9) {
        r++;
        continue;
      }
      if (d === 10) {
        let t = r + 1;
        while (t < chunk.length && (chunk.charCodeAt(t) === 32 || chunk.charCodeAt(t) === 9)) t++;
        if (t >= chunk.length) return chunkComplete ? chunk.length : -1;
        if (chunk.charCodeAt(t) === 10) return -1;
        r = t;
        continue;
      }
      break;
    }
    return r;
  };
  q = skipWsNoBlank(q);
  if (q === -1) return null;
  const dest = parseDest(chunk, q);
  if (!dest) return null;
  q = dest.end;
  let title = null;
  let endPos = q;
  // Setelah dest: spasi/newline lalu judul opsional, lalu akhir baris.
  let k = skipWsNoBlank(q);
  if (k === -1) return null;
  if (k < chunk.length && chunk.charCodeAt(k) !== 10) {
    if (k === q) return null; // judul butuh pemisah spasi
    const destLineEnd = chunk.indexOf('\n', q);
    const titleSameLine = destLineEnd === -1 || k < destLineEnd;
    const t = parseTitle(chunk, k);
    if (t) {
      let e = t.end;
      while (e < chunk.length && (chunk.charCodeAt(e) === 32 || chunk.charCodeAt(e) === 9)) e++;
      if (e >= chunk.length || chunk.charCodeAt(e) === 10) {
        // Judul valid dan hanya whitespace sampai akhir baris.
        title = t.title;
        endPos = e;
      } else {
        // Ada sampah setelah judul.
        if (titleSameLine) return null;
        // Judul di baris berikut: fallback dest-only bila sisa baris dest
        // hanya whitespace.
        let e2 = q;
        while (e2 < chunk.length && (chunk.charCodeAt(e2) === 32 || chunk.charCodeAt(e2) === 9)) e2++;
        if (e2 >= chunk.length || chunk.charCodeAt(e2) === 10) endPos = e2;
        else return null;
      }
    } else {
      // Judul gagal diparse.
      if (titleSameLine) return null;
      // Fallback dest-only bila sisa baris dest hanya whitespace.
      let e2 = q;
      while (e2 < chunk.length && (chunk.charCodeAt(e2) === 32 || chunk.charCodeAt(e2) === 9)) e2++;
      if (e2 >= chunk.length || chunk.charCodeAt(e2) === 10) endPos = e2;
      else return null;
    }
  }
  // Jumlah baris yang terpakai: 1 + jumlah '\n' sebelum posisi akhir.
  let consumed = 1;
  for (let r = 0; r < endPos && r < chunk.length; r++) if (chunk.charCodeAt(r) === 10) consumed++;
  return { end: i + consumed, label: normalizeLabel(label), dest: dest.dest, title };
}

// ---------- tabel GFM ----------

// Bagi baris tabel jadi sel. Pemisah '|' murni berbasis backslash: '\|'
// jadi '|' literal, '\\' (dua backslash) BUKAN escape sehingga '|' setelahnya
// tetap memisah; '|' di dalam code span TETAP memisah.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      const d = line.charCodeAt(i + 1);
      if (d === 124) {
        cur += '|';
        i += 2;
        continue;
      }
      if (d === 92) {
        cur += '\\\\';
        i += 2;
        continue;
      }
    }
    if (c === 124) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  cells.push(cur);
  // Buang sel kosong di tepi (dari '|' pembuka/penutup).
  let start = 0;
  let end = cells.length;
  if (cells.length > 0 && cells[0].trim() === '') start = 1;
  if (end > start && cells[end - 1].trim() === '') end--;
  return cells.slice(start, end).map((x) => x.trim());
}

function isTableDelimiter(line, pos) {
  // Fast path: baris delimiter tabel hanya berisi spasi/tab, '|', ':'
  // dan '-'. Karakter lain apa pun (huruf, '\', dsb.) pasti membuat
  // selnya gagal regex /^:?-+:?$/ — jadi langsung false tanpa split.
  for (let i = pos; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 124 && c !== 58 && c !== 45) return false;
  }
  const cells = splitTableRow(line.slice(pos));
  if (cells.length === 0) return false;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return false;
  }
  return true;
}

function tableAlign(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

// ---------- marker list ----------

function parseMarker(line, expectedCols) {
  // Guard: baris yang bukan string (mis. akses di luar range saat
  // mengumpulkan item list) bukan marker.
  if (typeof line !== 'string') return null;
  const info = indentInfo(line);
  if (expectedCols !== undefined && info.cols !== expectedCols) return null;
  if (info.cols >= 4 && expectedCols === undefined) return null;
  const pos = info.pos;
  if (pos >= line.length) return null;
  const ch = line.charCodeAt(pos);
  let markerCols = info.cols;
  let ordered = false;
  let bullet = '';
  let delim = '';
  let start = 0;
  let p = pos;
  if (ch === 45 || ch === 43 || ch === 42) {
    bullet = String.fromCharCode(ch);
    p++;
    markerCols += 1;
  } else if (ch >= 48 && ch <= 57) {
    let q = p;
    while (q < line.length && line.charCodeAt(q) >= 48 && line.charCodeAt(q) <= 57) q++;
    if (q - p > 9) return null;
    if (q >= line.length) return null;
    const d = line.charCodeAt(q);
    if (d !== 46 && d !== 41) return null;
    delim = String.fromCharCode(d);
    start = parseInt(line.slice(p, q), 10);
    ordered = true;
    markerCols += q - p + 1;
    p = q + 1;
  } else {
    return null;
  }
  // Spasi setelah marker.
  let wsCols = 0;
  let col = markerCols;
  let r = p;
  while (r < line.length) {
    const d = line.charCodeAt(r);
    if (d === 32) {
      col++;
      wsCols++;
      r++;
    } else if (d === 9) {
      const w = 4 - (col % 4);
      col += w;
      wsCols += w;
      r++;
    } else break;
  }
  const empty = r >= line.length;
  let contentIndent;
  if (empty) contentIndent = markerCols + 1;
  else if (wsCols === 0) return null;
  else if (wsCols >= 5) contentIndent = markerCols + 1;
  else contentIndent = markerCols + wsCols;
  return {
    bullet,
    ordered,
    delim,
    start,
    markerCols,
    contentIndent,
    empty,
    typeKey: ordered ? 'o' + delim : 'b' + bullet,
  };
}

// Apakah baris ini bisa melanjutkan paragraf (bukan pemula blok lain)?
// Setext & delimiter tabel dianggap kelanjutan paragraf.
function isParaContinuationLine(line) {
  if (isBlankLine(line)) return false;
  const info = indentInfo(line);
  if (info.cols >= 4) return true;
  const pos = info.pos;
  // Garis setext '-' yang juga HR (--- dst.) BUKAN kelanjutan lazy: ia
  // mengakhiri quote/list. '--' (2 dash) masih kelanjutan.
  if (setextLevel(line, pos) === 2 && isHrLine(line, pos)) return false;
  if (setextLevel(line, pos) > 0) return true;
  if (isTableDelimiter(line, pos)) return true;
  return !wouldInterruptParagraph(line);
}

function wouldInterruptParagraph(line) {
  const info = indentInfo(line);
  if (info.cols >= 4) return false;
  const pos = info.pos;
  if (pos >= line.length) return false;
  const c = line.charCodeAt(pos);
  if (c === 35 && atxInfo(line, pos)) return true;
  if ((c === 96 || c === 126) && fenceInfo(line, pos)) return true;
  if (isHrLine(line, pos)) return true;
  if (c === 60) {
    const t = htmlBlockType(line, pos);
    if (t >= 1 && t <= 6) return true;
  }
  if (c === 62) return true;
  const m = parseMarker(line);
  if (m) {
    if (!m.empty) {
      if (!m.ordered) return true;
      if (m.start === 1) return true;
    }
  }
  return false;
}

// Ordered list marker non-kosong dengan start != 1. Di dalam LIST ITEM,
// marker seperti ini BOLEH memutus paragraf (marked/cmark: sublist
// terbentuk), sedangkan di top-level / blockquote TIDAK (wouldInterrupt
// mengembalikan false). Dipakai bersama inListItem di renderBlocks.
function isOrderedListNonOne(line) {
  const m = parseMarker(line);
  return !!(m && m.ordered && !m.empty && m.start !== 1);
}

// Apakah baris ini bisa jadi kelanjutan LAZY dari paragraf di dalam container
// (quote/list)? STRICT: false bila memulai blok apa pun — termasuk marker
// list apa pun (tipe/start/delimiter apa pun), tidak seperti
// wouldInterruptParagraph yang hanya menginterupsi untuk marker tertentu.
// Setext & delimiter tabel dianggap kelanjutan (garis setext yang juga HR
// bukan kelanjutan).
function isLazyContinuationLine(line) {
  if (isBlankLine(line)) return false;
  const info = indentInfo(line);
  if (info.cols >= 4) return true;
  const pos = info.pos;
  if (isHrLine(line, pos)) return false;
  if (setextLevel(line, pos) > 0) return true;
  if (isTableDelimiter(line, pos)) return true;
  const c = line.charCodeAt(pos);
  if (c === 35 && atxInfo(line, pos)) return false;
  if ((c === 96 || c === 126) && fenceInfo(line, pos)) return false;
  if (c === 60) {
    const t = htmlBlockType(line, pos);
    if (t >= 1 && t <= 6) return false;
  }
  if (c === 62) return false;
  if (parseMarker(line)) return false;
  return true;
}

// Apakah baris (setelah strip prefix quote/list berulang) berakhir di dalam
// paragraf? Dipakai untuk update inPara di collectQuote. Baris berindent
// >= 4 mengikuti status sebelumnya (kelanjutan paragraf bila sudah di dalam
// paragraf, indented code bila belum). Prefix quote/list di-strip DULU,
// baru baris terdalam dinilai (setext/tabel/interrupt) — agar baris seperti
// '> > > foo' atau '1. > Blockquote' dikenali berakhir di paragraf.
function lineEndsInPara(s, prevInPara) {
  let cur = s;
  while (true) {
    if (isBlankLine(cur)) return false;
    const info = indentInfo(cur);
    if (info.cols >= 4) return prevInPara;
    const pos = info.pos;
    if (cur.charCodeAt(pos) === 62) {
      const stripped = stripQuotePrefix(cur);
      if (stripped === null) return true;
      cur = stripped;
      continue;
    }
    const m = parseMarker(cur);
    if (m) {
      if (m.empty) return false;
      cur = stripCols(cur, m.contentIndent);
      continue;
    }
    // Baris terdalam: setext / delimiter tabel / pemula blok mengakhiri paragraf.
    if (setextLevel(cur, pos) > 0) return false;
    if (isTableDelimiter(cur, pos)) return false;
    if (wouldInterruptParagraph(cur)) return false;
    return true;
  }
}


// Apakah lines[j] menutup fenced code (fenceInfo f)?
function isFenceClose(line, f) {
  const li = indentInfo(line);
  if (li.cols >= 4) return false;
  const ch = line.charCodeAt(li.pos);
  if (ch !== f.ch.charCodeAt(0)) return false;
  let k = li.pos;
  while (k < line.length && line.charCodeAt(k) === ch) k++;
  if (k - li.pos < f.len) return false;
  for (let q = k; q < line.length; q++) {
    const d = line.charCodeAt(q);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

// Lewati fenced code mulai di lines[i]. Kembalikan indeks akhir (eksklusif).
function skipFence(lines, i, b, f) {
  let j = i + 1;
  while (j < b) {
    if (isFenceClose(lines[j], f)) return j + 1;
    j++;
  }
  return j;
}

// Lewati indented code mulai di lines[i].
function skipIndentedCode(lines, i, b) {
  let j = i;
  while (j < b) {
    const l = lines[j];
    if (isBlankLine(l)) {
      j++;
      continue;
    }
    if (indentInfo(l).cols >= 4) {
      j++;
      continue;
    }
    break;
  }
  return j;
}

// Lewati HTML block mulai di lines[i] (tipe t). Kembalikan indeks akhir.
function skipHtmlBlock(lines, i, b, t) {
  let j = i + 1;
  if (t === 6 || t === 7) {
    while (j < b && !isBlankLine(lines[j])) j++;
    return j;
  }
  if (htmlBlockEnds(lines[i], t)) return j;
  while (j < b) {
    if (htmlBlockEnds(lines[j], t)) return j + 1;
    j++;
  }
  return j;
}

// Akhir paragraf mulai di lines[i] (mirip kolektor paragraf di renderBlocks,
// tapi tanpa rendering). Kembalikan indeks akhir (eksklusif).
// inListItem: bila paragraf ini berada di dalam list item, marker ordered
// non-1 (mis. `2.`, `446815.`) MEMUTUS paragraf — di dalam item, marker itu
// memulai sublist, sedangkan di top-level ia hanya kelanjutan paragraf.
function scanParagraphEnd(lines, i, b, inListItem = false) {
  let j = i + 1;
  while (j < b) {
    const l = lines[j];
    if (isBlankLine(l)) break;
    const li = indentInfo(l);
    if (li.cols >= 4) {
      j++;
      continue;
    }
    if (setextLevel(l, li.pos) > 0) {
      j++;
      break;
    }
    if (isTableDelimiter(l, li.pos)) {
      const hdrCells = splitTableRow(lines[j - 1]);
      const delCells = splitTableRow(l.slice(li.pos));
      if (hdrCells.length === delCells.length && hdrCells.length > 0) {
        j++;
        while (j < b && (!isBlankLine(lines[j]) || isTabOnly(lines[j]))) j++;
        break;
      }
    }
    if (wouldInterruptParagraph(l) || (inListItem && isOrderedListNonOne(l))) break;
    j++;
  }
  return j;
}

// Kumpulkan SEMUA definisi referensi link di range lines[a..b) ke `refs`
// (first wins). Mirror struktur blok renderBlocks: definisi di dalam paragraf
// atau code/HTML TIDAK dikumpulkan; definisi di dalam quote/list berlaku
// document-wide.
function scanRefs(lines, a, b, refs, inListItem = false) {
  let i = a;
  while (i < b) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const info = indentInfo(line);
    const pos = info.pos;
    if (info.cols < 4) {
      const def = tryRefDef(lines, i, b);
      if (def) {
        if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
        i = def.end;
        continue;
      }
    }
    if (info.cols < 4 && atxInfo(line, pos)) {
      i++;
      continue;
    }
    if (info.cols < 4) {
      const f = fenceInfo(line, pos);
      if (f) {
        i = skipFence(lines, i, b, f);
        continue;
      }
    }
    if (info.cols >= 4) {
      i = skipIndentedCode(lines, i, b);
      continue;
    }
    if (info.cols < 4) {
      const t = htmlBlockType(line, pos);
      if (t > 0) {
        i = skipHtmlBlock(lines, i, b, t);
        continue;
      }
    }
    if (info.cols < 4 && isHrLine(line, pos)) {
      i++;
      continue;
    }
    if (info.cols < 4 && line.charCodeAt(pos) === 62) {
      const q = collectQuote(lines, i, b);
      // Isi blockquote dinilai dari konteks quote sendiri (bukan item).
      scanRefs(q.qlines, 0, q.qlines.length, refs, false);
      i = q.end;
      continue;
    }
    if (info.cols < 4) {
      const mk = parseMarker(line);
      if (mk) {
        const lst = collectListItems(lines, i, b, mk.typeKey);
        if (lst) {
          // Isi tiap item list berada di dalam list item.
          for (const item of lst.items) scanRefs(item.lines, 0, item.lines.length, refs, true);
          i = lst.end;
          continue;
        }
      }
    }
    i = scanParagraphEnd(lines, i, b, inListItem);
  }
}

// ---------- render blok utama ----------

function renderBlocks(lines, a, b, refs, paraTight, firstParaPrefix, inContainer, trailingNL, inListItem, lineLazy) {
  let out = '';
  let i = a;
  let prefixUsed = firstParaPrefix === null || firstParaPrefix === undefined;
  while (i < b) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const info = indentInfo(line);
    const pos = info.pos;
    // Link reference definition.
    if (info.cols < 4) {
      const def = tryRefDef(lines, i, b);
      if (def) {
        if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
        i = def.end;
        continue;
      }
    }
    // ATX heading.
    if (info.cols < 4) {
      const atx = atxInfo(line, pos);
      if (atx) {
        let content = line.slice(atx.contentStart).trim();
        // Buang closing sequence ' #' di akhir.
        if (content.length > 0) {
          let e = content.length;
          while (e > 0 && content.charCodeAt(e - 1) === 35) e--;
          if (e < content.length && e > 0 && (content.charCodeAt(e - 1) === 32 || content.charCodeAt(e - 1) === 9)) {
            content = content.slice(0, e).trim();
          } else if (e === 0) {
            content = '';
          }
        }
        out += '<h' + atx.level + '>' + parseInline(content, refs) + '</h' + atx.level + '>\n';
        i++;
        continue;
      }
    }
    // Fenced code.
    if (info.cols < 4) {
      const f = fenceInfo(line, pos);
      if (f) {
        const contentLines = [];
        let j = i + 1;
        while (j < b) {
          if (isFenceClose(lines[j], f)) {
            j++;
            break;
          }
          // Strip indent konten HANYA untuk fence backtick (marked hanya
          // begitu untuk '`'): fence tilde membiarkan baris konten apa
          // adanya, termasuk indent penuhnya.
          if (f.ch === '`') contentLines.push(stripFenceIndent(lines[j], f.indent));
          else contentLines.push(lines[j]);
          j++;
        }
        const infoStr = f.info.trim();
        let lang = '';
        if (infoStr !== '') {
          const sp = infoStr.search(/[ \t]/);
          lang = sp === -1 ? infoStr : infoStr.slice(0, sp);
          // Unescape \punct di kata bahasa, lalu escape entity-aware.
          lang = lang.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
        }
        // Konten: baris-baris digabung '\n', plus '\n' akhir KECUALI bila
        // baris konten terakhir benar-benar kosong ('') — satu baris kosong
        // akhir dibuang. Baris whitespace-only (mis. '  ') tetap dapat '\n'.
        let content = '';
        if (contentLines.length > 0) {
          content = contentLines.join('\n');
          if (contentLines[contentLines.length - 1] !== '') content += '\n';
        }
        out += '<pre><code' + (lang !== '' ? ' class="language-' + escEntityAware(lang) + '"' : '') + '>' + escAll(content) + '</code></pre>\n';
        i = j;
        continue;
      }
    }
    // Indented code.
    if (info.cols >= 4) {
      const contentLines = [];
      let j = i;
      let pendingBlanks = [];
      while (j < b) {
        const l = lines[j];
        if (isBlankLine(l)) {
          // Baris kosong di dalam indented code menyumbang sisanya setelah
          // strip 4 kolom (bukan string kosong).
          pendingBlanks.push(stripCols(l, 4));
          j++;
          continue;
        }
        const li = indentInfo(l);
        if (li.cols >= 4) {
          while (pendingBlanks.length > 0) {
            contentLines.push(pendingBlanks.shift());
          }
          contentLines.push(stripCols(l, 4));
          j++;
          continue;
        }
        break;
      }
      const content = contentLines.join('\n') + '\n';
      out += '<pre><code>' + escAll(content) + '</code></pre>\n';
      i = j;
      continue;
    }
    // HTML block.
    if (info.cols < 4) {
      const t = htmlBlockType(line, pos);
      if (t > 0) {
        const hlines = [line];
        let j = i + 1;
        if (t === 6 || t === 7) {
          // Tipe 6/7: berlanjut sampai baris kosong.
          while (j < b && !isBlankLine(lines[j])) {
            hlines.push(lines[j]);
            j++;
          }
        } else {
          // Tipe 1-5: sampai baris yang mengandung penutup.
          if (!htmlBlockEnds(line, t)) {
            while (j < b) {
              hlines.push(lines[j]);
              if (htmlBlockEnds(lines[j], t)) {
                j++;
                break;
              }
              j++;
            }
          }
        }
        out += hlines.join('\n');
        // Teks HTML block ala marked: regex mentah menelan newline setelah
        // baris terakhir blok, plus baris-baris kosong sesudahnya sesuai
        // tipe (tipe 1-5 menelan '\n' berurutan; tipe 6/7 menelan
        // baris-baris whitespace-only berurutan). Lalu ge(): bila raw
        // berakhir dengan >= 2 baris kosong, newline akhir dibuang;
        // bila <= 1 baris kosong, newline akhir dipertahankan. Jadi
        // blok yang diikuti baris kosong murni tak punya '\n' akhir,
        // tapi blok yang diikuti baris whitespace-only ('\t'/' ') tetap
        // punya '\n' akhir — itulah beda doc-15/19/24 vs cm-148/149.
        let tail = '';
        let tailBlanks = 0;
        if (j >= b) {
          if (trailingNL) { tail = '\n'; tailBlanks = 1; }
        } else if (t === 6 || t === 7) {
          tail = '\n';
          tailBlanks = 1;
          let k = j;
          while (k < b && /^[ \t]*$/.test(lines[k])) {
            tail += lines[k];
            k++;
            // Baris whitespace-only hanya tertelan beserta newline-nya
            // bila ada newline sesudahnya; bila ini baris terakhir tanpa
            // newline, terminator gagal dan raw jatuh ke $ (sampai EOF):
            // baris itu menggantikan '' akhir, bukan menambah blank.
            if (k < b || trailingNL) { tail += '\n'; tailBlanks++; }
            else break;
          }
        } else {
          // Tipe 1-5: '\n' berurutan setelah baris terakhir tertelan —
          // satu '\n' penutup baris html + satu per baris kosong murni.
          tail = '\n';
          let k = j;
          while (k < b && lines[k] === '' && (k + 1 < b || trailingNL)) {
            tail += '\n';
            k++;
          }
          tailBlanks = tail.length;
        }
        if (tailBlanks <= 1) out += tail;
        i = j;
        continue;
      }
    }
    // Thematic break.
    if (info.cols < 4 && isHrLine(line, pos)) {
      out += '<hr>\n';
      i++;
      continue;
    }
    // Blockquote.
    if (info.cols < 4 && line.charCodeAt(pos) === 62) {
      const q = collectQuote(lines, i, b);
      out += '<blockquote>\n' + renderBlocks(q.qlines, 0, q.qlines.length, refs, false, null, true, false, false, q.qlazy) + '</blockquote>\n';
      i = q.end;
      continue;
    }
    // List.
    if (info.cols < 4) {
      const lst = parseList(lines, i, b, refs);
      if (lst) {
        out += lst.html;
        i = lst.end;
        continue;
      }
    }
    // Paragraf (dengan setext / tabel).
    {
      const pLines = [line];
      let j = i + 1;
      let headingLevel = 0;
      let isTable = false;
      let tableDelim = null;
      // Strip 4 kolom ala marked untuk baris LAZY berindent di awal chunk:
      // marked me-lex ulang chunk lazy sebagai token indented-code (strip
      // 4 kolom) lalu menggabungkan teksnya ke paragraf sebelumnya — jadi
      // strip terjadi di TEKS paragraf, bukan di struktur blok (teks hasil
      // strip seperti '- bar' tidak boleh dibaca ulang sebagai list).
      // Run strip dimulai baris lazy pertama yang berindent >= 4 dan
      // berlanjut ke baris-baris berindent >= 4 berikutnya (lazy maupun
      // ber-'>'); baris pertama yang tak-berindent mengakhiri run.
      let stripRun = false;
      let prevLazy = false;
      const paraLine = (l, idx, cols) => {
        const lazy = lineLazy ? !!lineLazy[idx] : false;
        if (lazy && !prevLazy) stripRun = cols >= 4;
        let out = l;
        if (stripRun) {
          if (cols >= 4) out = stripCols(l, 4);
          else if (!isBlankLine(l)) stripRun = false;
        }
        prevLazy = lazy;
        // Di dalam list item, kelanjutan berindent >= 4 juga kehilangan
        // 4 kolom (contStrip) bila tidak sudah di-strip oleh run lazy.
        if (out === l && inListItem && cols >= 4) out = stripCols(l, 4);
        return out;
      };
      while (j < b) {
        const l = lines[j];
        // Baris kosong mengakhiri paragraf, KECUALI baris whitespace-only
        // non-kosong di akhir range tanpa trailing newline (mis. ' ' terakhir
        // di dalam quote): ia jadi kelanjutan paragraf.
        if (isBlankLine(l)) {
          if (l !== '' && j === b - 1 && !trailingNL) {
            pLines.push(l);
            j++;
            continue;
          }
          break;
        }
        const li = indentInfo(l);
        if (li.cols >= 4) {
          pLines.push(paraLine(l, j, li.cols));
          j++;
          continue;
        }
        const se = setextLevel(l, li.pos);
        if (se > 0) {
          headingLevel = se;
          j++;
          break;
        }
        if (isTableDelimiter(l, li.pos)) {
          const hdrCells = splitTableRow(pLines[pLines.length - 1]);
          const delCells = splitTableRow(l.slice(li.pos));
          if (hdrCells.length === delCells.length && hdrCells.length > 0) {
            isTable = true;
            tableDelim = delCells;
            j++;
            break;
          }
        }
        if (wouldInterruptParagraph(l) || (inListItem && isOrderedListNonOne(l))) break;
        pLines.push(paraLine(l, j, li.cols));
        j++;
      }
      if (headingLevel > 0) {
        out += '<h' + headingLevel + '>' + parseInline(pLines.join('\n').trim(), refs) + '</h' + headingLevel + '>\n';
        i = j;
        continue;
      }
      if (isTable) {
        const headerLine = pLines[pLines.length - 1];
        if (pLines.length > 1) {
          const pre = pLines.slice(0, -1).join('\n');
          out += paraHtml(pre, refs, paraTight, prefixUsed ? null : firstParaPrefix);
          if (!prefixUsed) prefixUsed = true;
        }
        const aligns = tableDelim.map(tableAlign);
        const headCells = splitTableRow(headerLine);
        let t = '<table>\n<thead>\n<tr>\n';
        for (let ci = 0; ci < headCells.length; ci++) {
          const al = aligns[ci];
          t += '<th' + (al ? ' align="' + al + '"' : '') + '>' + parseInline(headCells[ci], refs) + '</th>\n';
        }
        t += '</tr>\n</thead>\n';
        const rows = [];
        // Baris tabel berhenti bila baris memulai blok lain (mis. '>').
        // Baris hanya-tab dihitung sebagai baris tabel kosong (probe51).
        while (j < b && (!isBlankLine(lines[j]) || isTabOnly(lines[j])) && !wouldInterruptParagraph(lines[j])) {
          rows.push(lines[j]);
          j++;
        }
        if (rows.length > 0) {
          t += '<tbody>';
          for (let ri = 0; ri < rows.length; ri++) {
            const cells = splitTableRow(rows[ri]);
            t += '<tr>\n';
            for (let ci = 0; ci < headCells.length; ci++) {
              const al = aligns[ci];
              const cell = ci < cells.length ? cells[ci] : '';
              t += '<td' + (al ? ' align="' + al + '"' : '') + '>' + parseInline(cell, refs) + '</td>\n';
            }
            t += '</tr>\n';
          }
          t += '</tbody></table>\n';
        } else {
          t += '</table>\n';
        }
        out += t;
        i = j;
        continue;
      }
      out += paraHtml(pLines.join('\n'), refs, paraTight, prefixUsed ? null : firstParaPrefix);
      if (!prefixUsed) prefixUsed = true;
      i = j;
    }
  }
  return out;
}

function paraHtml(text, refs, tight, prefix) {
  const inner = parseInline(text, refs);
  const withPrefix = prefix ? prefix + ' ' + inner : inner;
  if (tight) return withPrefix;
  return '<p>' + withPrefix + '</p>\n';
}

// Kumpulkan baris blockquote mulai di lines[i].
// Mengembalikan {qlines, end, qlazy}. Baris kosong TANPA marker '>' mengakhiri
// quote; baris '>' (marker + kosong) tetap bagian dari quote yang sama.
// inPara dihitung dari baris terdalam (setelah strip prefix quote/list).
// Fenced code dilacak: baris lazy TIDAK boleh melanjutkan fenced code
// (hanya paragraf), jadi quote berakhir bila baris lazy ditemui di dalam fence.
// qlazy[i] = true bila qlines[i] berasal dari baris LAZY (tanpa '>');
// renderBlocks memakai info ini untuk strip 4 kolom ala token indented-code
// marked — strip dilakukan saat teks paragraf digabung, BUKAN di sini,
// supaya teks hasil strip (mis. '- bar') tidak dibaca ulang sebagai list.
function collectQuote(lines, i, b) {
  const qlines = [];
  const qlazy = [];
  let j = i;
  let inPara = false;
  let paraLazy = false;
  let fence = null;
  while (j < b) {
    const line = lines[j];
    const info = indentInfo(line);
    if (info.cols < 4 && line.charCodeAt(info.pos) === 62) {
      // Strip '>' + satu spasi/tab opsional (berbasis kolom, tab aware).
      const stripped = stripQuotePrefix(line);
      const s = stripped === null ? '' : stripped;
      qlines.push(s);
      qlazy.push(false);
      if (fence) {
        if (isFenceClose(s, fence)) fence = null;
        inPara = false;
      } else {
        const fi = indentInfo(s);
        if (fi.cols < 4) {
          const f = fenceInfo(s, fi.pos);
          if (f) fence = f;
        }
        inPara = fence ? false : lineEndsInPara(s, inPara);
      }
      paraLazy = false;
      j++;
      continue;
    }
    // Baris kosong tanpa marker '>' mengakhiri quote.
    if (isBlankLine(line)) break;
    if (inPara && isLazyContinuationLine(line)) {
      // Lazy setext: underline setext yang lazy tidak boleh jadi heading;
      // gabung ke baris sebelumnya. Bila paragraf sudah punya baris lazy,
      // beri prefix 4 spasi (kecuali indent baris sudah >= 4).
      const li = indentInfo(line);
      if (setextLevel(line, li.pos) > 0) {
        const prev = qlines[qlines.length - 1];
        let merged = line;
        if (paraLazy && li.cols < 4) merged = '    ' + line.trimStart();
        qlines[qlines.length - 1] = prev + '\n' + merged;
        inPara = false;
        j++;
        continue;
      }
      qlines.push(line);
      qlazy.push(true);
      paraLazy = true;
      j++;
      continue;
    }
    break;
  }
  return { qlines, end: j, qlazy };
}

// Kumpulkan item-item list mulai di lines[i] (marker pertama sudah pasti).
// Mengembalikan {items: [{lines, trailingBlank, emptyItem, end}], end, loose}
// atau null bila bukan list. Murni (tanpa render). Marker item berikutnya
// boleh berindent 0-3 (tidak harus sama dengan listIndent); marker tipe
// berbeda mengakhiri list.
function collectListItems(lines, i, b, key) {
  const first = parseMarker(lines[i]);
  if (!first || first.typeKey !== key) return null;
  const listIndent = indentInfo(lines[i]).cols;
  const items = [];
  let loose = false;
  let j = i;
  while (j < b) {
    // Peek: lewati baris kosong, cek baris berikut. Baris kosong hanya
    // dikonsumsi bila ada item sejenis setelahnya (agar baris kosong akhir
    // tetap terlihat oleh pemeriksaan loose di luar). Hr mengakhiri list.
    let k = j;
    while (k < b && isBlankLine(lines[k])) k++;
    if (k >= b) break;
    const hk = indentInfo(lines[k]);
    if (hk.cols < 4 && isHrLine(lines[k], hk.pos)) break;
    const m = parseMarker(lines[k]);
    if (!m || m.typeKey !== key) break;
    if (k > j && items.length > 0) loose = true;
    j = k;
    // Kumpulkan satu item.
    const itemLines = [];
    let state = 'blank';
    let fence = null;
    // fenceHasContent: fence sudah punya >=1 baris konten berindent cukup.
    // Baris indent < contentIndent HANYA masuk fence bila flag ini true
    // (probe50: fence tanpa konten -> baris indent-0 mengakhiri item dan
    // fence kosong; fence ber-konten -> baris indent-0 ikut sebagai konten).
    let fenceHasContent = false;
    const classify = (s) => {
      if (isBlankLine(s)) return 'blank';
      if (fence) {
        const fi = indentInfo(s);
        if (fi.cols < 4) {
          const ch = s.charCodeAt(fi.pos);
          if (ch === fence.ch.charCodeAt(0)) {
            let k = fi.pos;
            while (k < s.length && s.charCodeAt(k) === ch) k++;
            if (k - fi.pos >= fence.len) {
              let rest = true;
              for (let q = k; q < s.length; q++) {
                const d = s.charCodeAt(q);
                if (d !== 32 && d !== 9) {
                  rest = false;
                  break;
                }
              }
              if (rest) {
                fence = null;
                return 'other';
              }
            }
          }
        }
        return 'fence';
      }
      const fi = indentInfo(s);
      if (fi.cols >= 4) return 'para';
      const p = fi.pos;
      if (p >= s.length) return 'blank';
      const c = s.charCodeAt(p);
      if (c === 96 || c === 126) {
        const f = fenceInfo(s, p);
        if (f) {
          fence = f;
          return 'fence';
        }
      }
      if (c === 35 && atxInfo(s, p)) return 'other';
      if (isHrLine(s, p)) return 'other';
      if (c === 60) {
        const t = htmlBlockType(s, p);
        if (t >= 1 && t <= 6) return 'other';
      }
      // Quote / list: berakhir di paragraf bila baris terdalamnya paragraf
      // (mis. '> Blockquote' berisi paragraf -> lazy continuation boleh).
      if (c === 62) return lineEndsInPara(s, state === 'para') ? 'para' : 'other';
      if (parseMarker(s)) return lineEndsInPara(s, state === 'para') ? 'para' : 'other';
      if (setextLevel(s, p) > 0) return 'other';
      if (isTableDelimiter(s, p)) return 'other';
      return 'para';
    };
    const emptyItem = m.empty;
    if (emptyItem) {
      itemLines.push('');
      state = 'blank';
    } else {
      const firstLine = stripContainer(lines[j], m.contentIndent);
      itemLines.push(firstLine);
      state = classify(firstLine);
    }
    j++;
    let blankRun = 0;
    while (j < b) {
      const line = lines[j];
      if (isBlankLine(line)) {
        // Item kosong langsung ditutup baris kosong (baris berikut bukan
        // bagian item, meski berindent cukup).
        if (emptyItem) break;
        itemLines.push('');
        blankRun++;
        state = 'blank';
        // Baris kosong di dalam fence adalah konten fence.
        if (fence) fenceHasContent = true;
        j++;
        continue;
      }
      const li = indentInfo(line);
      if (li.cols >= m.contentIndent) {
        blankRun = 0;
        const stripped = stripContainer(line, m.contentIndent);
        itemLines.push(stripped);
        const wasFence = fence !== null;
        state = classify(stripped);
        if (wasFence && state === 'fence') fenceHasContent = true;
        else if (state !== 'fence') fenceHasContent = false;
        j++;
        continue;
      }
      // Indent < contentIndent: hr mengalahkan item, lalu marker apa pun
      // (tipe berbeda) mengakhiri list.
      if (li.cols < 4 && isHrLine(line, li.pos)) break;
      if (parseMarker(line)) break;
      // Di dalam fenced code yang SUDAH punya konten: baris konten (termasuk
      // yang indent-nya < contentIndent) tetap bagian item, ditambahkan
      // mentah (tanpa strip contentIndent). Bila fence belum punya konten,
      // baris ini mengakhiri item (fence jadi kosong).
      if (state === 'fence' && fenceHasContent) {
        itemLines.push(line);
        state = classify(line);
        j++;
        continue;
      }
      if (state === 'para' && blankRun === 0 && isLazyContinuationLine(line)) {
        // Lazy setext: gabung ke baris item sebelumnya TANPA prefix.
        if (setextLevel(line, li.pos) > 0) {
          itemLines[itemLines.length - 1] += '\n' + line;
          j++;
          continue;
        }
        itemLines.push(line);
        state = 'para';
        j++;
        continue;
      }
      break;
    }
    // Buang baris kosong di akhir item.
    let trailingBlank = 0;
    while (itemLines.length > 0 && isBlankLine(itemLines[itemLines.length - 1])) {
      itemLines.pop();
      trailingBlank++;
    }
    // Loose bila ada baris kosong antara item ini dan item berikutnya.
    // (Untuk item kosong, blank sintetis '' tidak dihitung; baris kosong
    // nyata setelahnya ditangani loop skip-blank di atas.)
    if (trailingBlank > 0 && !emptyItem) {
      const m3 = parseMarker(lines[j]);
      if (m3 && m3.typeKey === key) loose = true;
    }
    items.push({ lines: itemLines, trailingBlank, emptyItem, end: j });
  }
  if (items.length === 0) return null;
  return { items, end: j, loose };
}

// Apakah ada baris kosong di antara dua blok di dalam item list ini?
// Simulasi block parser: lewati blok demi blok; bila ada baris kosong di
// antara dua blok (bukan di awal/akhir), kembalikan true. Ref-def DIHITUNG
// sebagai blok (baris kosong di antara paragraf dan ref-def membuat loose).
// Baris kosong di DALAM sublist tidak membuat list luar loose.
function itemHasBlankBetweenBlocks(lines) {
  const b = lines.length;
  let i = 0;
  let seenBlock = false;
  let seenBlank = false;
  while (i < b) {
    if (isBlankLine(lines[i])) {
      seenBlank = true;
      i++;
      continue;
    }
    const info = indentInfo(lines[i]);
    const pos = info.pos;
    // Ref-def: sebuah blok (konsumsi baris-barisnya).
    if (info.cols < 4) {
      const def = tryRefDef(lines, i, b);
      if (def) {
        if (seenBlank && seenBlock) return true;
        seenBlank = false;
        seenBlock = true;
        i = def.end;
        continue;
      }
    }
    // Awal blok baru setelah baris kosong (dan sudah ada blok sebelumnya).
    if (seenBlank && seenBlock) return true;
    seenBlank = false;
    // Lewati blok ini.
    let end;
    if (info.cols < 4 && atxInfo(lines[i], pos)) end = i + 1;
    else if (info.cols < 4 && fenceInfo(lines[i], pos)) end = skipFence(lines, i, b, fenceInfo(lines[i], pos));
    else if (info.cols >= 4) end = skipIndentedCode(lines, i, b);
    else if (info.cols < 4 && htmlBlockType(lines[i], pos) > 0) end = skipHtmlBlock(lines, i, b, htmlBlockType(lines[i], pos));
    else if (info.cols < 4 && isHrLine(lines[i], pos)) end = i + 1;
    else if (info.cols < 4 && lines[i].charCodeAt(pos) === 62) end = collectQuote(lines, i, b).end;
    else if (info.cols < 4 && parseMarker(lines[i])) {
      const lst = collectListItems(lines, i, b, parseMarker(lines[i]).typeKey);
      end = lst ? lst.end : i + 1;
    } else end = scanParagraphEnd(lines, i, b, true);
    // Mundur melewati baris kosong akhir yang dikonsumsi blok (mis. trailing
    // blank item sublist): baris kosong itu pemisah bagi item luar.
    while (end > i && isBlankLine(lines[end - 1])) end--;
    seenBlock = true;
    i = end;
  }
  return false;
}

function parseList(lines, i, b, refs) {
  const first = parseMarker(lines[i]);
  if (!first) return null;
  const key = first.typeKey;
  const coll = collectListItems(lines, i, b, key);
  if (!coll) return null;
  let loose = coll.loose;
  // Loose struktural: ada baris kosong di antara dua blok di dalam item.
  for (const item of coll.items) {
    if (itemHasBlankBetweenBlocks(item.lines)) {
      loose = true;
      break;
    }
  }
  const ordered = first.ordered;
  let html = ordered
    ? '<ol' + (first.start !== 1 ? ' start="' + first.start + '"' : '') + '>\n'
    : '<ul>\n';
  for (const item of coll.items) {
    let taskPrefix = null;
    const itemLines = item.lines;
    if (itemLines.length > 0) {
      const firstLine = itemLines[0];
      const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(firstLine);
      if (tm && firstBlockIsParagraph(itemLines, refs)) {
        const checked = tm[1] === 'x' || tm[1] === 'X';
        taskPrefix = checked
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">';
        itemLines[0] = firstLine.slice(tm[0].length);
      }
    }
    // Konten item dirender sebagai sub-dokumen tanpa trailing newline
    // (trailingNL=false); newline sebelum </li> dipertahankan apa adanya.
    const content = renderBlocks(itemLines, 0, itemLines.length, refs, !loose, taskPrefix, true, false, true);
    html += '<li>' + content + '</li>\n';
  }
  html += ordered ? '</ol>\n' : '</ul>\n';
  return { html, end: coll.end };
}

function firstBlockIsParagraph(itemLines, refs) {
  if (itemLines.length === 0) return false;
  const line = itemLines[0];
  if (isBlankLine(line)) return false;
  const info = indentInfo(line);
  if (info.cols >= 4) return false;
  if (tryRefDef(itemLines, 0, itemLines.length)) return false;
  const pos = info.pos;
  const c = line.charCodeAt(pos);
  if (c === 35 && atxInfo(line, pos)) return false;
  if ((c === 96 || c === 126) && fenceInfo(line, pos)) return false;
  if (isHrLine(line, pos)) return false;
  if (c === 60) {
    const t = htmlBlockType(line, pos);
    if (t >= 1 && t <= 6) return false;
  }
  if (c === 62) return false;
  if (parseMarker(line)) return false;
  return true;
}

export function parse(markdown) {
  // Reset state "di dalam link" (quirk marked: tag <a ... /> self-closing
  // di dalam paragraf menekan autolink GFM di semua paragraf berikutnya
  // sampai ada </a> inline; direset tiap panggilan parse).
  suppressAutolink = false;
  const s = String(markdown);
  const trailingNL = s.endsWith('\n') || s.endsWith('\r');
  const lines = s.split(/\r\n|\n|\r/);
  // Buang TEPAT SATU elemen '' terakhir bila input berakhir line-ending.
  if (trailingNL && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  // Kumpulkan SEMUA definisi referensi dulu (forward reference berlaku).
  scanRefs(lines, 0, lines.length, refs);
  return renderBlocks(lines, 0, lines.length, refs, false, null, false, trailingNL, false);
}
