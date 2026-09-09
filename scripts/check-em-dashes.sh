#!/usr/bin/env bash
# Rule 1 in CLAUDE.md: no em dashes anywhere.
#
# Checks tracked files only, so a stray artefact in an ignored directory cannot
# fail the build. Also catches the HTML entity, which renders identically.
#
# Two things this script gets deliberately right, both learned by getting them
# wrong first:
#
#   1. The em dash is built from UTF-8 BYTES. Git Bash's printf does not
#      interpret \u, so the escape form silently produced a literal
#      seven-character string and the check passed while matching nothing.
#   2. Both needles are assembled at runtime, so this script does not match
#      itself. The first version did, and the pre-push hook duly blocked it.
#
# Self-test: scripts/check-em-dashes.sh --self-test
set -uo pipefail

cd "$(dirname "$0")/.."

EM_DASH=$(printf '\xe2\x80\x94')
ENTITY='&md'"ash;"

# Fail loudly rather than silently checking for nothing, which is precisely the
# bug this guard exists to stop recurring.
#
# Compares raw bytes, not ${#EM_DASH}: that counts bytes in a non-UTF-8 locale
# and characters in a UTF-8 one, so it is 3 here and 1 elsewhere. The byte
# sequence is the same everywhere.
actual_bytes=$(printf '%s' "$EM_DASH" | od -An -tx1 | tr -d ' \n')
if [ "$actual_bytes" != "e28094" ]; then
  echo "FAIL: could not construct U+2014 on this shell (got bytes '$actual_bytes'),"
  echo "      refusing to run a check that would silently match nothing."
  exit 2
fi

if [ "${1:-}" = "--self-test" ]; then
  probe=$(mktemp)
  printf 'a %s b\n' "$EM_DASH" > "$probe"
  if grep -qF -e "$EM_DASH" -- "$probe"; then
    rm -f "$probe"
    echo "OK: self-test passed, the checker can detect a real em dash"
    exit 0
  fi
  rm -f "$probe"
  echo "FAIL: self-test failed, the checker cannot detect an em dash"
  exit 2
fi

matches=$(git ls-files -z \
  | grep -zZv -e '^packages/corpus/images/' \
  | xargs -0 grep -nIF -e "$EM_DASH" -e "$ENTITY" -- 2>/dev/null || true)

if [ -n "$matches" ]; then
  echo "FAIL: em dashes found. Use a hyphen, colon, parentheses, comma or a new sentence."
  echo "$matches"
  exit 1
fi

echo "OK: no em dashes"
