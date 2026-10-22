#!/usr/bin/env bash
#
# 凭据的常见形状不能出现在源码、方案文件、测试夹具里。以前靠人记住，现在固定下来；扫不到不等于可以写。
#
#   scripts/check-hygiene.sh            扫整个工作区（CI 用）
#   scripts/check-hygiene.sh --staged   只扫暂存区里的文件、取索引里的内容（pre-commit 钩子用）
set -u
cd "$(dirname "$0")/.."

SCOPE=(apps packages .claude/plans ./*.md)
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=out)

# JWT、115 cookie（UID / SEID）、夸克 cookie（__pus / __puus）、Telegram bot token、api_key=<32 位 hex>
SECRETS='eyJ[A-Za-z0-9_-]{20,}\.eyJ|UID=[0-9]{3,}_[A-Z][0-9]_[0-9]{6,}|SEID=[0-9a-f]{24,}|__pu{1,2}s=[A-Za-z0-9+/=_-]{16,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|api_key=[0-9a-f]{32}'

if [ "${1:-}" = "--staged" ]; then
  # 看的是索引里的内容，不是工作区：工作区改了没 add 的不算，add 了又改回去的也要算
  hits=""
  while IFS= read -r -d '' f; do
    case "$f" in */node_modules/*|*/.next/*|*/dist/*|*/out/*) continue ;; esac
    h=$(git show ":$f" | grep -nE "$SECRETS" | sed "s|^|$f:|")
    [ -n "$h" ] && hits="${hits}${h}"$'\n'
  done < <(git diff --cached --name-only -z --diff-filter=ACMR -- apps packages .claude/plans '*.md')
  hits="${hits%$'\n'}"
else
  hits=$(grep -rnE "${EXCLUDES[@]}" "$SECRETS" "${SCOPE[@]}") || true
fi

if [ -n "$hits" ]; then
  echo "::error::像凭据的内容，确认后换成占位符："
  echo "$hits" | cut -c1-160
  exit 1
fi
echo "hygiene: ok"
