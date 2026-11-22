// mend: one patch tool for every AI edit format.
//
// Applies edits written by AI models to a tree of text files, in all four
// formats models use (unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON edits), to the specification in SPEC.md: every file is changed or
// none. Node 22, the standard library alone; run as
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* A file as lines: its own line break, its lines, and whether it ends */
/* with one. Splitting and joining are exact inverses, so a file an    */
/* edit leaves alone comes back byte for byte.                         */
/* ------------------------------------------------------------------ */

interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The leading spaces and tabs of a line. */
function leadWS(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

/** A line with its trailing spaces and tabs removed. */
function trailWS(s: string): string {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(0, e);
}

/** A line with its leading and trailing spaces and tabs removed. */
function stripWS(s: string): string {
  return trailWS(s.slice(leadWS(s).length));
}

/** One line against another at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWS(a) === trailWS(b);
  return stripWS(a) === stripWS(b);
}

/** Every 0-based start at or after `from` where `pat` occurs in `lines` at `tier`. */
function occurrencesAt(lines: string[], pat: string[], from: number, tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j], pat[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which `pat` occurs at or after `from`. */
function findTier(lines: string[], pat: string[], from: number, strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(lines, pat, from, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** A line of the new text, re-indented at tier 2 (SPEC.md section 5). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

/**
 * The lines a replacement writes. `o` is the old lines; each entry of `n`
 * is a new line, and one with ctx >= 0 is a context line, written as the
 * file's own matched line (the ctx-th line of the occurrence); the rest are
 * written as they are, re-indented at tier 2.
 */
function buildNew(o: string[], n: Array<{ text: string; ctx: number }>, fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const p = tier === 2 && o.length > 0 ? leadWS(o[0]) : '';
  const f = tier === 2 && o.length > 0 ? leadWS(fileLines[pos]) : '';
  for (const e of n) {
    if (e.ctx >= 0) out.push(fileLines[pos + e.ctx]);
    else out.push(tier === 2 ? reindent(e.text, p, f) : e.text);
  }
  return out;
}

/** Split a hunk or chunk body into its old lines and its new lines. */
function hunkParts(body: string[]): { o: string[]; n: Array<{ text: string; ctx: number }> } {
  const o: string[] = [];
  const n: Array<{ text: string; ctx: number }> = [];
  for (const b of body) {
    if (b.startsWith(' ') || b === '') {
      const t = b === '' ? '' : b.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctx: -1 });
    }
    // A `\` line is a marker for the line before it; it carries no text.
  }
  return { o, n };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6). A hunk carries the a/b line    */
/* counts it declares; the counts choose a file the same size, the    */
/* nearest occurrence is a convenience for a model that wrote the      */
/* counts with an old copy, and the hunk header never edits text.     */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  b: number;
  body: string[];
}
interface Section {
  old: string;
  next: string;
  hunks: Hunk[];
  binary: boolean;
  newFile: boolean;
  delFile: boolean;
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function cleanPath(t: string): string {
  let s = t.split('\t')[0]!.trim();
  if (s === '/dev/null') return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      s = JSON.parse(s) as string;
    } catch {
      // Leave the quotes; an unknown path is refused as unsafe or missing.
    }
  }
  s = s.replace(/^\.\//, '');
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function noBreakMarker(body: string[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    const b = body[j];
    if (b.startsWith(' ') || b === '' || b.startsWith('+')) last = j;
  }
  if (last < 0) return false;
  return last + 1 < body.length && body[last + 1].startsWith('\\');
}

/** The text a hunk writes for a file that does not exist yet (SPEC.md section 6): its `+` lines only. */
function creationText(hunks: Hunk[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    for (const b of h.body) {
      if (b.startsWith('+')) out.push(b.slice(1));
    }
  }
  if (out.length === 0) return '';
  // The file ends with a line break unless a `\` line follows its last `+` line.
  let final = true;
  outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let j = body.length - 1; j >= 0; j--) {
      if (body[j]!.startsWith('+')) {
        final = !(j + 1 < body.length && body[j + 1]!.startsWith('\\'));
        break outer;
      }
    }
  }
  return out.join('\n') + (final ? '\n' : '');
}

/** Apply one hunk, keeping the hunk header's counts as a 0-based target line. */
function applyUnifiedHunk(st: { lines: string[]; final: boolean }, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const { o, n } = hunkParts(hunk.body);
  const lines = st.lines;
  if (o.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, lines.length));
    const ins = n.map((e) => e.text);
    const touchedEnd = at === lines.length;
    lines.splice(at, 0, ...ins);
    if (touchedEnd) st.final = !noBreakMarker(hunk.body);
    return d + n.length;
  }
  const found = findTier(lines, o, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.at[0]!;
  let bestDist = Math.abs(pos - target);
  for (const p of found.at) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      pos = p;
      bestDist = dist;
    }
  }
  const touchedEnd = pos + o.length === lines.length;
  const replacement = buildNew(o, n, lines, pos, found.tier);
  lines.splice(pos, o.length, ...replacement);
  if (touchedEnd) st.final = !noBreakMarker(hunk.body);
  return d + (n.length - o.length);
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const isCreation = s.newFile || (s.old === '' && s.next !== '');
    const isDeletion = !isCreation && (s.delFile || (s.next === '' && s.old !== ''));
    if (isCreation) {
      // Creation.
      if (!safe(s.next)) throw new Fail('unsafe', s.next);
      if (tree.get(s.next) !== null) throw new Fail('exists', s.next);
      tree.now.set(s.next, creationText(s.hunks));
      return;
    }
    if (isDeletion) {
      // Deletion: the old path exists, it is deleted, its hunks are not read.
      if (!safe(s.old)) throw new Fail('unsafe', s.old);
      if (tree.get(s.old) === null) throw new Fail('missing', s.old);
      tree.now.set(s.old, null);
      return;
    }
    if (s.old === s.next) {
      // An in-place edit, or a rename that does not rename.
      if (!safe(s.old)) throw new Fail('unsafe', s.old);
      const cur = tree.get(s.old);
      if (cur === null) throw new Fail('missing', s.old);
      if (s.hunks.length === 0) return;
      const sp = splitText(cur);
      const st = { lines: [...sp.lines], final: sp.final };
      let d = 0;
      for (const h of s.hunks) d = applyUnifiedHunk(st, h, d, strict, s.old);
      tree.now.set(s.old, joinText(st.lines, sp.br, st.final));
      return;
    }
    // Rename with hunks.
    if (!safe(s.old)) throw new Fail('unsafe', s.old);
    if (!safe(s.next)) throw new Fail('unsafe', s.next);
    const cur = tree.get(s.old);
    if (cur === null) throw new Fail('missing', s.old);
    if (tree.get(s.next) !== null) throw new Fail('exists', s.next);
    if (s.hunks.length === 0) {
      tree.now.set(s.old, null);
      tree.now.set(s.next, cur);
      tree.moves.push({ old: s.old, next: s.next });
      return;
    }
    const sp = splitText(cur);
    const st = { lines: [...sp.lines], final: sp.final };
    let d = 0;
    for (const h of s.hunks) d = applyUnifiedHunk(st, h, d, strict, s.old);
    tree.now.set(s.old, null);
    tree.now.set(s.next, joinText(st.lines, sp.br, st.final));
    tree.moves.push({ old: s.old, next: s.next });
  };
}

/** Parse a unified diff; the return is one edit per file section (SPEC.md section 6). */
/** Parse a unified diff; the return is one edit per file section (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const isHunkHeader = (l: string): boolean => l.startsWith('@@');
  const hunkNums = (l: string): { a: number; b: number } | null => {
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    return m === null ? null : { a: Number(m[1]), b: Number(m[2]) };
  };
  const isBodyLine = (b: string): boolean =>
    b.startsWith(' ') || b === '' || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\');
  /** A hunk's body: the lines after its header, ending at the first other line. */
  const readBody = (k: number): { body: string[]; next: number } => {
    const body: string[] = [];
    let j = k;
    while (j < n) {
      const b = lines[j]!;
      if (b.startsWith('diff --git ')) break;
      if (isHunkHeader(b)) break;
      if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (!isBodyLine(b)) break;
      body.push(b);
      j += 1;
    }
    // Blank lines at the end of a body are not part of it.
    while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
    return { body, next: j };
  };
  /** One section, starting at `i` (a `diff --git` line or a `--- ` line followed by `+++ `). */
  const parseSection = (i: number): number => {
    let old = '';
    let next = '';
    let newFile = false;
    let delFile = false;
    let binary = false;
    let hasDash = false;
    let j: number;
    if (lines[i]!.startsWith('diff --git ')) {
      const m = lines[i]!.match(/^diff --git a\/(\S+) b\/(\S+)(?:\s|$)/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      old = m[1]!;
      next = m[2]!;
      j = i + 1;
      // The header: lines before the first hunk.
      while (j < n && !isHunkHeader(lines[j]!) && !lines[j]!.startsWith('diff --git ')) {
        const h = lines[j]!;
        if (h.startsWith('--- ')) {
          if (!(lines[j + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${j + 2}`);
          if (!hasDash) {
            old = cleanPath(h.slice(4));
            next = cleanPath(lines[j + 1]!.slice(4));
            hasDash = true;
          }
          j += 2;
          continue;
        }
        if (h.startsWith('+++ ')) {
          if (!hasDash) next = cleanPath(h.slice(4));
          j += 1;
          continue;
        }
        if (h.startsWith('rename from ')) {
          if (!hasDash) old = h.slice('rename from '.length).trim();
          j += 1;
          continue;
        }
        if (h.startsWith('rename to ')) {
          if (!hasDash) next = h.slice('rename to '.length).trim();
          j += 1;
          continue;
        }
        if (h.startsWith('new file mode')) { newFile = true; j += 1; continue; }
        if (h.startsWith('deleted file mode')) { delFile = true; j += 1; continue; }
        if (h.startsWith('Binary files ')) { binary = true; j += 1; continue; }
        // `index`, `old mode`, `new mode`, `similarity index`, `Index:` and any other line are ignored.
        j += 1;
      }
    } else {
      // A bare `--- ` line followed by a `+++ ` line starts a section.
      old = cleanPath(lines[i]!.slice(4));
      next = cleanPath(lines[i + 1]!.slice(4));
      hasDash = true;
      j = i + 2;
    }
    const sec: Section = { old, next, hunks: [], binary, newFile, delFile };
    if (binary) {
      edits.push((tree) => {
        if (old === next || old === '' || next === '') throw new Fail('no-match', old || next || '');
        if (!safe(old)) throw new Fail('unsafe', old);
        if (!safe(next)) throw new Fail('unsafe', next);
        const cur = tree.get(old);
        if (cur === null) throw new Fail('missing', old);
        if (tree.get(next) !== null) throw new Fail('exists', next);
        tree.now.set(old, null);
        tree.now.set(next, cur);
        tree.moves.push({ old, next });
      });
      return j;
    }
    // The hunks, until a new section starts or the patch ends.
    while (j < n) {
      const h = lines[j]!;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (isHunkHeader(h)) {
        const nums = hunkNums(h);
        if (nums === null) throw new Exit2(`error: parse ${j + 1}`);
        const hunk: Hunk = { a: nums.a, b: nums.b, body: [] };
        const r = readBody(j + 1);
        hunk.body = r.body;
        sec.hunks.push(hunk);
        j = r.next;
        continue;
      }
      // Outside bodies, lines that are not part of a section header are ignored.
      j += 1;
    }
    if (old === '' && next === '' && !newFile && !delFile) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(unifiedEdit(sec, strict));
    return j;
  };
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) { i = parseSection(i); continue; }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) { i = parseSection(i); continue; }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    // Prose, code fences and any other line outside a section are ignored.
    i += 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7). A block has its path in */
/* a bare line above it, a SEARCH half and a REPLACE half, and no      */
/* hunk header; the old lines must be matched somewhere in the file.   */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // A REPLACE-only block creates the file with the new lines.
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const sp = splitText(cur);
    const lines = [...sp.lines];
    const found = findTier(lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const replacement = newLines.map((t) => ({ text: t, ctx: -1 }));
    const out = buildNew(oldLines, replacement, lines, pos, found.tier);
    lines.splice(pos, oldLines.length, ...out);
    tree.now.set(path, joinText(lines, sp.br, sp.final));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchNo}`);
    }
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8): `*** Begin Patch` to `*** End     */
/* Patch`, with Add, Delete and Update sections. An Update section has */
/* chunks: each `@@` moves the cursor to an anchor line, and an empty  */
/* chunk inserts at the cursor (or at the end after `*** End of File`). */
/* ------------------------------------------------------------------ */

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const sp = splitText(cur);
    const lines = [...sp.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundAt = -1;
        for (const t of tiers) {
          for (let j = cursor; j < lines.length; j++) {
            if (lineEq(lines[j]!, ch.anchor, t)) { foundAt = j; break; }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const { o, n } = hunkParts(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins = n.map((e) => e.text);
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let pos = -1;
      let tierUsed = 0;
      if (ch.eof) {
        const start = lines.length - o.length;
        if (start >= cursor) {
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            let ok = true;
            for (let j = 0; j < o.length; j++) {
              if (!lineEq(lines[start + j]!, o[j]!, t)) { ok = false; break; }
            }
            if (ok) { pos = start; tierUsed = t; break; }
          }
        }
        if (pos < 0) throw new Fail('no-match', path);
      } else {
        const found = findTier(lines, o, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        pos = found.at[0]!;
        tierUsed = found.tier;
      }
      const replacement = buildNew(o, n, lines, pos, tierUsed);
      lines.splice(pos, o.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const out = joinText(lines, sp.br, sp.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, next: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let lastNB = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) { lastNB = j; break; }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  let i = first + 1;
  const last = lastNB;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const content: string[] = [];
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (b.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (b.startsWith('+')) { content.push(b.slice(1)); i += 1; continue; }
        if (b === '') { content.push(''); i += 1; continue; }
        if (blank(b)) {
          // A whitespace-only line: trailing (ignored) or a parse error.
          let j = i;
          while (j < last && blank(lines[j]!)) j += 1;
          if (j >= last || isSectionStart(lines[j]!)) break;
          throw new Exit2(`error: parse ${i + 1}`);
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of the file.
      while (content.length > 0 && content[content.length - 1]!.trim() === '') content.pop();
      edits.push(v4aAddEdit(path, content));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(path));
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updateNo = i + 1;
      const path = l.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let endedByEof = false;
      const isBody = (b: string): boolean => b.startsWith(' ') || b === '' || b.startsWith('-') || b.startsWith('+');
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          endedByEof = true;
          i += 1;
          continue;
        }
        if (b.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (b.startsWith('@@')) {
          if (cur !== null) { chunks.push(cur); cur = null; }
          const anchor = b.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          endedByEof = false;
          i += 1;
          continue;
        }
        if (isBody(b)) {
          if (cur === null) {
            if (chunks.length === 0 && !endedByEof) {
              // A body line before the first `@@` starts the first chunk.
              cur = { anchor: null, eof: false, body: [] };
            } else if (blank(b)) {
              // A blank line after a chunk ended is a trailing blank.
              i += 1;
              continue;
            } else {
              throw new Exit2(`error: parse ${i + 1}`);
            }
          }
          cur.body.push(b);
          i += 1;
          continue;
        }
        if (blank(b)) { i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) { chunks.push(cur); cur = null; }
      // Blank lines at the end of a section are not part of the last chunk.
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        if (!lc.eof) {
          while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.trim() === '') lc.body.pop();
        }
      }
      // Drop chunks that hold nothing (no anchor, no body, not the end of file).
      const kept = chunks.filter((c) => c.anchor !== null || c.body.length > 0 || c.eof);
      if (kept.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, kept, strict));
      continue;
    }
    if (blank(l)) { i += 1; continue; }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the patch: read it, pick a format, parse, apply.            */
/* ------------------------------------------------------------------ */

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let file: string | null = null;
  let i = 0;
  let noMoreOptions = false;
  const seen = new Set<string>();
  const usage = (): { code: number; out: string[] } => ({ code: 2, out: ['error: usage'] });
  while (i < argv.length) {
    const a = argv[i]!;
    if (!noMoreOptions && a === '--') { noMoreOptions = true; i += 1; continue; }
    if (!noMoreOptions && a === '--check') {
      if (seen.has('check')) return usage();
      seen.add('check');
      check = true;
      i += 1;
      continue;
    }
    if (!noMoreOptions && a === '--strict') {
      if (seen.has('strict')) return usage();
      seen.add('strict');
      strict = true;
      i += 1;
      continue;
    }
    if (!noMoreOptions && a.startsWith('--format=')) {
      if (seen.has('format')) return usage();
      const f = a.slice('--format='.length);
      if (!FORMATS.includes(f)) return usage();
      seen.add('format');
      format = f;
      i += 1;
      continue;
    }
    if (!noMoreOptions && a.startsWith('-') && a !== '-') return usage();
    if (file !== null) return usage();
    file = a;
    i += 1;
  }
  let text: string;
  if (file !== null && file !== '-') {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  } else {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const tree = new Tree();
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const failures: Array<{ code: string; path: string }> = [];
  for (let j = 0; j < edits.length; j++) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edits[j]!(tree);
    } catch (e) {
      if (e instanceof Fail) {
        // A failed edit changes nothing; the edits after it still run.
        tree.now.clear();
        for (const [k, v] of before) tree.now.set(k, v);
        tree.moves.length = beforeMoves;
        failures.push({ code: e.code, path: e.path });
        continue;
      }
      throw e;
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }
  // Report each changed file once, sorted by path; a rename is one `R` row
  // (from the old path to the new one, sorted by the new path).
  const moved = new Map<string, { old: string; next: string }>();
  const movedOld = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNext = tree.original(m.next);
    const nowNext = tree.now.get(m.next);
    if (wasOld !== null && nowOld === null && wasNext === null && nowNext !== null) {
      moved.set(m.next, m);
      movedOld.add(m.old);
    }
  }
  const rows: string[] = [];
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (movedOld.has(p)) continue;
    if (moved.has(p)) {
      const m = moved.get(p)!;
      rows.push(`R ${m.old} -> ${p}`);
      continue;
    }
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // A trial: hand over to the runner, which runs main.ts on each check.
  await runTrial(envUrl);
} else {
  const res = run(process.argv.slice(2));
  for (const line of res.out) writeSync(1, line + '\n');
  process.exitCode = res.code;
}
