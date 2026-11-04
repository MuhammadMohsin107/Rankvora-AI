#!/usr/bin/env bash
#
# Read-only deployment check. Changes nothing — safe to run any time, on the server
# or locally. Walks the whole chain: code -> config -> database -> API -> public URL,
# in that order, because each link only makes sense once the one before it holds.
#
#   bash backend/verify.sh
#
# Run from the repo root or the backend directory; it finds its own way.

cd "$(dirname "$0")/.." || exit 1

PUBLIC_URL="${PUBLIC_URL:-https://scorelo-staging.tlxapps.com}"
pass() { printf '   \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '   \033[31mFAIL\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }
warn() { printf '   \033[33mWARN\033[0m %s\n' "$1"; }
head2() { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }
FAILED=0

printf '\033[1m═══ Rankvora AI deployment check ═══\033[0m\n'
echo "repo: $(pwd)"

# ─── 1. Code ──────────────────────────────────────────────────────────────────
head2 "1. CODE"
git fetch -q origin 2>/dev/null
LOCAL=$(git rev-parse --short HEAD 2>/dev/null)
ORIGIN=$(git rev-parse --short origin/main 2>/dev/null)
echo "   HEAD=$LOCAL  origin/main=$ORIGIN"
if [ "$LOCAL" = "$ORIGIN" ]; then pass "up to date with origin/main"; else fail "behind origin — run: git pull"; fi
# The D1 (SQLite) migration only exists in the Cloudflare code, so it proves which code is deployed.
ls backend/drizzle-d1/*.sql >/dev/null 2>&1 && pass "D1 migration present ($(ls backend/drizzle-d1/*.sql | wc -l) file)" || fail "no D1 migration files — this is not the Cloudflare code"
grep -q '"mysql2"' backend/package.json && fail "mysql2 still in package.json" || pass "MySQL driver removed"

# ─── 2. Config ────────────────────────────────────────────────────────────────
head2 "2. BACKEND .env"
ENV_FILE="$(pwd)/backend/.env"
if [ -f backend/.env ]; then
  pass "exists at $ENV_FILE"
  [ -n "$(grep '^DATABASE_PATH=' backend/.env | cut -d= -f2-)" ] && pass "DATABASE_PATH set" \
    || fail "DATABASE_PATH is empty or missing (the SQLite file the API opens)"
  grep -q '^NODE_ENV=production' backend/.env && pass "NODE_ENV=production" || fail "NODE_ENV must be production"
  # mockAuthEnabled authenticates EVERY caller as user 1 — never acceptable in production.
  grep -q '^MOCK_AUTH=false' backend/.env && pass "MOCK_AUTH=false" || fail "MOCK_AUTH must be false"
  for key in JWT_ACCESS_SECRET JWT_REFRESH_SECRET TOKEN_ENCRYPTION_KEY; do
    [ -n "$(grep "^${key}=" backend/.env | cut -d= -f2-)" ] && pass "$key set" || fail "$key is empty"
  done
  grep -qE '^(BACKEND_URL|FRONTEND_URL)=https?://(localhost|127\.)' backend/.env \
    && fail "BACKEND_URL/FRONTEND_URL still point at localhost" || pass "public URLs configured"
else
  fail "backend/.env MISSING — create it at $ENV_FILE"
fi
# The frontend must NOT have one: VITE_* is baked in at build time, so a wrong value
# there cannot be corrected on the server and silently breaks every API call.
[ -f frontend/.env ] && warn "frontend/.env exists — it should not; VITE_API_BASE_URL must stay unset" \
  || pass "no frontend/.env (correct — frontend calls same-origin /api)"

# ─── 3. Database ──────────────────────────────────────────────────────────────
head2 "3. DATABASE"
# Counted straight from the SQLite file with Node's built-in sqlite, read-only. A relative
# DATABASE_PATH is relative to backend/, where the API runs.
EXPECTED_TABLES=20
DBFILE=$(grep '^DATABASE_PATH=' backend/.env 2>/dev/null | cut -d= -f2-)
case "$DBFILE" in /*|?:*) ;; *) DBFILE="backend/$DBFILE" ;; esac
if [ -z "$DBFILE" ] || [ "$DBFILE" = "backend/" ]; then
  warn "DATABASE_PATH not set — relying on the API health check below"
elif [ ! -f "$DBFILE" ]; then
  fail "database file not found at $DBFILE — run: bash backend/deploy.sh"
else
  TABLES=$(node -e "
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const names = db.prepare(\"select name from sqlite_master where type = 'table'\").all().map((row) => row.name);
  console.log(names.filter((name) => !name.startsWith('sqlite_') && !name.startsWith('__drizzle')).length);
} catch (error) { console.log('error: ' + error.message); }
" "$DBFILE" 2>/dev/null)
  case "$TABLES" in
    "$EXPECTED_TABLES") pass "opened read-only — all $EXPECTED_TABLES tables present in $DBFILE" ;;
    0)                 fail "database opens but has 0 tables — migration has not run (bash backend/deploy.sh)" ;;
    error*|'')         fail "cannot open $DBFILE as SQLite (${TABLES:-no answer}) — needs Node 22.13+" ;;
    *)                 warn "$TABLES tables (expected $EXPECTED_TABLES) — migration may be incomplete" ;;
  esac
fi

# ─── 4. API process ───────────────────────────────────────────────────────────
head2 "4. API (127.0.0.1:5000)"
LOCAL_HEALTH=$(curl -fsS -m 10 http://127.0.0.1:5000/api/health 2>/dev/null)
case "$LOCAL_HEALTH" in
  *'"database":"connected"'*) pass "API up and database reachable: $LOCAL_HEALTH" ;;
  *'"database"'*)             fail "API up but DB unreachable: $LOCAL_HEALTH" ;;
  *)                          fail "no response — is it running? (pm2 logs scorelo-api)" ;;
esac

# ─── 5. Public URL ────────────────────────────────────────────────────────────
head2 "5. PUBLIC ($PUBLIC_URL)"
PUB=$(curl -fsS -m 20 "$PUBLIC_URL/api/health" 2>/dev/null)
case "$PUB" in
  *'"database":"connected"'*) pass "/api reaches the API through nginx + server.cjs" ;;
  *'<!DOCTYPE'*|*'<html'*)    fail "/api returns HTML — the SPA is swallowing it. Upload the updated frontend/server.cjs and restart the Node app" ;;
  *)                          fail "unexpected response: ${PUB:-<empty>}" ;;
esac

# Sign-in is Shopify only. The Shopify start endpoint must answer (400/422: it validated the empty
# body), and the old email sign-in and two-factor routes must be gone (404).
CODE=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -X POST "$PUBLIC_URL/api/auth/shopify/start" \
  -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
case "$CODE" in
  400|422) pass "Shopify sign-in endpoint reachable (HTTP $CODE — validation rejected the empty body, as expected)" ;;
  405)     fail "Shopify sign-in returns 405 — old server.cjs without the /api proxy is still deployed" ;;
  404)     fail "Shopify sign-in returns 404 — an older API is deployed" ;;
  *)       fail "Shopify sign-in returned HTTP $CODE" ;;
esac
for OLD in /api/auth/signup /api/auth/login /api/auth/login/2fa; do
  OLDCODE=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -X POST "$PUBLIC_URL$OLD" -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
  [ "$OLDCODE" = "404" ] && pass "$OLD is gone (HTTP 404)" || fail "$OLD answers HTTP $OLDCODE — it should be gone (an older API is deployed)"
done

# ─── Verdict ──────────────────────────────────────────────────────────────────
if [ "$FAILED" -eq 0 ]; then
  printf '\n\033[32m═══ ALL CHECKS PASSED ═══\033[0m\n\n'
else
  printf '\n\033[31m═══ %s CHECK(S) FAILED ═══\033[0m see the FAIL lines above\n\n' "$FAILED"
  exit 1
fi
