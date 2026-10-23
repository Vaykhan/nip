#!/bin/bash
# Differential test runner: compares NIP output with the reference php binary.
cd "$(dirname "$0")"
pass=0; fail=0; failed=()
for f in ${@:-*.php}; do
  exp=$(timeout 20 php "$f" 2>&1); expc=$?
  got=$(timeout 20 node ../nip.js "$f" 2>&1); gotc=$?
  if [ "$exp" == "$got" ] && [ $expc == $gotc ]; then pass=$((pass+1)); else fail=$((fail+1)); failed+=("$f"); fi
done
echo "pass=$pass fail=$fail"
for f in "${failed[@]}"; do echo "FAIL: $f"; done
