<?php
// PCRE features handled by NIP's own regex engine (src/lib/regex.js): recursion, conditionals,
// \K, backtracking verbs, atomic groups, possessive quantifiers, branch reset, duplicate names,
// UTF-8 mode, PHP's empty-match rules, and compile errors with PCRE2's messages.
function show($v) { echo json_encode($v), "\n"; }

// recursion: balanced parentheses, and a palindrome
preg_match_all('/\((?:[^()]++|(?R))*\)/', 'f(a(b)c) g(x(y(z)))', $m); show($m[0]);
show(preg_match('/^((.)(?:(?1)|.?)\2)$/', 'racecar'));
// conditionals
preg_match_all('/(<)?\w+(?(1)>)/', '<tag> word <bad', $m); show($m[0]);
// \K, lookbehind, atomic group, possessive quantifier
show(preg_replace('/foo\Kbar/', 'BAZ', 'foobar barbar'));
show(preg_match('/(?<=\d{3})px/', 'width: 100px'));
show(preg_match('/(?>a+)ab/', 'aaab'));
show(preg_match('/a++b/', 'aaab'));
// verbs
show(preg_split('/"[^"]*"(*SKIP)(*FAIL)|,/', 'a,"b,c",d'));
preg_match('/(*MARK:first)x|(*MARK:second)y/', 'y', $m); show($m);
// branch reset and duplicate names
preg_match('/(?|(\d+)|([a-z]+))-/', 'abc-', $m); show($m);
preg_match('/(?J)(?<v>\d+)|(?<v>[a-z]+)/', 'xyz', $m); show($m);
// UTF-8 mode: offsets are in bytes, \w and case folding are Unicode-aware
preg_match_all('/\w+/u', 'Größe naïve', $m, PREG_OFFSET_CAPTURE); show($m);
show(preg_match('/ÄPFEL/iu', 'äpfel'));
show(preg_split('//u', 'añb', -1, PREG_SPLIT_NO_EMPTY));
// empty matches: retried as non-empty at the same place, then one character further
show(preg_replace('/x*/', '-', 'abc'));
show(preg_split('/x*/', 'axb'));
preg_match_all('/a?/', 'baa', $m, PREG_OFFSET_CAPTURE); show($m);
// limits and errors
ini_set('pcre.backtrack_limit', '100');
show([preg_match('/(a+)+b/', str_repeat('a', 30)), preg_last_error_msg()]);
ini_restore('pcre.backtrack_limit');
show(@preg_match('/(?<n>a)(?<n>b)/', ''));
echo error_get_last()['message'], "\n";
show(@preg_match('/(?<=a+)b/', ''));
echo error_get_last()['message'], "\n";
