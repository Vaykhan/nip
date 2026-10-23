#!/bin/bash
# show a phpt FILE section and both outputs side by side
NIP="$(cd "$(dirname "$0")/../.." && pwd)/bin/nip.js"
f=$(find ${PHPSRC:-/tmp/php-src} -path "*$1" | head -1)
d=$(mktemp -d); sed -n '/^--FILE--$/,/^--[A-Z]*--$/p' "$f" | sed '1d;$d' > $d/t.php
ini=$(sed -n '/^--INI--$/,/^--[A-Z]*--$/p' "$f" | sed '1d;$d' | grep -v '^;' | sed 's/^/-d /' | tr '\n' ' ')
echo "##### $f  ini: $ini"; cat -n $d/t.php | head -${2:-40}
echo "----- php"; (cd $d && php -d display_errors=1 -d log_errors=0 -d error_reporting=32767 $ini t.php 2>&1 | head -${3:-25})
echo "----- js"; (cd $d && node "$NIP" -d display_errors=1 -d log_errors=0 -d error_reporting=32767 $ini t.php 2>&1 | head -${3:-25})
rm -rf $d
