#!/usr/bin/env bash
# bun-fetch source: use bun (if installed) to fetch the README + package.json
# for a GitHub org/repo or an npm package. Non-binding — exits 1 silently
# when bun is missing OR the topic doesn't resolve to a fetchable URL.
#
# If `bun` is missing AND `nanobrew` is on PATH, emits an install-hint
# envelope suggesting `nanobrew install bun` (per Lewis's "rely on bun and
# nanobrew from justrach to fetch whatever is relevant").
set -e

TOPIC="${1:-${CONTEXT_TOPIC:-}}"
SLUG="${CONTEXT_SLUG:-topic}"

if ! command -v bun >/dev/null 2>&1; then
  if command -v nanobrew >/dev/null 2>&1; then
    python3 - "$TOPIC" "$SLUG" <<'PY'
import json, sys
topic, slug = sys.argv[1], sys.argv[2]
env = {
    "topic": topic, "slug": slug, "source": "bun-fetch",
    "body": "bun is not installed on this host. nanobrew is available — install bun with:\n  nanobrew install bun\nThen re-run: contract context-of '%s' --refresh" % topic,
    "refs": [], "install_hint": "nanobrew install bun",
}
print(json.dumps(env))
PY
    exit 0
  fi
  exit 1
fi

# Build a bun one-liner that fetches README + package.json. The TOPIC may
# be an org/repo (github) OR a bare npm package name. Try github first.
RESULT_JSON=$(bun -e "
const topic = ${TOPIC@Q};
const isOrgRepo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\$/.test(topic);
const refs = [];
const parts = [];
async function getText(url) {
  try {
    const r = await fetch(url, {headers:{'user-agent':'contract-context-of'}});
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}
async function getJson(url) {
  try {
    const r = await fetch(url, {headers:{'user-agent':'contract-context-of','accept':'application/json'}});
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
if (isOrgRepo) {
  // README on default branch (try main then master via API)
  const meta = await getJson(\`https://api.github.com/repos/\${topic}\`);
  const branch = (meta && meta.default_branch) || 'main';
  const rawReadme = await getText(\`https://raw.githubusercontent.com/\${topic}/\${branch}/README.md\`);
  if (rawReadme) {
    parts.push(\`# README (\${topic}@\${branch})\\n\\n\` + rawReadme.slice(0, 50000));
    refs.push(\`https://github.com/\${topic}/blob/\${branch}/README.md\`);
  }
  const pkg = await getText(\`https://raw.githubusercontent.com/\${topic}/\${branch}/package.json\`);
  if (pkg) { parts.push('# package.json\\n\\n' + pkg.slice(0, 8000)); refs.push(\`https://github.com/\${topic}/blob/\${branch}/package.json\`); }
} else {
  // npm
  const reg = await getJson(\`https://registry.npmjs.org/\${encodeURIComponent(topic)}\`);
  if (reg) {
    const latest = reg['dist-tags'] && reg['dist-tags'].latest;
    const v = latest && reg.versions && reg.versions[latest];
    if (v) {
      parts.push(\`# npm: \${topic}@\${latest}\\n\\n\` + (v.description || ''));
      if (v.repository && v.repository.url) refs.push(v.repository.url);
      if (v.homepage) refs.push(v.homepage);
      refs.push(\`https://www.npmjs.com/package/\${topic}\`);
    }
    if (reg.readme) parts.push('# README\\n\\n' + String(reg.readme).slice(0, 50000));
  }
}
const body = parts.join('\\n\\n---\\n\\n');
if (!body) process.exit(1);
console.log(JSON.stringify({topic, source:'bun-fetch', body, refs}));
" 2>/dev/null) || exit 1

[ -z "$RESULT_JSON" ] && exit 1
echo "$RESULT_JSON"
