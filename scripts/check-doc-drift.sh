#!/usr/bin/env bash
# Decision 23, mechanical half: code that a self-hoster depends on must not
# change without its paired document changing in the same range.
#
# Usage: check-doc-drift.sh [<range>]   (default: origin/main..HEAD)
set -uo pipefail

cd "$(dirname "$0")/.."

RANGE="${1:-}"
if [ -z "$RANGE" ]; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    RANGE="origin/main..HEAD"
  else
    echo "SKIP: no origin/main to compare against"
    exit 0
  fi
fi

changed=$(git diff --name-only "$RANGE" 2>/dev/null || true)
if [ -z "$changed" ]; then
  echo "OK: nothing changed in $RANGE"
  exit 0
fi

status=0

check_pair() {
  local code_glob="$1" doc="$2" label="$3"
  if echo "$changed" | grep -q "$code_glob"; then
    if ! echo "$changed" | grep -qx "$doc"; then
      echo "FAIL: $label changed but $doc did not."
      echo "      Per CLAUDE.md, these move together. Update $doc in the same range."
      status=1
    fi
  fi
}

check_pair '^packages/protocol/' 'docs/SPEC.md' 'the wire protocol'
check_pair '^apps/agent/src/config' 'docs/SETUP.md' 'the config schema'

if [ "$status" -eq 0 ]; then
  echo "OK: no documentation drift in $RANGE"
fi
exit "$status"
