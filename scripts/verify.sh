#!/usr/bin/env bash
# OSAS release-quality gate (milestone 0): typecheck, unit/contract tests,
# compat suite, Docker build + boot, health checks, Playwright E2E.
# Docker is ALWAYS torn down at the end (trap on EXIT), green or red.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$*"; }

cleanup() {
  step "docker compose down (cleanup)"
  docker compose down --remove-orphans || true
}
trap cleanup EXIT

step "typecheck"
pnpm typecheck

step "unit / contract tests"
pnpm test

step "compat suite (regenerates tests/compat/report/latest.json)"
pnpm test:compat

step "docker compose build (API image regenerates the compat report at build time)"
docker compose build

step "docker compose up -d"
docker compose up -d

wait_for() {
  local name="$1" url="$2" i
  for i in $(seq 1 60); do
    if curl -fsS "$url" > /dev/null 2>&1; then
      echo "    ok: $name ($url)"
      return 0
    fi
    sleep 2
  done
  echo "ERROR: $name did not become healthy at $url" >&2
  docker compose logs >&2 || true
  return 1
}

step "health checks"
wait_for "API /health" "http://localhost:3001/health"
wait_for "Web /health (nginx -> API proxy)" "http://localhost:8080/health"
wait_for "Web /healthz (static nginx)" "http://localhost:8080/healthz"

step "compat report is served from the image build"
report="$(curl -fsS http://localhost:3001/v1/compat/report)"
echo "$report" | grep -Eq '"specVersion": *"0\.1"'
echo "$report" | grep -Eq '"ok": *true'
echo "    ok: /v1/compat/report returns a green report generated during this build"

step "playwright e2e against the docker stack (E2E_BASE_URL=http://localhost:8080)"
pnpm --filter @osas/e2e exec playwright install chromium
E2E=1 E2E_BASE_URL=http://localhost:8080 pnpm test:e2e

step "VERIFY PASSED"
