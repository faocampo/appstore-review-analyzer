#!/usr/bin/env bash
# Copies deploy/prometheus/alerts.yaml (source of truth) into the Helm chart,
# which can only read files inside its own directory.
#
#   deploy/scripts/sync-alerts.sh          copy
#   deploy/scripts/sync-alerts.sh --check  exit 1 if the copy is stale (CI)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
src="$root/deploy/prometheus/alerts.yaml"
dst="$root/deploy/helm/reviewsignal/files/alerts.yaml"

if [[ "${1:-}" == "--check" ]]; then
  if ! cmp -s "$src" "$dst"; then
    echo "deploy/helm/reviewsignal/files/alerts.yaml is out of date; run deploy/scripts/sync-alerts.sh" >&2
    exit 1
  fi
  echo "alerts in sync"
  exit 0
fi

mkdir -p "$(dirname "$dst")"
cp "$src" "$dst"
echo "copied $src -> $dst"
