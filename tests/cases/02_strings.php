<?php
$name = "World"; $arr = ['key' => 'val', 3 => 'three']; $obj = new stdClass; $obj->p = 'prop'; $obj->o = new stdClass; $obj->o->q = 'deep';
echo "Hello $name! {$name}s ${name} $arr[key] {$arr['key']} $arr[3] $obj->p {$obj->o->q}\n";
echo 'single $name\n', "\n";
echo "esc: \t|\\|\$|\x41|\101|\u{1F600}|\e[0m\n";
echo <<<EOT
  heredoc $name
    indented {$arr['key']}
  EOT;
echo "\n";
echo <<<'EOT'
nowdoc $name\n
EOT;
echo "\n";
echo strlen("héllo"), " ", mb_strlen("héllo"), " ", strtoupper("abc"), " ", ucfirst("hello"), " ", ucwords("hello big world"), "\n";
echo str_pad("5", 3, "0", STR_PAD_LEFT), " ", str_repeat("ab", 3), " ", strrev("abc"), " ", trim("  x  "), "|", rtrim("xyy", "y"), "|", ltrim("0012", "0"), "\n";
echo substr("hello", 1, 3), " ", substr("hello", -3), " ", substr("hello", 1, -1), " ", strpos("hello", "l"), " ", strrpos("hello", "l"), "\n";
var_dump(strpos("abc", "d"), str_contains("abc", "b"), str_starts_with("abc", "ab"), str_ends_with("abc", "bc"));
echo str_replace("l", "L", "hello", $cnt), " $cnt\n";
echo str_replace(['a', 'b'], ['1', '2'], "aabbc"), "\n";
print_r(explode(",", "a,b,,c")); print_r(explode(",", "a,b,c", 2)); print_r(explode(",", "a,b,c", -1));
echo implode("-", [1, 2, 3]), " ", implode([1, 2]), "\n";
print_r(str_split("abcdef", 4));
echo sprintf("%s|%5s|%-5s|%05d|%.3f|%x|%X|%o|%b|%c|%%|%e|%10.4f|%-10s|%u|%'#10s|%+d|%+d", "a", "b", "c", 42, 3.14159, 255, 255, 8, 5, 65, 1234.5678, 3.14159, "left", 3, "pad", 5, -5), "\n";
echo sprintf('%2$s %1$s', 'world', 'hello'), "\n";
echo number_format(1234567.891), " ", number_format(1234567.891, 2), " ", number_format(1234567.891, 2, ',', '.'), " ", number_format(0.125, 2), "\n";
echo wordwrap("The quick brown fox sat over the lazy dog", 15, "\n", true), "\n";
echo wordwrap("A very long woooooooooooord.", 8, "\n", true), "\n";
echo nl2br("a\nb"), " ", htmlspecialchars("<a href='x'>T&C</a>"), " ", strip_tags("<b>bold</b> text"), "\n";
echo ucwords("hello-world foo_bar", "-"), " ", lcfirst("ABC"), " ", strtolower("ÀBC"), "\n";
echo strcmp("a", "b"), strcmp("b", "a"), strcmp("a", "a"), " ", strcasecmp("HELLO", "hello"), " ", strncmp("abcd", "abef", 2), " ", strnatcmp("img12", "img10"), " ", strnatcasecmp("A1", "a2"), "\n";
echo substr_count("hello hello", "ll"), " ", ucfirst(strrev("olleh")), " ", str_word_count("The quick brown"), " ", similar_text("World","Word"), " ", levenshtein("kitten","sitting"), " ", soundex("Robert"), "\n";
echo strtr("Hi all", "al", "AL"), " ", strtr("Hi all", ["Hi" => "Hello", "all" => "everyone"]), "\n";
echo chunk_split("abcd", 2, "|"), " ", addslashes("O'Re\"il"), " ", stripslashes("O\\'R"), " ", quotemeta("1+1=2?"), "\n";
echo md5("hello"), " ", sha1("hello"), " ", crc32("hello"), " ", base64_encode("hello"), " ", base64_decode("aGVsbG8="), " ", bin2hex("abc"), "\n";
echo urlencode("a b&c=d/é"), " ", rawurlencode("a b"), " ", urldecode("a+b%20c"), " ", http_build_query(['a' => 1, 'b' => [1, 2]]), "\n";
echo strstr("user@example.com", "@"), " ", strstr("user@example.com", "@", true), " ", strrchr("a/b/c", "/"), " ", stristr("HELLO", "ell"), "\n";
echo substr_replace("Hello", "J", 0, 1), " ", substr_replace("abc", "X", -1), " ", ucwords(strtolower("JOHN DOE")), "\n";
echo str_word_count("Hello World again"), " ", strpbrk("This is a test", "st"), " ", nl2br("x"), "\n";
var_dump(sprintf("%.2f", 1.005), sprintf("%d", "12abc"), sprintf("%5.1f", -2.345), sprintf("%s", true), sprintf("%s", null), sprintf("%.10F", 1/3));
echo mb_substr("héllo wörld", 1, 4), " ", mb_strtoupper("héllo"), " ", mb_str_pad("é", 3, "-", STR_PAD_BOTH), " ", mb_strpos("aéb", "b"), "\n";
var_dump(str_word_count("a b"), ucfirst(""), trim("\x00\t\n x \r"), "abc"[1], "abc"[-1]);
$s = "abc"; $s[1] = 'X'; $s[5] = 'Y'; var_dump($s);
var_dump(sprintf("%'.10d|%-10d|%10.3e", 42, 42, 0.000123));
var_dump(vsprintf("%d-%s", [3, "x"]), strval(1.0), strval(0.1+0.2), (string)1e25, 7 . '');
echo implode(",", str_getcsv('a,"b,c",d')), "\n";
var_dump(ctype_digit("123"), ctype_digit("12a"), ctype_alpha("abc"), ctype_upper("AB"), ctype_space(" \n"), is_numeric("1e5"), is_numeric(" 1"), is_numeric("1 "), is_numeric("0x1A"), is_numeric("."));
