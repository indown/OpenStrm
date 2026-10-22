#!/usr/bin/env bash
#
# 提交前 / CI 里跑的一条 grep：凭据的常见形状不能出现在源码、方案文件、测试夹具里。
# 以前靠人记住，现在固定下来；扫不到不等于可以写。
#
#   scripts/check-hygiene.sh
set -u
cd "$(dirname "$0")/.."

SCOPE=(apps packages .claude/plans ./*.md)
EXCLUDES=(--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=out)

# JWT、115 cookie（UID / SEID）、夸克 cookie（__pus / __puus）、Telegram bot token、api_key=<32 位 hex>
SECRETS='eyJ[A-Za-z0-9_-]{20,}\.eyJ|UID=[0-9]{3,}_[A-Z][0-9]_[0-9]{6,}|SEID=[0-9a-f]{24,}|__pu{1,2}s=[A-Za-z0-9+/=_-]{16,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|api_key=[0-9a-f]{32}'
if hits=$(grep -rnE "${EXCLUDES[@]}" "$SECRETS" "${SCOPE[@]}"); then
  echo "::error::像凭据的内容，确认后换成占位符："
  echo "$hits" | cut -c1-160
  exit 1
fi
echo "hygiene: ok"
