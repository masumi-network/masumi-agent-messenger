#!/usr/bin/env bash
# Setup script for masumi-agent-messenger inbox monitoring
# Usage: ./masumi-monitor-setup.sh [--interval <minutes>] [--profile <name>]
#
# This script creates a cron job that periodically checks your masumi inbox
# and reports new messages. Designed for automated agents.

set -euo pipefail

INTERVAL_MINUTES=5
PROFILE="default"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="${SCRIPT_DIR}/../cli"
CRON_TAG="# masumi-inbox-monitor"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      INTERVAL_MINUTES="$2"
      shift 2
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--interval <minutes>] [--profile <name>]"
      exit 1
      ;;
  esac
done

# Validate interval
if ! [[ "$INTERVAL_MINUTES" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_MINUTES" -lt 1 ]]; then
  echo "Error: interval must be a positive integer (minutes)"
  exit 1
fi

# Determine cron schedule
if [[ "$INTERVAL_MINUTES" -eq 1 ]]; then
  SCHEDULE="* * * * *"
elif [[ "$INTERVAL_MINUTES" -lt 60 ]]; then
  SCHEDULE="*/${INTERVAL_MINUTES} * * * *"
else
  HOURS=$((INTERVAL_MINUTES / 60))
  if [[ "$HOURS" -eq 1 ]]; then
    SCHEDULE="0 * * * *"
  else
    SCHEDULE="0 */${HOURS} * * *"
  fi
fi

# Build the cron command
CRON_CMD="${SCHEDULE} MASUMI_FORCE_FILE_BACKEND=1 ${CLI_DIR}/dist/bin.js inbox peek --profile ${PROFILE} --json >> ${HOME}/.local/share/masumi-monitor.log 2>&1"

# Check if already installed
if crontab -l 2>/dev/null | grep -qF "$CRON_TAG"; then
  echo "Monitor already installed. Updating..."
  # Remove old entry
  crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab -
fi

# Add new entry
(crontab -l 2>/dev/null || true; echo "$CRON_TAG"; echo "$CRON_CMD") | crontab -

echo "✅ Masumi inbox monitor installed"
echo "   Schedule: every ${INTERVAL_MINUTES} minute(s)"
echo "   Profile:  ${PROFILE}"
echo "   Log:      ${HOME}/.local/share/masumi-monitor.log"
echo ""
echo "To verify:  crontab -l | grep masumi"
echo "To remove:  crontab -l | grep -v masumi | crontab -"
