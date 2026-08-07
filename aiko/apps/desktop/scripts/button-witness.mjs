// Witness: every interactive control in the frontend does something, or is
// honestly presented as non-interactive. This guards the class of bug the
// button audit found — a control that looks clickable and silently no-ops.
//
//   node apps/desktop/scripts/button-witness.mjs
//
// It is static (reads source), so it runs without a browser and catches
// regressions at build time. Two kinds of check:
//   A. The specific fixes from the audit are present.
//   B. No NEW dead handler sneaks in — a `@click` bound to an empty arrow or a
//      handler whose entire body is a TODO/comment.
//
// Falsifier: revert any one fix and its section goes red; add a
// `@click="() => {}"` anywhere in src and section B catches it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '../../frontend/frontend');
const SRC = join(FRONTEND, 'src');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const read = (rel) => {
  try { return readFileSync(join(FRONTEND, rel), 'utf8'); }
  catch { failures.push(`missing ${rel}`); return ''; }
};
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { if (entry !== 'node_modules') walk(p, out); }
    else if (/\.(vue|ts)$/.test(entry)) out.push(p);
  }
  return out;
}

// ── A. the audit fixes ───────────────────────────────────────────────────────
console.log('\nA. Audit fixes present');

const console_ = read('src/pages/ConsolePage.vue');
check(
  'Console: a chip is clickable only when the op is HTTP-shaped',
  /isHttpOp\(op\)/.test(console_) && /console-chip--static/.test(console_),
  'RPC ops render as non-interactive tokens instead of no-op chips',
);

const takeover = read('src/components/TakeOverView.vue');
check(
  'Exit Takeover clears the ?vnc deep-link param',
  /useRouter/.test(takeover) && /delete query\.vnc/.test(takeover),
  'so the overlay closes even when reached by URL',
);

const filePanel = read('src/components/FilePanelContent.vue');
check(
  'Decorative file icon is not a dead link',
  !/<a href=""/.test(filePanel),
  'the <a href=""> became a <span>',
);

const events = read('src/composables/useAgentEvents.ts');
check(
  'wait/done event arms are intentional, not a TODO',
  !/handle wait event/.test(events) && /event === 'wait'/.test(events),
  'the // TODO is gone; the no-op is documented as a decision',
);

// ── B. no new dead handlers ──────────────────────────────────────────────────
console.log('\nB. No dead click handlers');

const files = walk(SRC);
const emptyArrow = [];      // @click="() => {}"  (or with whitespace)
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = f.slice(FRONTEND.length + 1);
  // @click bound directly to an empty arrow / empty block.
  const re = /@click(?:\.\w+)*="\(?\)?\s*=>\s*\{\s*\}"/g;
  let m;
  while ((m = re.exec(text))) emptyArrow.push(`${rel}: ${m[0]}`);
  // @click="" — bound to nothing.
  if (/@click(?:\.\w+)*=""/.test(text)) emptyArrow.push(`${rel}: @click=""`);
}
check('no @click bound to an empty handler', emptyArrow.length === 0, emptyArrow.join(' | '));

// Handlers whose entire body is a TODO/FIXME comment (the stub class).
const todoStub = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = f.slice(FRONTEND.length + 1);
  const re = /(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\))\s*(?::[^={]+)?=>?\s*\{\s*\/\/\s*(?:TODO|FIXME)[^\n]*\n\s*\}/g;
  let m;
  while ((m = re.exec(text))) todoStub.push(`${rel}: ${m[0].split('\n')[0]}…`);
}
check('no handler whose entire body is a TODO', todoStub.length === 0, todoStub.join(' | '));

console.log('');
if (failures.length) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('button witness: PASS');
