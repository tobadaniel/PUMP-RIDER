// Builds dist/pump-rider.html: the whole game in one file, so anyone
// (including a judge on a phone) can open it with no server and no build.
// Run: node build-single.mjs
//
// The bundle ships as a CLASSIC script, never type="module": some phone
// file viewers execute classic scripts but silently skip module scripts,
// which left those users a dead static shell (page renders, canvas never
// boots, no sound). The concatenated code is wrapped in a strict IIFE so
// its top-level names stay private, exactly as module scope kept them,
// and nothing leaks into or collides with the global scope. Only this
// wrapper changes; the modular build (index.html) keeps real modules.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

function stripModuleSyntax(code) {
  return code
    .replace(/import[\s\S]*?from\s+'[^']+';/g, '') // import blocks
    .replace(/^export\s+/gm, ''); // export prefixes
}

const css = readFileSync('style.css', 'utf8');
const js = ['engine.js', 'recap.js', 'app.js']
  .map((f) => stripModuleSyntax(readFileSync(f, 'utf8')))
  .join('\n\n');

let html = readFileSync('index.html', 'utf8');
// Replacer FUNCTIONS, never replacement strings: String.replace
// interprets $ sequences in a replacement string ($$, $&, $', ...),
// and the game code legitimately contains them — fmtMoney's template
// "`$${grouped}`" is a literal dollar followed by an interpolation,
// and as a replacement string its $$ collapsed to one $, silently
// stripping every $ the stake/money code prints. A function's return
// value is inserted verbatim.
html = html.replace(
  '<link rel="stylesheet" href="style.css">',
  () => `<style>\n${css}\n</style>`,
);
html = html.replace(
  '<script type="module" src="app.js"></script>',
  () => `<script>\n;(() => {\n'use strict';\n${js}\n})();\n</script>`,
);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/pump-rider.html', html);
console.log('Wrote dist/pump-rider.html', html.length, 'bytes');
