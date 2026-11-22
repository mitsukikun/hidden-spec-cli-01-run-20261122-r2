// mend — one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files, in four formats:
// unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A
// patches, and JSON text-editor tool calls. One written specification (SPEC.md)
// decides everything: the exit code, the lines on stdout, and every file
// afterwards. Every file is changed or none.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   PATCH is read from the file named, or from stdin when absent or `-`.
//   --format=NAME reads one format (unified, search-replace, v4a, json);
//   auto (the default) detects it. --check changes nothing. --strict matches
//   lines exactly (tier 0 only).
//
// Node 22 and its standard library alone: no install, no network, no clock,
// no randomness — the same check gives the same answer every run.
//
// In a trial the grader sets MAKEFUN_ENV_URL and this file hands over to
// runner.ts (the last lines below); keep that hand-over and runner.ts as they
// are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse failure: exit 2 with this one line, nothing else. */
class ParseError {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: exit 1 reports `error: <code> <path>` for it. */
class EditFailure {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and the
 * empty piece after a final \n dropped. Line numbers count these from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 * and none of its /-separated segments is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- Files: lines and line breaks (SPEC.md section 3). ----

interface SplitFile {
  /** The file's line break: CRLF when its first line feed follows \r. */
  br: string;
  lines: string[];
  /** Whether the text ends with that break (the last empty piece is no line). */
  finalBreak: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function joinFile(f: SplitFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---- Matching lines at three tiers (SPEC.md section 5). ----

const trimRight = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function linesEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRight(a) === trimRight(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at
 * `tier` (occurrences may overlap). */
function findOccurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  const k = O.length;
  if (k === 0) return found;
  for (let i = from; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!linesEqual(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (0, or 0..2 unless strict) at which O occurs at or after
 * `from`, with all its positions there; null when it occurs at no tier. */
function findAtTier(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = findOccurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of the replacement N: a context line names its index in O (it is
 * written as the file's own matched line), any other line is new text. */
interface NewLine {
  text: string;
  contextIndex: number | null;
}

/** Replace the O.length lines at `at` by N. At tier 2 every other line of N
 * that is not empty or only whitespace and starts with the leading whitespace
 * of O's first line has that prefix replaced by the leading whitespace of the
 * file's first matched line; at tiers 0 and 1 the lines of N are written as
 * they are. */
function spliceReplacement(lines: string[], at: number, O: string[], N: NewLine[], tier: number): string[] {
  const fileIndent = leadingWS(lines[at] ?? '');
  const patchIndent = leadingWS(O[0] ?? '');
  const replacement: string[] = [];
  for (const nl of N) {
    if (nl.contextIndex !== null) {
      replacement.push(lines[at + nl.contextIndex]!);
      continue;
    }
    let s = nl.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(patchIndent)) s = fileIndent + s.slice(patchIndent.length);
    replacement.push(s);
  }
  return lines.slice(0, at).concat(replacement, lines.slice(at + O.length));
}

// ---- The tree as the edits leave it. ----

/** `now` holds every path an edit touched (null: deleted); anything else is
 * read from disk on demand, and `original` remembers what it was before the
 * patch so the output can say what changed. `moves` records the move edits
 * that succeeded, for the R lines. */
class Tree {
  private readonly before = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** One parsed edit, applied to the tree; it throws EditFailure when it fails
 * and ParseError only while the patch is still being read. */
type Edit = (tree: Tree) => void;

/** With --format=auto the format is the first of these that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC.md section 9). ----

/** One JSON edit object, or null when the value is not one. A wrong command
 * or a missing or mistyped key is a parse fault, reported by the caller. */
function parseJsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const existing = (tree: Tree): string => {
    if (!isSafe(p)) throw new EditFailure('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.now.set(p, text);
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLF = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLF(before);
      const old = toLF(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLF(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new EditFailure('no-match', p);
      f.lines.splice(line, 0, ...added);
      tree.now.set(p, joinFile(f));
    };
  }

  return null;
}

/** The patch is either one JSON array of edit objects, or JSON Lines: one
 * edit object a line, blank lines ignored. In array form any fault is
 * `error: parse <the line where the array starts>`; in JSON Lines form a line
 * that does not hold one valid edit object is `error: parse <that line>`. */
function parseJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseError(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = parseJsonEdit(x);
      if (e === null) throw new ParseError(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = parseJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6). ----

interface HunkLine {
  kind: ' ' | '-' | '+';
  text: string;
  /** A `\` line (as in `\ No newline at end of file`) followed this line. */
  noEol: boolean;
}

interface Hunk {
  /** A: the 1-based start line of the hunk in the old file (B and D unused). */
  a: number;
  body: HunkLine[];
}

interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  /** Whether a ---/+++ pair named the paths (else diff --git or rename did). */
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  /** A +++ line on its own in the header names the new path. */
  lonePlus: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A --- or +++ path: the text after the four characters, up to the first
 * tab, surrounding spaces removed, a leading a/ or b/ removed; /dev/null
 * means no file. */
function diffPath(l: string): string | null {
  let p = l.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Read a hunk body starting at `i` (the line after the @@ header); returns
 * the index after it. Empty lines at the end of a body are not part of it. */
function readHunkBody(lines: string[], i: number, hunk: Hunk): number {
  const n = lines.length;
  const raw: string[] = [];
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      i++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  for (const l of raw) {
    if (l.startsWith('\\')) {
      const last = hunk.body[hunk.body.length - 1];
      if (last !== undefined) last.noEol = true;
      continue;
    }
    if (l === '') {
      hunk.body.push({ kind: ' ', text: '', noEol: false });
      continue;
    }
    hunk.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1), noEol: false });
  }
  return i;
}

/** Read a section's header and hunks starting at `i`; returns the index
 * after it (the start of the next section, or the end of the patch). */
function readDiffSection(lines: string[], i: number, sec: DiffSection): number {
  const n = lines.length;
  let inHeader = true;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('@@')) {
      const m = HUNK_HEADER.exec(l);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      inHeader = false;
      i++;
      i = readHunkBody(lines, i, hunk);
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!sec.hasPair) {
            sec.oldPath = diffPath(l);
            sec.newPath = diffPath(lines[i + 1]!);
            sec.hasPair = true;
            i += 2;
            continue;
          }
          return i;
        }
        throw new ParseError(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        sec.lonePlus = diffPath(l);
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    i++;
  }
  return i;
}

function parseUnifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new ParseError(`error: parse ${i + 1}`);
      const sec: DiffSection = { oldPath: m[1]!, newPath: m[2]!, hasPair: false, renameFrom: null, renameTo: null, lonePlus: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i++;
      i = readDiffSection(lines, i, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: DiffSection = { oldPath: diffPath(l), newPath: diffPath(lines[i + 1]!), hasPair: true, renameFrom: null, renameTo: null, lonePlus: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i += 2;
      i = readDiffSection(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new ParseError(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new ParseError('error: parse 1');
  return sections.map((s) => diffSectionEdit(s, strict));
}

/** Whether a `\` line follows the hunk's last context or + line. */
function hunkHasNoEol(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === ' ' || b.kind === '+') return b.noEol;
  }
  return false;
}

/** O (context and - lines) and N (context and + lines) of a hunk, in body order. */
function hunkOldNew(h: Hunk): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, contextIndex: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else {
      N.push({ text: b.text, contextIndex: null });
    }
  }
  return { O, N };
}

/** Apply a section's hunks in order, each to the result of the ones before
 * it. `d` is the running sum of (N length minus O length) over the hunks
 * applied so far: a hunk with O takes the occurrence nearest to A - 1 + d (the
 * earlier of two equally near); a hunk with an empty O inserts after the first
 * A + d lines. A `\` line decides the final line break when the matched lines
 * run to the end of the file. */
function applyHunks(hunks: Hunk[], before: string, strict: boolean, path: string): string {
  const f = splitFile(before);
  let lines = f.lines;
  let finalBreak = f.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkOldNew(h);
    if (O.length === 0) {
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > lines.length) idx = lines.length;
      const atEnd = idx === lines.length;
      lines = lines.slice(0, idx).concat(N.map((x) => x.text), lines.slice(idx));
      if (atEnd) finalBreak = !hunkHasNoEol(h);
      d += N.length;
    } else {
      const found = findAtTier(O, lines, strict);
      if (found === null) throw new EditFailure('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const touchesEnd = best + O.length === lines.length;
      lines = spliceReplacement(lines, best, O, N, found.tier);
      if (touchesEnd) finalBreak = !hunkHasNoEol(h);
      d += N.length - O.length;
    }
  }
  return joinFile({ br: f.br, lines, finalBreak });
}

/** One section is one edit: a creation, a deletion, a move, or a change of
 * the one path. Any failure of a hunk fails the section with that hunk's code,
 * and the section changes nothing. */
function diffSectionEdit(sec: DiffSection, strict: boolean): Edit {
  let oldP = sec.oldPath;
  let newP = sec.newPath;
  if (!sec.hasPair && sec.renameFrom !== null && sec.renameTo !== null) {
    oldP = sec.renameFrom;
    newP = sec.renameTo;
  }
  if (sec.lonePlus !== null) newP = sec.lonePlus;
  const isCreate = oldP === null || sec.isCreate;
  const isDelete = newP === null || sec.isDelete;
  return (tree) => {
    if (oldP !== null && !isSafe(oldP)) throw new EditFailure('unsafe', oldP);
    if (newP !== null && !isSafe(newP)) throw new EditFailure('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const plus: string[] = [];
      let lastPlus: HunkLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlus = b;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlus !== null && lastPlus.noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new EditFailure('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new EditFailure('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const text = applyHunks(sec.hunks, before, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    const before = tree.get(p);
    if (before === null) throw new EditFailure('missing', p);
    tree.now.set(p, applyHunks(sec.hunks, before, strict, p));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7). ----

function parseSearchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's >>>>>>> REPLACE line (or the start of the patch), that
    // is not blank and does not start with three backticks; with none, the
    // block takes the previous block's path.
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new ParseError(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseError(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p: string, oldL: string[], newL: string[]): Edit => {
      return (tree) => {
        if (!isSafe(p)) throw new EditFailure('unsafe', p);
        if (oldL.length === 0) {
          if (tree.get(p) !== null) throw new EditFailure('exists', p);
          tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
          return;
        }
        const before = tree.get(p);
        if (before === null) throw new EditFailure('missing', p);
        const f = splitFile(before);
        const found = findAtTier(oldL, f.lines, strict);
        if (found === null) throw new EditFailure('no-match', p);
        if (found.pos.length > 1) throw new EditFailure('ambiguous', p);
        const N: NewLine[] = newL.map((t) => ({ text: t, contextIndex: null }));
        tree.now.set(p, joinFile({ br: f.br, lines: spliceReplacement(f.lines, found.pos[0]!, oldL, N, found.tier), finalBreak: f.finalBreak }));
      };
    })(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError('error: parse 1');
  return edits;
}

// ---- V4A patches (SPEC.md section 8). ----

interface V4aChunk {
  anchor: string;
  endOfFile: boolean;
  body: string[];
}

interface RawLine {
  text: string;
  no: number;
}

function parseV4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseError(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseError(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'delete' : 'update';
      const startLine = i + 1;
      const path = l.slice(kind === 'add' ? 14 : 17).trim();
      const raw: RawLine[] = [];
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
        raw.push({ text: m, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
      edits.push(v4aSectionEdit(kind, path, startLine, raw, strict));
      continue;
    }
    throw new ParseError(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new ParseError('error: parse 1');
  return edits;
}

function v4aSectionEdit(kind: string, path: string, startLine: number, raw: RawLine[], strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new ParseError(`error: parse ${r.no}`);
    }
    return (tree) => {
      if (!isSafe(path)) throw new EditFailure('unsafe', path);
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const r of raw) {
      if (!isBlank(r.text)) throw new ParseError(`error: parse ${r.no}`);
    }
    return (tree) => {
      if (!isSafe(path)) throw new EditFailure('unsafe', path);
      if (tree.get(path) === null) throw new EditFailure('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update: an optional `*** Move to:` first line, then chunks. A chunk
  // starts at an @@ line (the text after @@ is its anchor; empty is no
  // anchor) or, for the first chunk, at a body line. `*** End of File` ends a
  // chunk and anchors it to the end of the file.
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(13).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let firstChunk = true;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const l = r.text;
    if (l === '*** End of File') {
      if (cur === null) throw new ParseError(`error: parse ${r.no}`);
      cur.endOfFile = true;
      cur = null;
      firstChunk = false;
      continue;
    }
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), endOfFile: false, body: [] };
      chunks.push(cur);
      firstChunk = false;
      continue;
    }
    if (l.startsWith('***')) throw new ParseError(`error: parse ${r.no}`);
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (!firstChunk) throw new ParseError(`error: parse ${r.no}`);
        cur = { anchor: '', endOfFile: false, body: [] };
        chunks.push(cur);
        firstChunk = false;
      }
      cur.body.push(l);
      continue;
    }
    throw new ParseError(`error: parse ${r.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseError(`error: parse ${startLine}`);
  return (tree) => {
    if (!isSafe(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFailure('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
    const f = splitFile(before);
    const out = applyV4aChunks(f.lines, chunks, strict, path);
    const text = joinFile({ br: f.br, lines: out, finalBreak: f.finalBreak });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

/** O (context and - lines) and N (context and + lines) of a V4A chunk. */
function chunkOldNew(chunk: V4aChunk): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const l of chunk.body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      O.push(t);
      N.push({ text: t, contextIndex: O.length - 1 });
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else {
      N.push({ text: l.slice(1), contextIndex: null });
    }
  }
  return { O, N };
}

/** Apply a section's chunks in order, with a cursor that starts at line 0. A
 * chunk with an anchor first finds the first line at or after the cursor equal
 * to the anchor at the first tier where one is, and the cursor moves past it.
 * The chunk takes the first occurrence of O at or after the cursor, at the
 * first tier with one; an end-of-file chunk takes only an occurrence that ends
 * at the file's last line. With an empty O, N is inserted at the cursor, or at
 * the end of the file for an end-of-file chunk. The cursor then moves to just
 * after the lines written. */
function applyV4aChunks(start: string[], chunks: V4aChunk[], strict: boolean, path: string): string[] {
  let lines = start.slice();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== '') {
      let foundIdx = -1;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top && foundIdx < 0; t++) {
        for (let k = cursor; k < lines.length; k++) {
          if (linesEqual(chunk.anchor, lines[k]!, t)) {
            foundIdx = k;
            break;
          }
        }
      }
      if (foundIdx < 0) throw new EditFailure('no-match', path);
      cursor = foundIdx + 1;
    }
    const { O, N } = chunkOldNew(chunk);
    if (O.length === 0) {
      const at = chunk.endOfFile ? lines.length : cursor;
      lines = lines.slice(0, at).concat(N.map((x) => x.text), lines.slice(at));
      cursor = at + N.length;
    } else {
      let found: { tier: number; at: number } | null = null;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top && found === null; t++) {
        const pos = findOccurrences(O, lines, t, cursor);
        const ok = chunk.endOfFile ? pos.filter((p) => p + O.length === lines.length) : pos;
        if (ok.length > 0) found = { tier: t, at: ok[0]! };
      }
      if (found === null) throw new EditFailure('no-match', path);
      lines = spliceReplacement(lines, found.at, O, N, found.tier);
      cursor = found.at + N.length;
    }
  }
  return lines;
}

// ---- Invocation, output and exit codes, order and atomicity (sections 1, 2, 10). ----

/** Compare two paths in byte order (UTF-8). */
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(argv: string[]): { code: number; out: string[] } {
  // Parse the arguments. A usage error is any of: an argument that starts
  // with - and is not - and not one of the options (before --), an option
  // given twice, a --format value other than the five names, or more than one
  // positional argument. -- ends the options.
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && KNOWN_FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const file = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplaceEdits(lines, strict);
    else edits = parseV4aEdits(lines, strict);
    if (edits.length === 0) throw new ParseError('error: parse 1');
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [e.line] };
    throw e;
  }

  // Edits apply in the patch's order to the tree as earlier edits left it. A
  // failed edit changes nothing, and the edits after it still run, so every
  // failure is reported. When any edit failed, no file is written.
  const tree = new Tree();
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return { code: 1, out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`] };
  }

  // One line for each path whose state changed, in byte order of the paths.
  // A move edit whose old path existed before the patch and does not after
  // it, and whose new path did not exist before it and does after it, is one
  // `R <old> -> <new>` line that replaces that pair's D and A lines and sorts
  // by the new path. A file whose bytes after the patch are its bytes before
  // it is not listed.
  const moved = tree.moves.filter(([o, n]) => tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null);
  const movedOld = new Set(moved.map(([o]) => o));
  const movedNew = new Set(moved.map(([, n]) => n));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of moved) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => byteOrder(a.key, b.key));

  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
