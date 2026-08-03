/**
 * Conservative CSS de-duplicator.
 *
 * `agents.css` accumulated repeated override blocks (same selector list declared
 * 4-5x). This merges duplicate rules **only where provably order-safe**, so the
 * computed cascade is unchanged.
 *
 * Safety rule: occurrence B may merge into earlier occurrence A only if no rule
 * strictly between them shares an exact selector with the key AND declares any
 * property B declares. Otherwise B is left in place.
 *
 * Verification: for every (exact selector, property) pair, the last-declared
 * value must be identical before and after. Cross-selector ordering is guarded
 * by the safety rule above.
 *
 * Usage: node scripts/dedupe-css.mjs <file> [--write]
 */
import fs from "node:fs";

const file = process.argv[2];
const write = process.argv.includes("--write");
if (!file) {
  console.error("usage: node scripts/dedupe-css.mjs <file> [--write]");
  process.exit(1);
}

const source = fs.readFileSync(file, "utf8");

/** Split CSS into top-level segments: plain rules and opaque at-rule blocks. */
function tokenize(css) {
  const out = [];
  let i = 0;
  let buf = "";

  const flushText = () => {
    if (buf.trim()) out.push({ type: "text", raw: buf });
    buf = "";
  };

  while (i < css.length) {
    // preserve comments verbatim
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      buf += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (css[i] === "@") {
      // at-rule: copy the whole balanced block through untouched
      let j = i;
      while (j < css.length && css[j] !== "{" && css[j] !== ";") j++;
      if (css[j] === ";") {
        buf += css.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      let depth = 1;
      let k = j + 1;
      while (k < css.length && depth > 0) {
        if (css[k] === "{") depth++;
        else if (css[k] === "}") depth--;
        k++;
      }
      flushText();
      out.push({ type: "at", raw: css.slice(i, k) });
      i = k;
      continue;
    }

    if (css[i] === "{") {
      const selector = buf.trim();
      const lead = buf.slice(0, buf.length - buf.trimStart().length);
      buf = "";
      let depth = 1;
      let k = i + 1;
      while (k < css.length && depth > 0) {
        if (css[k] === "{") depth++;
        else if (css[k] === "}") depth--;
        k++;
      }
      const body = css.slice(i + 1, k - 1);
      // keep any comment that preceded this selector
      const commentMatch = selector.match(/^([\s\S]*\*\/)\s*([\s\S]*)$/);
      if (commentMatch) {
        out.push({ type: "text", raw: lead + commentMatch[1] });
        out.push({ type: "rule", selector: commentMatch[2].trim(), body });
      } else {
        if (lead.trim()) out.push({ type: "text", raw: lead });
        out.push({ type: "rule", selector, body });
      }
      i = k;
      continue;
    }

    buf += css[i];
    i++;
  }
  flushText();
  return out;
}

/** Parse declarations, preserving order and duplicates. */
function parseDecls(body) {
  const decls = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      if (cur.trim()) decls.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) decls.push(cur.trim());
  return decls;
}

const propOf = (decl) => decl.slice(0, decl.indexOf(":")).trim().toLowerCase();
const selsOf = (selector) =>
  selector
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
const keyOf = (selector) => selsOf(selector).join(", ");

const segments = tokenize(source);
const rules = segments.filter((s) => s.type === "rule");
rules.forEach((r, idx) => {
  r.idx = idx;
  r.key = keyOf(r.selector);
  r.sels = selsOf(r.selector);
  r.decls = parseDecls(r.body);
  r.props = r.decls.map(propOf);
});

/** Would merging `b` into `a` change what wins for any shared element? */
function unsafeToMerge(a, b) {
  for (const other of rules) {
    if (other.idx <= a.idx || other.idx >= b.idx) continue;
    if (other.key === b.key) continue;
    if (!other.sels.some((s) => b.sels.includes(s))) continue;
    if (other.props.some((p) => b.props.includes(p))) return true;
  }
  return false;
}

// Merge later occurrences into the earliest safe target.
const absorbed = new Set();
let merged = 0;
let skipped = 0;
for (const rule of rules) {
  if (absorbed.has(rule.idx)) continue;
  for (const later of rules) {
    if (later.idx <= rule.idx || absorbed.has(later.idx)) continue;
    if (later.key !== rule.key) continue;
    if (unsafeToMerge(rule, later)) {
      skipped++;
      continue;
    }
    // later wins: drop props it redeclares, then append its declarations
    const override = new Set(later.props);
    rule.decls = rule.decls.filter((d) => !override.has(propOf(d))).concat(later.decls);
    rule.props = rule.decls.map(propOf);
    absorbed.add(later.idx);
    merged++;
  }
}

const indentOf = (body) => {
  const m = body.match(/\n([ \t]+)\S/);
  return m ? m[1] : "  ";
};

let out = "";
for (const seg of segments) {
  if (seg.type === "text" || seg.type === "at") {
    out += seg.raw;
    continue;
  }
  if (absorbed.has(seg.idx)) continue;
  if (seg.decls.length === 0) continue;
  const pad = indentOf(seg.body);
  out += `${seg.selector} {\n${seg.decls.map((d) => `${pad}${d};`).join("\n")}\n}\n`;
}
out = out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
if (!out.endsWith("\n")) out += "\n";

/** Cascade invariant: last-declared value per (exact selector, property). */
function finalValues(css) {
  const map = new Map();
  const walk = (segs, scope) => {
    for (const seg of segs) {
      if (seg.type === "at") {
        const open = seg.raw.indexOf("{");
        const cond = seg.raw.slice(0, open).trim();
        if (/^@(media|supports|layer|container)/i.test(cond)) {
          walk(tokenize(seg.raw.slice(open + 1, seg.raw.lastIndexOf("}"))), `${scope}${cond}|`);
        }
        continue;
      }
      if (seg.type !== "rule") continue;
      for (const sel of selsOf(seg.selector)) {
        for (const decl of parseDecls(seg.body)) {
          const value = decl.slice(decl.indexOf(":") + 1).trim();
          map.set(`${scope}${sel}|${propOf(decl)}`, value);
        }
      }
    }
  };
  walk(tokenize(css), "");
  return map;
}

const before = finalValues(source);
const after = finalValues(out);
const diffs = [];
for (const [k, v] of before) {
  if (!after.has(k)) diffs.push(`LOST    ${k} = ${v}`);
  else if (after.get(k) !== v) diffs.push(`CHANGED ${k}: ${v} -> ${after.get(k)}`);
}
for (const k of after.keys()) if (!before.has(k)) diffs.push(`ADDED   ${k}`);

console.log(`${file}`);
console.log(`  rules            : ${rules.length}`);
console.log(`  merged           : ${merged}`);
console.log(`  skipped (unsafe) : ${skipped}`);
console.log(`  lines            : ${source.split("\n").length} -> ${out.split("\n").length}`);
console.log(`  cascade diffs    : ${diffs.length}`);
for (const d of diffs.slice(0, 40)) console.log(`    ${d}`);

if (diffs.length) {
  console.error("\nrefusing to write: cascade changed");
  process.exit(1);
}
if (write) {
  fs.writeFileSync(file, out);
  console.log("  written");
} else {
  fs.writeFileSync(`${file}.dedupe`, out);
  console.log(`  preview -> ${file}.dedupe`);
}
