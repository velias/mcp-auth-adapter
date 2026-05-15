#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

REPO_URL=$(gh repo view --json url -q '.url')
OUTFILE="CHANGELOG.md"

{
  echo "# Changelog"
  echo ""
  echo "All notable changes to this project are documented here."
  echo "This file is auto-generated from [GitHub Releases](${REPO_URL}/releases) — do not edit manually."

  gh release list --limit 1000 --json tagName,publishedAt \
    --jq '.[] | "\(.tagName)\t\(.publishedAt)"' |
  while IFS=$'\t' read -r tag published; do
    date="${published%%T*}"

    body=$(gh release view "$tag" --json body -q '.body' | tr -d '\r')

    # Strip HTML comments (single-line and multi-line)
    body=$(printf '%s\n' "$body" | perl -0777 -pe 's/<!--.*?-->\n?//gs')
    # Strip "## What's Changed" heading (redundant under the version heading)
    body=$(printf '%s\n' "$body" | grep -v '^## What'\''s Changed$' || true)
    # Trim leading and trailing blank lines
    body=$(printf '%s\n' "$body" | sed -e '/./,$!d' | sed -e :a -e '/^\s*$/{$d;N;ba;}')

    echo ""
    echo "---"
    echo ""
    echo "## [${tag}](${REPO_URL}/releases/tag/${tag}) — ${date}"
    echo ""
    echo "$body"
  done
} > "$OUTFILE"

echo "Generated ${OUTFILE} ($(grep -c '^## \[' "$OUTFILE") releases)"
