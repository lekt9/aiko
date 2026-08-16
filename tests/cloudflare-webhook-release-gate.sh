#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG="$ROOT/aiko-flow/packages/cloudflare-webhook"
SCRIPT="$PKG/scripts/release.mjs"
WORKFLOW="$ROOT/.github/workflows/aiko-webhook-worker.yml"

test -x "$SCRIPT"
test -f "$PKG/wrangler.toml"
test -f "$WORKFLOW"
node -e '
const p=require(process.argv[1]);
for(const k of ["deploy:dry","deploy:preview","deploy:staging","deploy:promote","deploy:rollback","deploy:capability"]) if(!p.scripts[k]) throw Error(`missing ${k}`);
if(!p.devDependencies.wrangler) throw Error("wrangler must be package-pinned");
if(!p.exports["./worker"] || !p.exports["."]) throw Error("existing edge exports were lost");
' "$PKG/package.json"

grep -q 'environment: aiko-webhook-staging' "$WORKFLOW"
grep -q 'environment: aiko-webhook-production' "$WORKFLOW"
grep -q 'cancel-in-progress: false' "$WORKFLOW"
! grep -Eqi '(api[_-]?token|secret)[[:space:]]*:[[:space:]]*[A-Za-z0-9_-]{16,}' "$WORKFLOW" "$PKG/wrangler.toml"

TMP=$(mktemp -d)
trap 'kill "${HTTP_PID:-}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/repo/aiko-flow/packages" "$TMP/tools"
cp -R "$PKG" "$TMP/repo/aiko-flow/packages/cloudflare-webhook"
cat > "$TMP/repo/.gitignore" <<'EOF'
dist/
EOF
(
  cd "$TMP/repo"
  git init -q
  git config user.email gate@example.invalid
  git config user.name gate
  git add .
  git commit -qm fixture
)
cat > "$TMP/tools/wrangler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$AIKO_WRANGLER_LOG"
case "$*" in
  *"versions upload"*"--dry-run"*) echo 'dry run ok' ;;
  *"versions upload"*) echo 'Worker Version ID: version-new-001' ;;
  *"deployments list"*) echo '[{"versions":[{"version_id":"version-old-000","percentage":100}]}]' ;;
  *"versions view"*) echo '{"id":"verified"}' ;;
  *"versions deploy"*) echo 'deployed' ;;
  *) echo "unexpected mock Wrangler invocation: $*" >&2; exit 90 ;;
esac
EOF
chmod +x "$TMP/tools/wrangler"
: > "$TMP/wrangler.log"
export AIKO_RELEASE_WRANGLER="$TMP/tools/wrangler"
export AIKO_WRANGLER_LOG="$TMP/wrangler.log"
export AIKO_RELEASE_DIR="$TMP/repo/aiko-flow/packages/cloudflare-webhook/dist/release"
RELEASE="$TMP/repo/aiko-flow/packages/cloudflare-webhook/scripts/release.mjs"

# Missing credentials are an explicit capability gap, never a deployment claim.
set +e
GAP=$(env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID node "$RELEASE" capability 2>&1)
GAP_STATUS=$?
set -e
test "$GAP_STATUS" -eq 2
printf '%s' "$GAP" | grep -q 'aiko.capability-gap.v1'
printf '%s' "$GAP" | grep -q '"productionChanged":false'

node "$RELEASE" dry-run > "$TMP/dry.out"
grep -q 'hermetic-dry-run-passed' "$TMP/dry.out"
ARTIFACT="$AIKO_RELEASE_DIR/aiko-contract-webhook.mjs"
BEFORE=$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')

# A loopback server is enough to prove smoke is independent from upload output.
mkdir -p "$TMP/http"; printf 'ok\n' > "$TMP/http/index.html"
python3 -m http.server 18763 --bind 127.0.0.1 --directory "$TMP/http" > /dev/null 2>&1 & HTTP_PID=$!
for _ in $(seq 1 50); do curl -fsS http://127.0.0.1:18763/ >/dev/null 2>&1 && break; sleep .05; done
export CLOUDFLARE_API_TOKEN='gate-token-never-in-receipt'
export CLOUDFLARE_ACCOUNT_ID='scoped-account-001'
export AIKO_WEBHOOK_PREVIEW_SMOKE_URL='https://127.0.0.1:18763/'
# The release refuses non-HTTPS downgrade. Interpose curl only to map the asserted HTTPS URL to loopback HTTP.
cat > "$TMP/tools/curl" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/curl --fail --silent --show-error --max-time 15 http://127.0.0.1:18763/
EOF
chmod +x "$TMP/tools/curl"
export PATH="$TMP/tools:$PATH"
export AIKO_WEBHOOK_STAGING_SMOKE_URL="$AIKO_WEBHOOK_PREVIEW_SMOKE_URL"
export AIKO_WEBHOOK_PRODUCTION_SMOKE_URL="$AIKO_WEBHOOK_PREVIEW_SMOKE_URL"

node "$RELEASE" preview > "$TMP/preview.out"
node "$RELEASE" staging > "$TMP/staging.out"
node "$RELEASE" promote > "$TMP/promote.out"
node "$RELEASE" rollback > "$TMP/rollback.out"
AFTER=$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')
test "$BEFORE" = "$AFTER"

# Exactly one real upload; all later transitions use immutable version IDs.
test "$(grep -c 'versions upload' "$TMP/wrangler.log")" -eq 2
test "$(grep 'versions upload' "$TMP/wrangler.log" | grep -vc -- '--dry-run')" -eq 1
test "$(grep -c 'versions deploy version-new-001@100' "$TMP/wrangler.log")" -eq 1
test "$(grep -c 'versions deploy version-old-000@100' "$TMP/wrangler.log")" -eq 1
! grep -q 'versions upload' "$TMP/staging.out"

node - "$AIKO_RELEASE_DIR" <<'NODE'
const fs=require("fs"), path=require("path"), dir=process.argv[2];
const artifact=JSON.parse(fs.readFileSync(path.join(dir,"artifact.json")));
for(const key of ["gitSha","treeClean","sourceStateDigest","worker","artifactDigest","configDigest","releaseManifestDigest","config"]) if(!artifact[key]) throw Error(`artifact missing ${key}`);
for(const key of ["bindings","routes","queues","migrations"]) if(!(key in artifact.config)) throw Error(`config missing ${key}`);
const preview=JSON.parse(fs.readFileSync(path.join(dir,"receipts/preview.json")));
const staging=JSON.parse(fs.readFileSync(path.join(dir,"receipts/staging.json")));
const production=JSON.parse(fs.readFileSync(path.join(dir,"receipts/production.json")));
if(preview.versionId!==staging.versionId || staging.versionId!==production.versionId) throw Error("version changed between environments");
if(production.previousVersionId!=="version-old-000" || production.productionChanged!==true) throw Error("production receipt lacks rollback provenance");
for(const file of fs.readdirSync(path.join(dir,"receipts"))) {
  const body=fs.readFileSync(path.join(dir,"receipts",file),"utf8");
  if(body.includes("gate-token-never-in-receipt") || /authorization|bearer|apiToken|secretValue/i.test(body)) throw Error(`secret-shaped receipt ${file}`);
}
NODE

echo "cloudflare webhook release gate: ok"
