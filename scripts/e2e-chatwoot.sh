#!/usr/bin/env bash
# Real-Chatwoot end-to-end check for the OSAS shadow loop.
# Needs docker (pulls ~4 GB), openssl, python3, curl and pnpm. NOT part of `pnpm test` or CI.
# Everything lives in a temp dir that is removed on exit; secrets are random per run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/e2e-chatwoot"
WORK="$(mktemp -d)"
OSAS_PORT="${E2E_OSAS_PORT:-3001}"
OSAS_PID=""
PASS=0
FAIL=0

cleanup() {
  [ -n "$OSAS_PID" ] && kill "$OSAS_PID" 2>/dev/null || true
  pkill -f "$SRC/harness.mts" 2>/dev/null || true
  (cd "$WORK" && docker compose down -v >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "PASS  $1"; else FAIL=$((FAIL + 1)); echo "FAIL  $1 (expected '$2', got '$3')"; fi
}

for bin in docker openssl python3 curl pnpm; do command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 2; }; done
for p in 3000 "$OSAS_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is already in use"; exit 2; fi
done

PG_PASS="$(openssl rand -hex 16)"
REDIS_PASS="$(openssl rand -hex 16)"
WEBHOOK_SECRET="$(openssl rand -hex 16)"
export E2E_PG_PASSWORD="$PG_PASS"
cp "$SRC/compose.yaml" "$SRC/seed.rb" "$SRC/hook.rb" "$WORK/"
cat > "$WORK/.env" <<ENV
SECRET_KEY_BASE=$(openssl rand -hex 64)
FRONTEND_URL=http://localhost:3000
RAILS_ENV=production
NODE_ENV=production
INSTALLATION_ENV=docker
POSTGRES_HOST=postgres
POSTGRES_USERNAME=postgres
POSTGRES_PASSWORD=$PG_PASS
POSTGRES_DATABASE=chatwoot_production
REDIS_URL=redis://:$REDIS_PASS@redis:6379
REDIS_PASSWORD=$REDIS_PASS
ENABLE_ACCOUNT_SIGNUP=true
SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true
ENV
chmod 600 "$WORK/.env"
cd "$WORK"

echo "== starting Chatwoot"
docker compose up -d postgres redis >/dev/null 2>&1
docker compose run --rm rails bundle exec rails db:chatwoot_prepare >"$WORK/prepare.log" 2>&1
docker compose up -d rails sidekiq >/dev/null 2>&1
code=000
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://localhost:3000/api || true)"
  [ "$code" = "200" ] && break
  sleep 5
done
check "chatwoot api reachable" 200 "$code"
[ "$code" = "200" ] || exit 1

rb() { docker compose exec -T "$@" 2>&1; }
SEED="$(rb rails bundle exec rails runner "$(cat "$WORK/seed.rb")")"
ACCOUNT_ID="$(echo "$SEED" | sed -n 's/^SEED_ACCOUNT_ID=//p')"
TOKEN="$(echo "$SEED" | sed -n 's/^SEED_TOKEN=//p')"
[ -n "$ACCOUNT_ID" ] && [ -n "$TOKEN" ] || { echo "seed failed"; exit 1; }
echo "== chatwoot seeded (account $ACCOUNT_ID)"

echo "== starting OSAS"
CONN_FILE="$WORK/conn.id"
(
  cd "$ROOT"
  E2E_WEBHOOK_SECRET="$WEBHOOK_SECRET" E2E_CONN_FILE="$CONN_FILE" E2E_OSAS_PORT="$OSAS_PORT" \
  CHATWOOT_BASE_URL=http://localhost:3000 CHATWOOT_ACCOUNT_ID="$ACCOUNT_ID" CHATWOOT_API_TOKEN="$TOKEN" \
  OSAS_GOVERNANCE_EVENT_CONSUMER=chatwoot-shadow OSAS_GOVERNANCE_WORKER_INTERVAL_MS=500 NODE_ENV=development \
  exec pnpm --filter @osas/api exec tsx "$SRC/harness.mts" >"$WORK/osas.log" 2>&1
) &
OSAS_PID=$!
for _ in $(seq 1 40); do [ -s "$CONN_FILE" ] && break; sleep 2; done
CONN="$(cat "$CONN_FILE" 2>/dev/null || true)"
[ -n "$CONN" ] || { echo "OSAS did not start:"; grep -v '^\s*at ' "$WORK/osas.log" | head -15; exit 1; }
check "osas health" ok "$(curl -s -m 3 "http://127.0.0.1:$OSAS_PORT/health" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')"

# host.docker.internal can resolve to an IPv6 address, but OSAS listens on 127.0.0.1 (IPv4 only);
# that made delivery flaky. Pin the IPv4 address the container sees for the host.
HOST_V4="$(rb rails getent ahostsv4 host.docker.internal | awk 'NR==1{print $1}')"
case "$HOST_V4" in
  *[!0-9.]*|"") echo "could not resolve an IPv4 address for host.docker.internal"; exit 1 ;;
esac
HOOK_URL="http://$HOST_V4:$OSAS_PORT/v1/webhooks/chatwoot/tenant_demo/$CONN"
HOOK="$(rb -e "E2E_HOOK_URL=$HOOK_URL" -e "E2E_HOOK_SECRET=$WEBHOOK_SECRET" rails bundle exec rails runner "$(cat "$WORK/hook.rb")")"
check "account webhook created" true "$(echo "$HOOK" | sed -n 's/.*SECRET_MATCHES=//p')"

H="api_access_token: $TOKEN"
B="http://localhost:3000/api/v1/accounts/$ACCOUNT_ID"
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
C="$(curl -s -m 20 -X POST "$B/contacts" -H "$H" -H 'content-type: application/json' \
  -d '{"inbox_id":1,"name":"E2E Customer","email":"e2e-customer@example.com"}')"
CID="$(echo "$C" | json 'd["payload"]["contact"]["id"]')"
SRC_ID="$(echo "$C" | json 'd["payload"]["contact_inbox"]["source_id"]')"
CV="$(curl -s -m 20 -X POST "$B/conversations" -H "$H" -H 'content-type: application/json' \
  -d "{\"source_id\":\"$SRC_ID\",\"inbox_id\":1,\"contact_id\":$CID}" | json 'd["id"]')"
curl -s -m 20 -o /dev/null -X POST "$B/conversations/$CV/messages" -H "$H" -H 'content-type: application/json' \
  -d '{"content":"I want a refund for ord_1 please, $20","message_type":"incoming","private":false}'

echo "== waiting for the private note"
NOTE=""
for _ in $(seq 1 30); do
  NOTE="$(curl -s -m 10 "$B/conversations/$CV/messages" -H "$H" | json \
    '"\n".join(m["content"] for m in d["payload"] if m["private"] and "[OSAS shadow]" in (m["content"] or ""))')"
  [ -n "$NOTE" ] && break
  sleep 2
done
if [ -z "$NOTE" ]; then
  echo "-- diagnostics (no note appeared)"
  G="http://127.0.0.1:$OSAS_PORT/v1/governance"
  for path in integration-events jobs; do
    echo "[$path]"
    curl -s -m 5 "$G/$path" -H 'x-osas-role: policy_admin' -H 'x-tenant-id: tenant_demo' | cut -c1-1200
    echo
  done
  echo "[osas.log: errors/warnings]"
  grep -E '"level":(40|50)' "$WORK/osas.log" | cut -c1-400 | tail -8
  echo "[osas.log: webhook requests]"
  grep -c '/v1/webhooks/chatwoot' "$WORK/osas.log" || true
  echo "[sidekiq: webhook jobs]"
  docker compose logs --no-log-prefix sidekiq 2>&1 | grep -E 'WebhookJob|Webhooks::|SafeFetch|Net::|refused|blocked' | cut -c1-300 | tail -8
  echo "[sidekiq: last lines]"
  docker compose logs --no-log-prefix --tail 5 sidekiq 2>&1 | cut -c1-200
  echo "[redis queue sizes]"
  docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning llen queue:medium; redis-cli -a "$REDIS_PASSWORD" --no-auth-warning llen queue:critical' 2>&1
  echo "[chatwoot messages]"
  curl -s -m 10 "$B/conversations/$CV/messages" -H "$H" | cut -c1-600
  echo
fi
check "private shadow note written" yes "$([ -n "$NOTE" ] && echo yes || echo no)"
check "note says nothing executed" yes "$(echo "$NOTE" | grep -q 'nothing has been executed' && echo yes || echo no)"
check "note has no customer text" no "$(echo "$NOTE" | grep -q -i -E 'e2e-customer@|I want a refund' && echo yes || echo no)"
sleep 3
check "exactly one private note, no loop" 1 \
  "$(curl -s -m 10 "$B/conversations/$CV/messages" -H "$H" | json 'sum(1 for m in d["payload"] if m["private"])')"

echo "== forged requests against the live endpoint"
URL="http://127.0.0.1:$OSAS_PORT/v1/webhooks/chatwoot/tenant_demo/$CONN"
BODY="{\"event\":\"message_created\",\"id\":9001,\"message_type\":\"incoming\",\"private\":false,\"conversation\":{\"id\":$CV},\"account\":{\"id\":$ACCOUNT_ID},\"created_at\":\"2099-01-01T00:00:00Z\"}"
TS="$(date +%s)"
check "wrong signature -> 401" 401 "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$URL" -H 'content-type: application/json' \
  -H "x-chatwoot-timestamp: $TS" -H "x-chatwoot-signature: sha256=$(printf 'a%.0s' $(seq 1 64))" -d "$BODY")"
check "missing signature -> 401" 401 "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$URL" -H 'content-type: application/json' -d "$BODY")"
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')"
post() { curl -s -m 5 -X POST "$URL" -H 'content-type: application/json' -H "x-chatwoot-timestamp: $TS" \
  -H "x-chatwoot-signature: $SIG" -H 'x-chatwoot-delivery: e2e-replay-1' -d "$BODY" | json 'd["outcome"]'; }
check "correct signature accepted" accepted "$(post)"
check "replayed delivery is a duplicate" duplicate "$(post)"

echo
echo "result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
