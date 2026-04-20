#!/usr/bin/env bash
# Installs or refreshes the masumi-agent-messenger CLI globally via npm.
# Run this once before using the masumi-agent-messenger skill.

set -euo pipefail

npm_global_prefix="$(npm prefix --global)"
npm_global_bin="${npm_global_prefix}/bin"
npm_bin_path="${npm_global_bin}/masumi-agent-messenger"
previous_path="$(command -v masumi-agent-messenger || true)"

if [[ -n "$previous_path" ]]; then
  echo "Found existing masumi-agent-messenger at: $previous_path"
  echo "Refreshing it so PATH does not keep using an older install..."
else
  echo "Installing masumi-agent-messenger..."
fi

npm install --global @masumi_network/masumi-agent-messenger
hash -r 2>/dev/null || true

current_path="$(command -v masumi-agent-messenger || true)"
if [[ -z "$current_path" ]]; then
  echo "Installed package, but masumi-agent-messenger is not on PATH." >&2
  echo "Add the npm global bin directory to PATH: $npm_global_bin" >&2
  exit 1
fi

if [[ "$current_path" != "$npm_bin_path" && -x "$npm_bin_path" ]]; then
  echo "Installed package at $npm_bin_path, but PATH resolves $current_path first." >&2
  echo "Move $npm_global_bin before $(dirname "$current_path") in PATH, then re-run this script." >&2
  exit 1
fi

echo "Done. Using masumi-agent-messenger at: $current_path"
masumi-agent-messenger --version
