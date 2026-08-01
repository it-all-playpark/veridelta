#!/usr/bin/env bash
# Kill-1 base rate 計測（0b-field / 設計 doc §7）
#
# shift-bud repo の scripts/e2e-local.sh の環境準備を踏襲しつつ、
# テスト実行を N 回ループに差し替える。
# 各 run の JSON reporter 出力を $TMPDIR/kill1-runs に保存し、集計は analyze.mjs が行う。
#
# 使い方:
#   SHIFT_BUD_REPO=<path> bash measure.sh 1      # 試走（1回）
#   SHIFT_BUD_REPO=<path> bash measure.sh 10     # Kill-1 本番（N=10）
#
# 要件: Docker（DB 起動）、pnpm、shift-bud repo のチェックアウト。
#
# retries は設計 doc §7 が「retries:2 強制で N 回連続実行」と定めるため 2 に固定する。
# ローカル既定は retries:0 なので明示指定が必須 — これを怠ると flaky が構造的に一度も
# 観測されず「問題なし」と誤結論する（0b-core README が事前登録した罠）。
set -uo pipefail

N="${1:-1}"
# 計測時の実測値。別マシンでは SHIFT_BUD_REPO で上書きする。
REPO="${SHIFT_BUD_REPO:-/Users/naramotoyuuji/ghq/github.com/playpark-llc/shift-bud}"
OUT="${TMPDIR:-/tmp}/kill1-runs"
cd "$REPO" || exit 1

mkdir -p "$OUT"

COMPOSE_FILE="docker/compose.base.yml"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-shift-bud-e2e}"
E2E_DB_PORT="${E2E_DB_PORT:-5433}"
E2E_DB_NAME="${E2E_DB_NAME:-shiftplanner_test}"
BACKEND_ENV_FILE="packages/backend/.env"
BACKEND_ENV_BACKUP="packages/backend/.env.kill1-backup"

export DB_PORT="$E2E_DB_PORT"
export POSTGRES_DB="$E2E_DB_NAME"
export E2E_DATABASE_URL="postgresql://postgres:postgres@localhost:${E2E_DB_PORT}/${E2E_DB_NAME}"
export E2E_DIRECT_DATABASE_URL="$E2E_DATABASE_URL"
export DATABASE_URL="$E2E_DATABASE_URL"
export DIRECT_DATABASE_URL="$E2E_DATABASE_URL"
export JWT_SECRET="e2e-test-jwt-secret-key-for-testing"
export NODE_ENV="${NODE_ENV:-test}"
export DEV_TENANT_SLUG="${DEV_TENANT_SLUG:-cafe-standard}"
export RATE_LIMIT_INVITES_MAX="${RATE_LIMIT_INVITES_MAX:-100}"

# Kill-1 の要求: retries:2 強制。ローカル既定 0 のままでは flaky が構造的に観測できない
# （0b-core README「重要」— 仮説を持たずに実物 config へ当てると flaky が出現せず
#  「問題なし」と誤結論する経路が実在する）。
#
# ただし CI=1 は使えない: playwright.config.ts は
#   webServer: process.env.CI ? undefined : [...]
# として CI 環境ではサーバ自動起動を無効化する（CI は workflow 側で手動起動するため）。
# CI=1 を立てるとサーバが立たず suite が丸ごと落ちる。
# 代わりに CLI フラグで上書きする（config より優先される）:
#   --retries=2   Kill-1 の要求そのもの
#   --workers=1   CI の workers: process.env.CI ? 1 : undefined に合わせる。
#                 Kill-1 の判定先である gate の消費者は CI であり、
#                 並行度が変われば資源競合経路の flaky 率も変わるため CI 側に揃える。
PW_FLAGS="--retries=2 --workers=1"

kill_port() {
  local pids
  pids=$(lsof -ti :"$1" 2>/dev/null) || true
  [[ -n "$pids" ]] && { echo "$pids" | xargs kill -9 2>/dev/null || true; sleep 1; }
}

cleanup() {
  echo "### cleanup"
  [[ -f "$BACKEND_ENV_BACKUP" ]] && mv "$BACKEND_ENV_BACKUP" "$BACKEND_ENV_FILE"
  kill_port 3010
  kill_port 3011
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ -f "$BACKEND_ENV_FILE" ]] && mv "$BACKEND_ENV_FILE" "$BACKEND_ENV_BACKUP"

kill_port 3010
kill_port 3011

echo "### DB 起動"
docker compose -f "$COMPOSE_FILE" up -d --wait db || exit 1
for i in {1..30}; do
  nc -z localhost "$E2E_DB_PORT" 2>/dev/null && break
  [[ $i -eq 30 ]] && { echo "FATAL: DB port unreachable"; exit 1; }
  sleep 2
done

echo "### shared build（seed / server が @shift-bud/shared/dist を解決するのに必須）"
# CI workflow は 'Build shared package' ステップでこれをやっている。
# e2e-local.sh には無く、ビルド済み前提になっていたため未ビルド環境で seed が落ちる
# （baseline probe の F-2 と同じ根本原因: shared 未ビルド → module 解決失敗）。
pnpm --filter @shift-bud/shared build || exit 1

echo "### migrate + seed"
pnpm --filter @shift-bud/backend exec prisma migrate deploy || exit 1
pnpm --filter @shift-bud/backend db:seed || exit 1

echo "### tree の同一性を記録（Kill-1 は同一 tree 前提）"
git rev-parse HEAD > "$OUT/tree.txt"
git status --porcelain >> "$OUT/tree.txt"
echo "HEAD=$(git rev-parse --short HEAD) dirty=$(git status --porcelain | wc -l | tr -d ' ')"

for i in $(seq 1 "$N"); do
  echo "=================== run $i / $N"
  # JSON reporter で機械可読の生観測を得る。html/github reporter は集計に使えない。
  E2E=true EMAIL_PROVIDER=mock RESEND_API_KEY= \
    PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/run-$i.json" \
    pnpm --filter @shift-bud/e2e exec playwright test $PW_FLAGS --reporter=json \
    > "$OUT/run-$i.stdout" 2>"$OUT/run-$i.stderr"
  echo "exit=$? -> $OUT/run-$i.json"
  # seed 状態をリセットして run 間の独立性を保つ（前 run の書き込みが次 run に漏れないように）
  if [[ $i -lt $N ]]; then
    echo "--- reseed"
    pnpm --filter @shift-bud/backend db:seed >/dev/null 2>&1 || echo "WARN: reseed failed"
  fi
done

echo
echo "### 保存先: $OUT"
ls -la "$OUT"
