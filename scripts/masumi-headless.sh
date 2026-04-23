#!/usr/bin/env bash
# Headless wrapper for masumi-agent-messenger CLI
# Usage: ./masumi-headless.sh [command] [args...]
# Example: ./masumi-headless.sh inbox peek --json
# Example: ./masumi-headless.sh inbox send patrick-nmkr-io "hello" --json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
CLI_DIR="${SCRIPT_DIR}/../cli"

# Ensure we use the file backend (no keyring dependency)
export MASUMI_FORCE_FILE_BACKEND=1

# Use the CLI entry point (dist/bin.js), NOT dist/index.js
exec node "${CLI_DIR}/dist/bin.js" "$@"
