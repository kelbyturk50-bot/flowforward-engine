#!/usr/bin/env bash
# Read-only CORS check for the public chat and flags routes.
# Usage: scripts/check-public-cors.sh <api-origin> <production-crm-origin>
# The CRM origin must be one of the three production origins in
# src/chatdemo/cors.js. A Vercel preview origin is refused.
# Exits non-zero when Access-Control-Allow-Origin is missing or is not that
# exact origin, when Vary is not Origin, when Access-Control-Allow-Credentials
# is true, or when the chat preflight methods or headers differ from the
# allowlist in src/chatdemo/cors.js. A preview origin is refused.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: scripts/check-public-cors.sh <api-origin> <production-crm-origin>" >&2
  exit 2
fi

API="${1%/}"
CRM="${2%/}"

case "$API$CRM" in
  *@*)
    echo "refusing a URL with userinfo" >&2
    exit 2
    ;;
esac

case "$API" in
  http://*|https://*) ;;
  *)
    echo "api origin must be http or https" >&2
    exit 2
    ;;
esac

case "$CRM" in
  https://flowforward-engine-six.vercel.app|\
  https://flowforward-engine-turk11.vercel.app|\
  https://flowforward-engine-git-main-turk11.vercel.app)
    ;;
  *)
    echo "crm origin must be one of the three production CRM origins" >&2
    exit 2
    ;;
esac

header_value() {
  local name="$1"
  local file="$2"
  awk -v name="$name" '
    BEGIN { want = tolower(name) }
    {
      line = $0
      sub(/\r$/, "", line)
      split(line, parts, ":")
      key = tolower(parts[1])
      if (key == want) {
        sub(/^[^:]*:[[:space:]]*/, "", line)
        value = line
      }
    }
    END { print value }
  ' "$file"
}

check_cors() {
  local label="$1"
  local file="$2"
  local allow creds
  allow="$(header_value 'access-control-allow-origin' "$file")"
  if [[ "$allow" != "$CRM" ]]; then
    echo "$label: Access-Control-Allow-Origin is '${allow:-missing}', expected the CRM origin" >&2
    exit 1
  fi
  creds="$(header_value 'access-control-allow-credentials' "$file")"
  creds="$(printf '%s' "$creds" | tr '[:upper:]' '[:lower:]')"
  if [[ "$creds" == "true" ]]; then
    echo "$label: Access-Control-Allow-Credentials is true" >&2
    exit 1
  fi
}

expect_header() {
  local label="$1"
  local file="$2"
  local name="$3"
  local want="$4"
  local got
  got="$(header_value "$name" "$file")"
  if [[ "$got" != "$want" ]]; then
    echo "$label: $name is '${got:-missing}', expected '$want'" >&2
    exit 1
  fi
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

curl -sS -D "$tmp" -o /dev/null \
  -H "Origin: $CRM" \
  -H "Accept: application/json" \
  --max-time 20 \
  "$API/api/public/flags" >/dev/null
check_cors "GET /api/public/flags" "$tmp"
expect_header "GET /api/public/flags" "$tmp" 'vary' 'Origin'

: > "$tmp"
curl -sS -D "$tmp" -o /dev/null -X OPTIONS \
  -H "Origin: $CRM" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  --max-time 20 \
  "$API/api/public/chat/demos" >/dev/null
check_cors "OPTIONS /api/public/chat/demos" "$tmp"
expect_header "OPTIONS /api/public/chat/demos" "$tmp" 'vary' 'Origin'
expect_header "OPTIONS /api/public/chat/demos" "$tmp" 'access-control-allow-methods' 'POST, OPTIONS'
expect_header "OPTIONS /api/public/chat/demos" "$tmp" 'access-control-allow-headers' 'Content-Type'

echo "public CORS ok"
