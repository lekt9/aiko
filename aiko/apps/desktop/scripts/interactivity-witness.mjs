// Witness: the agent's interfaces are REVEALED in the app, not merely produced.
//
//   node apps/desktop/scripts/interactivity-witness.mjs
//
// The defect this guards is silence, not breakage. The aiko agent already
// emits reasoning, tool calls, plans and its own command catalogue over ACP;
// the backend forwarded only `agent_message_chunk` and dropped the rest, so
// everything else was generated and then deleted before a reader could see it.
// Nothing crashed. Nothing logged. The app just showed less than it knew.
//
// Exit 0 only when every section passes:
//   A. The ACP translator turns EVERY session update into a chunk — including
//      one it has no branch for — proven by the backend suite, plus a source
//      anchor that the discard-everything-else branch is gone.
//   B. The frontend can render each of those chunks, proven by the component
//      suite driving real clicks, and the whole app typechecks.
//   C. The BUILT bundle contains the renderer. Source that never reached
//      `dist/` is not "on the app" — the desktop shell serves dist.
//   D. When the app is actually running, its served page carries the bundle
//      that section C checked. Skipped, loudly, when nothing is serving.
//
// Falsifier (verified by hand, and the reason these assertions are shaped this
// way): delete the `activity` branch from ChatMessage.vue and section B goes
// red; restore the `!= "agent_message_chunk": continue` filter in
// aiko_acp_client.py and section A goes red.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const BACKEND = join(REPO, 'apps/frontend/backend');
const FRONTEND = join(REPO, 'apps/frontend/frontend');
const ACP_CLIENT = join(BACKEND, 'app/infrastructure/external/claw/aiko_acp_client.py');

const failures = [];
const skips = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, out: '' };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-6).join(' | ') };
  }
}

function sourceOf(path) {
  if (!existsSync(path)) {
    failures.push(`missing source ${path}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

// ── A. the backend forwards every update kind ────────────────────────────────
console.log('\nA. ACP translation — nothing the agent reports is discarded');

const acp = sourceOf(ACP_CLIENT);

// The exact shape of the old bug: match anything that skips an update because
// it is not an agent_message_chunk. Anchoring on the behaviour, not a comment,
// is what makes this survive a rewrite.
const discardsNonText = /!=\s*["']agent_message_chunk["'][\s\S]{0,80}?continue/.test(acp);
check('the agent_message_chunk-only filter is gone', !discardsNonText);

for (const kind of ['agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'available_commands_update']) {
  check(`translator handles ${kind}`, acp.includes(kind));
}
// The catch-all is the part that keeps this from decaying on the next ACP
// addition, so it is asserted as a feature rather than left as a nicety.
check('an unrecognised update still becomes a chunk', /"type":\s*"raw"/.test(acp));

const pytest = run('uv', ['run', 'pytest', 'tests/test_acp_update_translation.py', '-q'], BACKEND);
check('backend translation suite green', pytest.ok, pytest.out);

// ── B. the frontend renders them ─────────────────────────────────────────────
console.log('\nB. Rendering — each chunk has somewhere to land');

const chatMessage = sourceOf(join(FRONTEND, 'src/components/ChatMessage.vue'));
check(
  'the shared message renderer routes activity messages',
  /message\.type === 'activity'/.test(chatMessage) && chatMessage.includes('AgentActivity'),
);
check('the activity renderer exists', existsSync(join(FRONTEND, 'src/components/AgentActivity.vue')));

const dispatcher = sourceOf(join(FRONTEND, 'src/composables/useAgentEvents.ts'));
// Before this branch existed, an event kind the build did not know about fell
// off the end of the if-chain with no render and no warning.
check('the event dispatcher has a default branch', /\}\s*else\s*\{/.test(dispatcher));
check('reasoning events are dispatched', dispatcher.includes('handleReasoningEvent'));

const vitest = run(
  'npx',
  ['vitest', 'run',
    'src/components/__tests__/AgentActivity.spec.ts',
    'src/components/__tests__/AgentEventReveal.spec.ts',
    'src/components/__tests__/ClawActivity.spec.ts'],
  FRONTEND,
);
check('activity + reveal suites green (real clicks, real disclosure)', vitest.ok, vitest.out);

const tsc = run('npm', ['run', 'type-check'], FRONTEND);
check('frontend typechecks', tsc.ok, tsc.out);

// ── C. it reached the bundle the app serves ──────────────────────────────────
console.log('\nC. Shipped — source that never reached dist/ is not on the app');

const distAssets = join(FRONTEND, 'dist/assets');
// Named so section D can ask the RUNNING app for the same file. The renderer
// is code-split, so the entry bundle does not contain it and checking only
// the entry would pass against a stale chunk.
let rendererChunk = null;
if (!existsSync(distAssets)) {
  check('frontend dist/ exists', false, 'run `npm run build` in apps/frontend/frontend');
} else {
  const chunks = readdirSync(distAssets).filter((f) => f.endsWith('.js'));
  // A marker the renderer cannot work without, and that no other code emits.
  rendererChunk = chunks.find((f) => readFileSync(join(distAssets, f), 'utf8').includes('activity-toggle'));
  check('built bundle carries the activity renderer', Boolean(rendererChunk), rendererChunk ?? '');
  const all = chunks.map((f) => readFileSync(join(distAssets, f), 'utf8')).join('');
  check('built bundle carries the tools-available catalogue', all.includes('tools available'));
}

// ── D. the running app serves that bundle ────────────────────────────────────
console.log('\nD. Live app');

const ORIGIN = process.env.AIKO_WEB_ORIGIN ?? 'http://127.0.0.1:17870';
let index = null;
try {
  const response = await fetch(ORIGIN, { signal: AbortSignal.timeout(4000) });
  if (response.ok) index = await response.text();
} catch {
  index = null;
}

if (index === null) {
  // Not a pass. An unrunnable section is reported as unproven, because a
  // witness that quietly counts "could not check" as "checked" is the same
  // silence this whole file exists to refuse.
  skips.push(`app not serving at ${ORIGIN} — sections A–C proven, live serving unproven`);
  console.log(`SKIP  app not serving at ${ORIGIN}`);
} else if (!rendererChunk) {
  skips.push('no renderer chunk in dist/, so there is nothing to ask the running app for');
  console.log('SKIP  renderer chunk unknown');
} else {
  // Ask the app for the exact chunk the build put the renderer in. A packaged
  // app serves a COPY of dist made at bundle time, so this is the check that
  // catches "rebuilt the frontend, but the running app still has the old one".
  const served = await fetch(`${ORIGIN}/assets/${rendererChunk}`)
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
  check(
    'the RUNNING app serves the activity renderer',
    served.includes('activity-toggle'),
    served ? rendererChunk : `${rendererChunk} not served — app has a stale copy of dist/`,
  );
}

console.log('');
for (const note of skips) console.log(`NOTE  ${note}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('interactivity witness: PASS');
