#!/bin/bash
# quick diff of php vs NIP for phpt names (path suffixes)
NIP="$(cd "$(dirname "$0")/../.." && pwd)/bin/nip.js"
for t in "$@"; do
f=$(find ${PHPSRC:-/tmp/php-src} -path "*$t" | head -1)
d=$(mktemp -d); sed -n '/^--FILE--$/,/^--[A-Z]*--$/p' "$f" | sed '1d;$d' > $d/t.php
ini=$(sed -n '/^--INI--$/,/^--[A-Z]*--$/p' "$f" | sed '1d;$d' | grep -v '^;' | sed 's/^/-d /' | tr '\n' ' ')
echo "##### $t"
diff <(cd $d && php -d display_errors=1 -d log_errors=0 -d error_reporting=32767 $ini t.php 2>&1) <(cd $d && node "$NIP" -d display_errors=1 -d log_errors=0 -d error_reporting=32767 $ini t.php 2>&1) | head -${N:-8}
rm -rf $d
done
