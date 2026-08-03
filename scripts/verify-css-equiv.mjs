// Verify two CSS files are equivalent under the "last declaration wins" cascade,
// computed per (at-rule context, selector, property).
//
// This is the invariant a pure dedupe/merge transform must preserve: for every
// selector, the final effective declaration set must be byte-identical. It is
// necessary-but-not-sufficient on its own (cross-selector order can still matter
// when two equal-specificity selectors match the same element), which is why the
// dedupe script separately refuses to hoist a rule past any intervening rule that
// shares a property with it.
//
// Usage: node scripts/verify-css-equiv.mjs a.css b.css

import { readFileSync } from "node:fs";

function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    out += src[i];
  }
  return out;
}

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Returns declarations in document order:
//   { context, selector, prop, value }
// context is the joined at-rule prelude stack, e.g. "@media (max-width: 1420px)".
function parse(src) {
  const css = stripComments(src);
  const decls = [];
  const stack = [];
  let prelude = "";
  let i = 0;

  while (i < css.length) {
    const ch = css[i];

    if (ch === "{") {
      const head = prelude.trim();
      prelude = "";
      i += 1;

      if (head.startsWith("@")) {
        // Nested/conditional group rule: push context, keep walking.
        stack.push(head.replace(/\s+/g, " "));
        continue;
      }

      // Declaration block: consume to the matching close brace.
      let depth = 1;
      let body = "";
      while (i < css.length && depth > 0) {
        const c = css[i];
        if (c === "{") depth += 1;
        else if (c === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += c;
        i += 1;
      }
      i += 1; // past the closing brace

      const context = stack.join(" ");
      const selectors = splitTopLevel(head, ",")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      for (const raw of splitTopLevel(body, ";")) {
        const declText = raw.trim();
        if (!declText) continue;
        const colon = declText.indexOf(":");
        if (colon === -1) continue;
        const prop = declText.slice(0, colon).trim();
        const value = declText.slice(colon + 1).replace(/\s+/g, " ").trim();
        if (!prop) continue;
        for (const selector of selectors) {
          decls.push({ context, selector, prop, value });
        }
      }
      continue;
    }

    if (ch === "}") {
      // Closing an at-rule context.
      stack.pop();
      prelude = "";
      i += 1;
      continue;
    }

    if (ch === ";" && prelude.trim().startsWith("@")) {
      // Statement at-rule, e.g. @import / @charset.
      const head = prelude.trim().replace(/\s+/g, " ");
      decls.push({ context: stack.join(" "), selector: head, prop: "@statement", value: head });
      prelude = "";
      i += 1;
      continue;
    }

    prelude += ch;
    i += 1;
  }

  return decls;
}

// Collapse to effective values under last-wins.
function effective(decls) {
  const map = new Map();
  for (const d of decls) {
    map.set(`${d.context}||${d.selector}||${d.prop}`, d.value);
  }
  return map;
}

function selectorSet(decls) {
  return new Set(decls.map((d) => `${d.context}||${d.selector}`));
}

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error("usage: node scripts/verify-css-equiv.mjs a.css b.css");
  process.exit(2);
}

const declsA = parse(readFileSync(fileA, "utf8"));
const declsB = parse(readFileSync(fileB, "utf8"));
const effA = effective(declsA);
const effB = effective(declsB);

const diffs = [];
for (const [key, valueA] of effA) {
  if (!effB.has(key)) diffs.push(`MISSING in B: ${key} = ${valueA}`);
  else if (effB.get(key) !== valueA) {
    diffs.push(`CHANGED: ${key}\n    A: ${valueA}\n    B: ${effB.get(key)}`);
  }
}
for (const [key, valueB] of effB) {
  if (!effA.has(key)) diffs.push(`EXTRA in B: ${key} = ${valueB}`);
}

// Selector coverage: no rule may vanish entirely.
const selA = selectorSet(declsA);
const selB = selectorSet(declsB);
const lostSelectors = [...selA].filter((s) => !selB.has(s));

console.log(`A: ${declsA.length} decls, ${selA.size} selector-contexts`);
console.log(`B: ${declsB.length} decls, ${selB.size} selector-contexts`);
console.log(`effective A: ${effA.size}   effective B: ${effB.size}`);

if (lostSelectors.length) {
  console.log(`\nLOST SELECTORS (${lostSelectors.length}):`);
  for (const s of lostSelectors) console.log(`  ${s}`);
}

if (diffs.length === 0 && lostSelectors.length === 0) {
  console.log("\nEQUIVALENT: effective cascade is identical.");
  process.exit(0);
}

console.log(`\n${diffs.length} DIFFS:`);
for (const d of diffs.slice(0, 60)) console.log(`  ${d}`);
if (diffs.length > 60) console.log(`  ... and ${diffs.length - 60} more`);
process.exit(1);
