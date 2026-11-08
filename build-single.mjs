// Builds the single-file bundles: the whole game in one file, so
// anyone (including a judge on a phone) can open it with no server
// and no build. Run: node build-single.mjs
//
// The bundles ship as CLASSIC scripts, never type="module": some
// phone file viewers execute classic scripts but silently skip
// module scripts, which left those users a dead static shell (page
// renders, canvas never boots, no sound). The concatenated code is
// wrapped in a strict IIFE so its top-level names stay private,
// exactly as module scope kept them, and nothing leaks into or
// collides with the global scope. Only this wrapper changes; the
// modular build (index.html) keeps real modules.
//
// Two variants ship from the same sources, differing ONLY in the
// NEAR-affiliation layer (the ON NEAR pill, the built-on line, the
// title accent, the PnL card mark, the hackathon footer lines —
// everything wrapped in <!--AFFIL--> markers in index.html, plus the
// card painter's mark, gated on the VARIANT constant):
//   hackathon -> dist/pump-rider.html          (repo + GitHub Pages)
//   product   -> dist/product/pump-rider.html  (Netlify product site)
// The game's own NEAR flavour — NEAR orbs, the puns, the currency
// switch — is identical in both. BUILD_VARIANT=hackathon|product
// builds just one; no flag builds both.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

function stripModuleSyntax(code) {
  return code
    .replace(/import[\s\S]*?from\s+'[^']+';/g, '') // import blocks
    .replace(/^export\s+/gm, ''); // export prefixes
}

const css = readFileSync('style.css', 'utf8');
const jsTemplate = ['engine.js', 'recap.js', 'app.js']
  .map((f) => stripModuleSyntax(readFileSync(f, 'utf8')))
  .join('\n\n');

// The affiliation layer: the product build loses every AFFIL block
// outright; the hackathon build keeps the content and drops only
// the markers.
function affiliation(html, variant) {
  if (variant === 'product') {
    return html.replace(/<!--AFFIL-->[\s\S]*?<!--\/AFFIL-->/g, () => '');
  }
  return html.replace(/<!--AFFIL-->|<!--\/AFFIL-->/g, () => '');
}

function build(variant) {
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
  const js = jsTemplate.split('__VARIANT__').join(variant);
  html = html.replace(
    '<script type="module" src="app.js"></script>',
    () => `<script>\n;(() => {\n'use strict';\n${js}\n})();\n</script>`,
  );
  return affiliation(html, variant);
}

const outputs = {
  hackathon: 'dist/pump-rider.html',
  product: 'dist/product/pump-rider.html',
};
const wanted = (process.env.BUILD_VARIANT || 'both').toLowerCase();
for (const [variant, path] of Object.entries(outputs)) {
  if (wanted !== 'both' && wanted !== variant) continue;
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const html = build(variant);
  writeFileSync(path, html);
  console.log(`Wrote ${path} (${variant})`, html.length, 'bytes');
}
