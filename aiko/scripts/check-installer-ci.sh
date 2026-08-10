#!/usr/bin/env bash
# Mechanical witness for the macOS product-installer CI/CD path.
set -euo pipefail

AIKO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$AIKO_ROOT/.." && pwd)
RELEASE_WORKFLOW="$REPO_ROOT/.github/workflows/release.yml"
CI_WORKFLOW="$REPO_ROOT/.github/workflows/ci.yml"
PREPARE_RUNTIME="$AIKO_ROOT/apps/desktop/scripts/prepare-runtime.mjs"

for file in \
  "$RELEASE_WORKFLOW" \
  "$CI_WORKFLOW" \
  "$REPO_ROOT/README.md" \
  "$AIKO_ROOT/installer/macos/distribution.xml" \
  "$AIKO_ROOT/installer/macos/resources/welcome.html" \
  "$PREPARE_RUNTIME" \
  "$AIKO_ROOT/scripts/prep-installer.sh"; do
  test -f "$file" || { echo "missing installer CI/CD input: $file" >&2; exit 1; }
done

ruby - "$RELEASE_WORKFLOW" "$CI_WORKFLOW" "$PREPARE_RUNTIME" <<'RUBY'
require "yaml"

release = YAML.load_file(ARGV.fetch(0))
ci = YAML.load_file(ARGV.fetch(1))

def step!(job, name)
  job.fetch("steps").find { |step| step["name"] == name } ||
    raise("missing step #{name.inspect}")
end

macos = release.fetch("jobs").fetch("desktop-macos")
raise "desktop-macos must run natively" unless macos.fetch("runs-on") == "macos-latest"

version_run = step!(macos, "Set and verify desktop release version").fetch("run")
%w[release_version cli_version].each do |claim|
  raise "release version gate missing #{claim}" unless version_run.include?(claim)
end

certificate_run = step!(macos, "Configure macOS signing certificates").fetch("run")
%w[APPLE_CERTIFICATE APPLE_INSTALLER_CERTIFICATE Required\ release\ secret security\ import security\ find-identity].each do |claim|
  value = claim.tr("\\", "")
  raise "certificate import missing #{value}" unless certificate_run.include?(value)
end

contract_signing = step!(macos, "Sign embedded Contract runtime").fetch("run")
%w[libcontract.dylib codesign\ --force --timestamp codesign\ --verify Authority= Timestamp=].each do |claim|
  value = claim.tr("\\", "")
  raise "embedded Contract signing missing #{value}" unless contract_signing.include?(value)
end

dmg = step!(macos, "Build macOS DMG")
raise "DMG build does not pass the application signing identity" unless
  dmg.fetch("env").fetch("APPLE_SIGNING_IDENTITY").include?("secrets.APPLE_SIGNING_IDENTITY")

runtime_prepare = File.read(ARGV.fetch(2))
%w[APPLE_SIGNING_IDENTITY codesign --force --timestamp --options runtime --verify Authority= Timestamp=].each do |claim|
  raise "runtime refresh signing missing #{claim}" unless runtime_prepare.include?(claim)
end

build_run = step!(macos, "Build and verify macOS product installer").fetch("run")
%w[scripts/prep-installer.sh --notarize --check pkgutil\ --check-signature stapler\ validate].each do |claim|
  raise "product installer build missing #{claim}" unless build_run.include?(claim)
end

normalize = step!(macos, "Normalize and verify macOS assets").fetch("run")
%w[Aiko-macOS.pkg Aiko-macOS.pkg.zip pkgutil\ --expand pkgutil\ --check-signature stapler\ validate unzip\ -tq].each do |claim|
  value = claim.tr("\\", "")
  raise "macOS asset verification missing #{value}" unless normalize.include?(value)
end

upload = macos.fetch("steps").find { |step| step["uses"] == "actions/upload-artifact@v4" }
raise "macOS release artifact upload missing" unless upload
raise "macOS upload must fail closed" unless upload.fetch("with").fetch("if-no-files-found") == "error"

release_gate = step!(release.fetch("jobs").fetch("github-release"), "Stage, verify, and checksum release assets").fetch("run")
%w[Aiko-macOS.pkg Aiko-macOS.pkg.zip SHA256SUMS.txt].each do |claim|
  raise "GitHub release gate missing #{claim}" unless release_gate.include?(claim)
end

installer_ci = ci.fetch("jobs").fetch("installer-config")
ci_run = step!(installer_ci, "Verify macOS installer workflow and sources").fetch("run")
raise "CI does not execute installer witness" unless ci_run.include?("aiko/scripts/check-installer-ci.sh")

smoke = ci.fetch("jobs").fetch("macos-installer-smoke")
raise "installer smoke must run on macOS" unless smoke.fetch("runs-on") == "macos-latest"
smoke_run = step!(smoke, "Build and verify unsigned product installer").fetch("run")
%w[scripts/prep-installer.sh --check].each do |claim|
  raise "macOS CI smoke missing #{claim}" unless smoke_run.include?(claim)
end
smoke_upload = smoke.fetch("steps").find { |step| step["uses"] == "actions/upload-artifact@v4" }
raise "macOS CI smoke artifact upload missing" unless smoke_upload
raise "macOS CI smoke upload must fail closed" unless smoke_upload.fetch("with").fetch("if-no-files-found") == "error"

puts "macOS installer CI/CD contract: PASS"
RUBY

grep -q '__APP_VERSION__' "$AIKO_ROOT/installer/macos/distribution.xml"
grep -q '__CLI_VERSION__' "$AIKO_ROOT/installer/macos/distribution.xml"
grep -q 'INSTALLER_SOURCE=' "$AIKO_ROOT/scripts/prep-installer.sh"
grep -q 'prepare_installer_metadata' "$AIKO_ROOT/scripts/prep-installer.sh"
grep -q 'zip -j -q' "$AIKO_ROOT/scripts/prep-installer.sh"
grep -q 'mkdir -p.*dirname.*STAGE' "$AIKO_ROOT/scripts/stage-dist-app.sh"
grep -q 'Aiko-macOS\.pkg' "$REPO_ROOT/README.md"
grep -q 'Aiko-macOS\.pkg\.zip' "$REPO_ROOT/README.md"
zsh -n "$AIKO_ROOT/scripts/prep-installer.sh" "$AIKO_ROOT/scripts/stage-dist-app.sh"

echo "ALL INSTALLER CI/CD CHECKS PASSED"
