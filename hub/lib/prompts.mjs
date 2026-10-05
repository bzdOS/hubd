/* Meta-prompts: a role's rules rendered from one shared template instead of kept as copies.
 *
 * Before this the rules of every role lived as copies: the protocol in one file, the fleet
 * prose glued together by a script, prompt lines hard-coded in a loop script, two 32 KB copies
 * of a head's canon per head. A rule fixed in one copy stayed wrong in the others. Now there is
 * one template per kind of role (prompts/meta/<name>.md), shared fragments
 * (prompts/meta/fragments/<name>.md), and everything specific to one role comes in as a
 * variable. See prompts/meta/README.md for the format.
 *
 * A variable that is missing or blank is an error naming it, never an empty string: an empty
 * line in a role's rules drops a fact silently, and the role cannot tell that it was there. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const META_DIR = fileURLToPath(new URL('../../prompts/meta/', import.meta.url));
export const MAX_DEPTH = 3;

const NAME = /^[\w-]+$/;
const TOKEN = /\{\{(?:>\s*([\w-]+)|\s*([a-z_]+))\s*\}\}/g;   // {{> fragment}} | {{variable}}
const DECL = /^<!--\s*vars:([\s\S]*?)-->/;
const NOTE = /^<!--[\s\S]*?-->\n/gm;                         // a comment that starts a line: notes for authors

export function templateNames(dir = META_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch {}
  return files.filter(f => f.endsWith('.md') && f !== 'README.md').map(f => f.slice(0, -3)).sort();
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/* The variables a template declares on its first line, in their order. */
export function templateVars(name, dir = META_DIR) {
  const file = path.join(dir, name + '.md');
  if (!NAME.test(String(name)) || !fs.existsSync(file))
    throw new Error(`no template "${name}" in ${dir} — have: ${templateNames(dir).join(', ') || '(none)'}`);
  const m = fs.readFileSync(file, 'utf8').match(DECL);
  if (!m) throw new Error(`${name}.md declares no variables: its first line must be <!-- vars: a, b, c -->`);
  const declared = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const bad = declared.filter(v => !/^[a-z_]+$/.test(v));
  if (bad.length) throw new Error(`${name}.md:1: not a variable name: ${bad.join(', ')} (lower case and _ only)`);
  return declared;
}

/* What prompts/meta/README.md says of each template and each variable, from its two tables. The
 * README is where an author documents a variable, so the MCP prompt list reads it there, and a
 * variable without a row goes out with no description. */
export function promptDocs(dir = META_DIR) {
  const templates = {}, vars = {};
  let md = '';
  try { md = fs.readFileSync(path.join(dir, 'README.md'), 'utf8'); } catch {}
  for (const l of md.split('\n')) {
    let m = l.match(/^\| \[([\w-]+)\.md\]\([^)]*\) \| (.+?) \|$/);
    if (m) { templates[m[1]] = m[2]; continue; }
    m = l.match(/^\| `([a-z_]+)` \| (.+?) \|$/);
    if (m) vars[m[1]] = m[2];
  }
  return { templates, vars };
}

/* The templates as MCP prompts: every declared variable is a required argument. */
export function promptList(dir = META_DIR) {
  const docs = promptDocs(dir);
  return templateNames(dir).map(name => ({
    name,
    description: `The rules a role runs by, rendered from this hubd's prompts/meta/${name}.md` + (docs.templates[name] ? ` — ${docs.templates[name]}.` : '.'),
    arguments: templateVars(name, dir).map(v => ({ name: v, ...(docs.vars[v] ? { description: docs.vars[v] } : {}), required: true })),
  }));
}

/* A render error carries `args` when the caller's variables are at fault (missing, blank, not
 * text), so the MCP server can answer "invalid params" there and "internal error" for a broken
 * template. */
const argError = (message, args) => Object.assign(new Error(message), { args });

export function renderPrompt(name, vars = {}, dir = META_DIR) {
  const declared = templateVars(name, dir);
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw argError('vars must be a JSON object', []);

  const known = new Set(declared), used = new Set(), unknown = [], missing = new Set();
  const value = (k) => {
    const v = vars[k];
    if (v !== undefined && v !== null && typeof v === 'object') throw argError(`variable ${k} must be text, not ${Array.isArray(v) ? 'a list' : 'an object'}`, [k]);
    const s = v === undefined || v === null ? '' : String(v);
    if (!s.trim()) { missing.add(k); return ''; }
    return s.replace(/^\n+|\n+$/g, '').trimEnd();
  };
  const expand = (rel, chain) => {
    let text = fs.readFileSync(path.join(dir, rel), 'utf8');
    // Notes go in a fragment as in a template: a rule nothing checks is marked as a wish next to it,
    // for authors, and the role never reads the mark.
    const cuts = [];   // [offset in the stripped text, lines removed there]: errors name the line in the file
    let shift = 0;
    text = text.replace(NOTE, (c, at) => { cuts.push([at - shift, c.split('\n').length - 1]); shift += c.length; return ''; });
    const lineOf = (off) => lineAt(text, off) + cuts.reduce((n, [o, k]) => n + (o <= off ? k : 0), 0);
    return text.replace(TOKEN, (tok, frag, v, offset) => {
      const at = `${rel}:${lineOf(offset)}`;
      if (v) {
        used.add(v);
        if (!known.has(v)) { unknown.push(`${v} (${at})`); return tok; }
        return value(v);
      }
      const trail = [...chain, frag].join(' > ');
      if (chain.includes(frag)) throw new Error(`include cycle: ${trail} (${at})`);
      if (chain.length > MAX_DEPTH) throw new Error(`includes nested deeper than ${MAX_DEPTH}: ${trail} (${at})`);
      const fragRel = path.join('fragments', frag + '.md');
      if (!fs.existsSync(path.join(dir, fragRel))) throw new Error(`no fragment "${frag}" (${fragRel}), included at ${at}`);
      return expand(fragRel, [...chain, frag]).replace(/\n+$/, '');
    });
  };
  const out = expand(name + '.md', [name]);
  const errors = [];
  if (unknown.length) errors.push('unknown variable' + (unknown.length > 1 ? 's' : '') + ': ' + unknown.join(', ') + ` — not in ${name}.md's <!-- vars: -->`);
  const unused = declared.filter(v => !used.has(v));
  if (unused.length) errors.push(`declared in ${name}.md but never used: ${unused.join(', ')}`);
  if (missing.size) errors.push(`missing or blank variable${missing.size > 1 ? 's' : ''} for ${name}: ${[...missing].join(', ')}`);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), missing.size ? { args: [...missing] } : {});
  return out;
}

/* What --check prints when a rendered file has drifted: the lines only the file has (-) and the
 * lines only the render has (+), numbered in their own text. A longest-common-subsequence walk;
 * rules files run to a few hundred lines. */
export function lineDiff(have, want) {
  const A = have.split('\n'), B = want.split('\n'), n = A.length, k = B.length;
  if (n * k > 4e6) return [`(${n} lines against ${k}: too long to diff here)`];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = k - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < n || j < k;) {
    if (i < n && j < k && A[i] === B[j]) { i++; j++; }
    else if (j < k && (i === n || L[i][j + 1] >= L[i + 1][j])) out.push(`+${j + 1}: ${B[j++]}`);
    else out.push(`-${i + 1}: ${A[i++]}`);
  }
  return out;
}
