#!/usr/bin/env bash
# Negative controls for the repository guards.
#
# Written because the em dash checker passed vacuously for four commits: it was
# searching for a string that could never appear, so it reported OK forever.
# A guard nobody has watched fail is not a guard.
#
# Each control plants the exact problem the guard exists to catch and asserts it
# is caught, then removes it and asserts the guard goes quiet again.
set -uo pipefail

cd "$(dirname "$0")/.."

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# --- guard 1: em dashes -----------------------------------------------------

echo "em dash checker"

if bash scripts/check-em-dashes.sh --self-test >/dev/null 2>&1; then
  pass "self-test confirms it can construct and match U+2014"
else
  fail "self-test failed, the checker cannot detect its own target"
fi

probe="planted-emdash-control.md"
printf 'heading %s tail\n' "$(printf '\xe2\x80\x94')" > "$probe"
git add -N "$probe" >/dev/null 2>&1
if bash scripts/check-em-dashes.sh >/dev/null 2>&1; then
  fail "a planted em dash was NOT detected"
else
  pass "a planted em dash is detected"
fi
git rm -q --cached "$probe" >/dev/null 2>&1 || true
rm -f "$probe"

if bash scripts/check-em-dashes.sh >/dev/null 2>&1; then
  pass "goes quiet once the em dash is removed"
else
  fail "still reporting a failure after cleanup"
fi

# --- guard 2: documentation drift -------------------------------------------

echo "documentation drift"

# Uses a scratch branch so main is never touched. Any failure still lands back
# on the original branch via the trap.
original_branch=$(git rev-parse --abbrev-ref HEAD)
control_branch="drift-control-$$"

cleanup() {
  git checkout -q "$original_branch" 2>/dev/null || true
  git branch -q -D "$control_branch" 2>/dev/null || true
}
trap cleanup EXIT

if [ -n "$(git status --porcelain)" ]; then
  echo "  SKIP  working tree is dirty, cannot run the drift control safely"
else
  git checkout -q -b "$control_branch"

  printf '\n// drift control\n' >> apps/desktop/service/src/config.ts
  git add apps/desktop/service/src/config.ts
  git -c user.name=control -c user.email=control@example.com commit -q -m "control: config without docs"

  if bash scripts/check-doc-drift.sh "HEAD~1..HEAD" >/dev/null 2>&1; then
    fail "config changed without docs/SETUP.md and was NOT caught"
  else
    pass "config changed without docs/SETUP.md is caught"
  fi

  printf '\n<!-- drift control -->\n' >> docs/SETUP.md
  git add docs/SETUP.md
  git -c user.name=control -c user.email=control@example.com commit -q --amend --no-edit

  if bash scripts/check-doc-drift.sh "HEAD~1..HEAD" >/dev/null 2>&1; then
    pass "goes quiet once docs/SETUP.md moves too"
  else
    fail "still reporting drift after the doc was updated"
  fi

  cleanup
  trap - EXIT
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "all guard controls passed"
  exit 0
fi
echo "$failures guard control(s) failed"
exit 1
