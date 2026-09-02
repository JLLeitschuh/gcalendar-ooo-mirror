#!/usr/bin/env bash
# Exercise the sync logic in Node against a stubbed Calendar API.
# The .gs files are concatenated with the test body into one file so that their
# top-level consts share scope, the way they do in Apps Script.
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp harness.js "$tmp/"
{
  echo "require('$tmp/harness.js');"
  cat ../Config.gs ../Mirror.gs ../Setup.gs
  cat cases.js
} > "$tmp/run.js"
node "$tmp/run.js" | grep -v '^\[ooo-mirror\]'
