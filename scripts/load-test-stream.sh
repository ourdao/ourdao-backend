#!/usr/bin/env bash
# scripts/load-test-stream.sh — shell wrapper for the SSE stream load test.
#
# Issue #295: verifies GET /api/stream stability under 1000 concurrent clients.
#
# Usage:
#   ./scripts/load-test-stream.sh
#   CONCURRENT_CLIENTS=500 ./scripts/load-test-stream.sh
#   NOTIFICATION_ROUNDS=50 CONCURRENT_CLIENTS=200 ./scripts/load-test-stream.sh
#
# Environment variables (all optional — defaults shown):
#   CONCURRENT_CLIENTS=1000   Number of simultaneous SSE connections to open.
#   NOTIFICATION_ROUNDS=100   Number of NOTIFY broadcast rounds.
#   MEM_GROWTH_LIMIT_MB=100   Max RSS growth (MiB) before the test fails.
#   DATABASE_URL              Postgres connection string (falls back to
#                             individual PG* vars; must NOT be the test database).
#
# The script:
#   1. Checks that DATABASE_URL (or PG* vars) is set.
#   2. Raises STREAM_MAX_CONNECTIONS above the client count so the test can
#      open connections freely (the TS script also overrides the in-process
#      value — this env var covers the config-load path).
#   3. Runs the TypeScript load test via tsx.
#   4. Exits with code 0 on pass, 1 on any failed assertion.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

# --- Defaults ----------------------------------------------------------------
CONCURRENT_CLIENTS="${CONCURRENT_CLIENTS:-1000}"
NOTIFICATION_ROUNDS="${NOTIFICATION_ROUNDS:-100}"
MEM_GROWTH_LIMIT_MB="${MEM_GROWTH_LIMIT_MB:-100}"

# --- Pre-flight: require a database connection -------------------------------
if [[ -z "${DATABASE_URL:-}" ]] && [[ -z "${PGHOST:-}" ]]; then
  echo "[load-test-stream] ERROR: DATABASE_URL or PGHOST must be set." >&2
  echo "  Example: DATABASE_URL=postgres://ourdao:ourdao@localhost:5432/ourdao \\" >&2
  echo "    ./scripts/load-test-stream.sh" >&2
  exit 1
fi

# Warn when it looks like the test database is being used.
if echo "${DATABASE_URL:-}" | grep -q "_test"; then
  echo "[load-test-stream] WARNING: DATABASE_URL contains '_test' — are you sure" >&2
  echo "  you want to run the load test against the test database?" >&2
fi

# --- Raise the stream connection cap for the run ----------------------------
# The TS script overrides the in-process streamLimits directly, but
# STREAM_MAX_CONNECTIONS affects the config object read at module import —
# exporting a value above the client count ensures the two paths agree.
export STREAM_MAX_CONNECTIONS=$(( CONCURRENT_CLIENTS + 100 ))
export STREAM_MAX_CONNECTIONS_PER_IP=$(( CONCURRENT_CLIENTS + 100 ))

# --- Pass through tuning variables to the TS script -------------------------
export CONCURRENT_CLIENTS
export NOTIFICATION_ROUNDS
export MEM_GROWTH_LIMIT_MB

echo "[load-test-stream] Starting SSE stream load test"
echo "  CONCURRENT_CLIENTS  = ${CONCURRENT_CLIENTS}"
echo "  NOTIFICATION_ROUNDS = ${NOTIFICATION_ROUNDS}"
echo "  MEM_GROWTH_LIMIT_MB = ${MEM_GROWTH_LIMIT_MB}"
echo ""

# tsx executes the TypeScript directly — no compile step needed.
exec npx tsx scripts/load-test-stream.ts
