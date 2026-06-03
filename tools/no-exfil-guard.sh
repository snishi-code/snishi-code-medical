#!/usr/bin/env bash
# tools/no-exfil-guard.sh
# snishi-code.com 全リポ共通の「外部送信ゼロ」機械ガード。
#
# 方針: ユーザーデータの外部送信は **絶対禁止・例外なし(サイト全体)**。CLAUDE.md 参照。
#   (1) 送信系 API は、該当行に  // network-ok: <理由>  の明示注釈が無ければ違反。
#       （正規の同一オリジン通信 = service worker のキャッシュ取得などはこれで承認する）
#   (2) 自ドメイン以外のリソース読込(外部CDN・トラッキング画像等)は例外なく違反。
#
# pre-commit フックと GitHub Action の両方から呼ばれる。
# 正本は apex リポ (snishi-code.com)。medical / personal には同一コピーを置く
#   （別 origin のため物理コピーが必要。site-links.js と同じ運用）。
set -uo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root" || exit 2

# 対象 = git 管理下の「配信されるクライアントコード」のみ。
# test / tooling / ビルド前生成物 / 自分自身(tools/) は除外し、誤検知をゼロにする。
files=$(git ls-files -- '*.html' '*.js' '*.mjs' '*.css' \
  | grep -vE '(^|/)(node_modules|tools)/' \
  | grep -vE '\.claude/worktrees/' \
  | grep -vE '(^|/)(test|tests|e2e)/' \
  | grep -vE '(\.|-)(test|spec)\.' \
  | grep -vE 'playwright' || true)

if [ -z "$files" ]; then
  echo "no-exfil-guard: 対象ファイルなし (clean)"
  exit 0
fi

fail=0

# (1) 送信系プリミティブ: fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon
net=$(printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 grep -nEH \
  '(^|[^A-Za-z0-9_])(fetch|XMLHttpRequest|WebSocket|EventSource)[[:space:]]*\(|(^|[^A-Za-z0-9_])sendBeacon[[:space:]]*\(' \
  2>/dev/null || true)
if [ -n "$net" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      *network-ok:*) ;;                       # 明示承認済み → 許可
      *) printf '  X [送信系API] %s\n' "$line"; fail=1 ;;
    esac
  done <<EOF
$net
EOF
fi

# (2) 外部リソース読込: <script/link/img/...> の外部 src|href、CSS の @import / url(http...)
res=$(printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 grep -nEiH \
  '<(script|link|img|iframe|source|audio|video)[^>]+(src|href)[[:space:]]*=[[:space:]]*["'\'']https?://|@import[[:space:]]+["'\'']?https?://|url\([[:space:]]*["'\'']?https?://' \
  2>/dev/null || true)
if [ -n "$res" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      *snishi-code.com*) ;;                   # 自ドメインのみ許可
      *) printf '  X [外部リソース読込] %s\n' "$line"; fail=1 ;;
    esac
  done <<EOF
$res
EOF
fi

if [ "$fail" -ne 0 ]; then
  cat <<'MSG'

----------------------------------------------------------------
 no-exfil-guard: 外部送信/外部読込の疑いを検出しました。
 snishi-code.com は「ユーザーデータの外部送信を絶対禁止」(全リポ共通)。

  - 正規の同一オリジン通信(例: service worker のキャッシュ取得)は、
    該当行に  // network-ok: <理由>  を付けて明示承認してください。
  - 外部CDN/トラッキング等のリソース読込は不可(バンドルに含める)。
----------------------------------------------------------------
MSG
  exit 1
fi

echo "OK no-exfil-guard: clean (送信系・外部読込なし)"
exit 0
