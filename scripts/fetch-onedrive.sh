#!/usr/bin/env bash
# Download the latest Excel file from a OneDrive "anyone with the link can view" URL,
# fully anonymously (no Microsoft login). Works for SharePoint-migrated personal files
# by walking the 1drv.ms "redeem" flow with a cookie jar, then requesting ?download=1.
#
# Usage: GEO_SHEET_URL='https://1drv.ms/x/...' bash scripts/fetch-onedrive.sh
# Writes: data/source.xlsx
set -euo pipefail

URL="${GEO_SHEET_URL:?set GEO_SHEET_URL to the OneDrive share link}"
OUT="${1:-data/source.xlsx}"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

mkdir -p "$(dirname "$OUT")"

# 1) Walk the redeem redirect chain to collect the anonymous-session cookie.
curl -s -c "$JAR" -b "$JAR" -L -A "$UA" --max-time 60 -o /dev/null "$URL"

# 2) Download the raw file using that session.
code=$(curl -s -b "$JAR" -c "$JAR" -L -A "$UA" --max-time 60 \
  -o "$OUT" -w '%{http_code}' "${URL}?download=1")

# 3) Validate: must be a real xlsx (zip magic "PK"), not an HTML sign-in page.
if [ "$code" != "200" ] || [ "$(head -c 2 "$OUT")" != "PK" ]; then
  echo "ERROR: download failed (http $code, not an xlsx)." >&2
  head -c 300 "$OUT" >&2; echo >&2
  exit 1
fi
echo "Downloaded $(wc -c < "$OUT") bytes -> $OUT"
