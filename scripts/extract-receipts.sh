#!/usr/bin/env bash
# Extract the three Arena submission identifiers from SUBMISSION_EVIDENCE.md.
set -e
cd "$(dirname "$0")/.."
F=SUBMISSION_EVIDENCE.md

TRIGGER_TX=$(grep 'Trend trigger' "$F" | grep -oE '[0-9a-fA-F]{64}' | head -n 1)
DEPLOY_TX=$(grep 'TrendAnchor deploy tx' "$F" | grep -oE '\b0x[0-9a-fA-F]{64}\b' | head -n 1)
CONTRACT=$(grep -oE '\b0x[0-9a-fA-F]{40}\b' <(grep 'TrendAnchor' "$F") | head -n 1)

echo "trigger_tx     = 0x$TRIGGER_TX"
echo "deploy_tx      = $DEPLOY_TX"
echo "anchor_address = $CONTRACT"
echo
echo "lengths: trigger=0x+${#TRIGGER_TX}  deploy=${#DEPLOY_TX} (expect 66)  contract=${#CONTRACT} (expect 42)"
