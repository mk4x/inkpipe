#!/usr/bin/env bash
# Rule 1 in CLAUDE.md: no em dashes anywhere.
#
# Checks tracked files only, so a stray artefact in an ignored directory cannot
# fail the build. Also catches the HTML entity, since that renders identically.
set -uo pipefail

cd "$(dirname "$0")/.."

# U+2014 written as an escape so this script itself stays clean ASCII.
EM_DASH=$(printf '\u2014')

matches=$(git ls-files -z \
  | grep -zZv -e '^packages/corpus/images/' \
  | xargs -0 grep -nIF -e "$EM_DASH" -e '&mdash;' -- 2>/dev/null || true)

if [ -n "$matches" ]; then
  echo "FAIL: em dashes found. Use a hyphen, colon, parentheses, comma or a new sentence."
  echo "$matches"
  exit 1
fi

echo "OK: no em dashes"
