#!/usr/bin/env bash
# Installs the masumi-agent-messenger CLI globally via npm.
# Run this once before using the masumi-agent-messenger skill.

set -euo pipefail

if command -v masumi-agent-messenger &>/dev/null; then
  echo "masumi-agent-messenger already installed: $(masumi-agent-messenger --version 2>/dev/null || echo 'ok')"
  exit 0
fi

echo "Installing masumi-agent-messenger..."
npm install -g @masumi_network/masumi-agent-messenger

echo "Done. Run 'masumi-agent-messenger --help' to verify."
