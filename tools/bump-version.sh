#!/bin/sh
# 版番号を上げる（公開版を更新するとき、push の前に実行する）。
# index.html の ?v=、js/config.js の APP_VERSION、sw.js の VERSION を同じ番号にそろえる。
# 使い方：tools/bump-version.sh            → 今日の日付＋連番（例 2026102604）
#        tools/bump-version.sh 2026102699 → 番号を指定
set -e
cd "$(dirname "$0")/.."
OLD=$(sed -n "s/.*APP_VERSION: '\([0-9]*\)'.*/\1/p" js/config.js)
if [ -n "$1" ]; then NEW="$1"; else
  TODAY=$(date +%Y%m%d)
  case "$OLD" in "$TODAY"*) NEW=$((OLD + 1));; *) NEW="${TODAY}01";; esac
fi
sed -i '' "s/?v=$OLD/?v=$NEW/g" index.html sw.js
sed -i '' "s/APP_VERSION: '$OLD'/APP_VERSION: '$NEW'/" js/config.js
sed -i '' "s/const VERSION = '$OLD'/const VERSION = '$NEW'/" sw.js
echo "版番号 $OLD → $NEW"
