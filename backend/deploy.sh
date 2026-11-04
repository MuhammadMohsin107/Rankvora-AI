#!/usr/bin/env bash
#
# Deploys the API on a Node server (the pre-Cloudflare setup; the database is a SQLite file,
# DATABASE_PATH). Run it from the backend directory:
#
#   cd ~/scorelo-api && bash deploy.sh
#
# Safe to re-run: it never overwrites .env, and refuses to start on a bad config
# rather than leaving a half-deployed API answering requests.
set -euo pipefail

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

cd "$(dirname "$0")"

# ─── 1. Toolchain ─────────────────────────────────────────────────────────────
say "Checking Node.js"
command -v node >/dev/null || fail "node is not installed."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
# The database is Node's built-in SQLite (node:sqlite), which needs no flag from Node 22.13.
{ [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 13 ]; }; } \
  || fail "Node 22.13+ required (built-in SQLite), found $(node -v)."
echo "Node $(node -v)"

# ─── 2. Config ────────────────────────────────────────────────────────────────
# Checked BEFORE building: a missing secret should fail in seconds, not after a
# full install and migration run.
say "Checking .env"
[ -f .env ] || fail ".env not found. Create it from .env.example — see README 'CloudPanel' section."

missing=()
for key in DATABASE_PATH JWT_ACCESS_SECRET JWT_REFRESH_SECRET TOKEN_ENCRYPTION_KEY BACKEND_URL FRONTEND_URL; do
  value=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)
  [ -n "$value" ] || missing+=("$key")
done
[ ${#missing[@]} -eq 0 ] || fail "Empty or missing in .env: ${missing[*]}"

grep -qE '^NODE_ENV=production' .env || fail "NODE_ENV must be 'production' in .env."
# mockAuthEnabled would authenticate every caller as user 1 — never in production.
grep -qE '^MOCK_AUTH=true' .env && fail "MOCK_AUTH must be false in production."
grep -qE '^(BACKEND_URL|FRONTEND_URL)=https?://(localhost|127\.0\.0\.1)' .env \
  && fail "BACKEND_URL/FRONTEND_URL still point at localhost. Set them to the public site URL."
echo "Config OK"

# ─── 3. Build ─────────────────────────────────────────────────────────────────
say "Installing dependencies"
npm ci

say "Building"
npm run build

say "Running migrations"
npm run db:migrate

# ─── 4. Start ─────────────────────────────────────────────────────────────────
# The API binds loopback only; TLS and public routing are the edge proxy's job.
PORT=$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- || echo 5000)
PORT=${PORT:-5000}

say "Starting API on 127.0.0.1:$PORT"
if command -v pm2 >/dev/null; then
  pm2 describe scorelo-api >/dev/null 2>&1 \
    && pm2 restart scorelo-api --update-env \
    || pm2 start dist/server.js --name scorelo-api
  pm2 save
else
  echo "pm2 not found — start dist/server.js under your process manager, then re-run the check below."
fi

# ─── 5. Verify ────────────────────────────────────────────────────────────────
say "Verifying"
sleep 3
health=$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
[ -n "$health" ] || fail "No response from http://127.0.0.1:$PORT/api/health — check 'pm2 logs scorelo-api'."
echo "$health"
case "$health" in
  *'"database":"connected"'*) ;;
  *) fail "API is up but the database is unreachable. Check DATABASE_PATH." ;;
esac

printf '\n\033[32mAPI deployed.\033[0m Next: rebuild the frontend with VITE_API_BASE_URL unset,\n'
printf 'upload dist/ AND server.cjs, restart the app, then confirm:\n'
printf '  curl https://YOUR-DOMAIN/api/health   # must return JSON, not HTML\n\n'
