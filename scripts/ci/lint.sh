#!/usr/bin/env bash
set -euo pipefail
echo "=== TypeScript check ==="
bunx tsc --noEmit

if command -v shellcheck &>/dev/null; then
  echo "=== ShellCheck ==="
  shellcheck scripts/ci/*.sh
fi
