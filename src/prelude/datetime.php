<?php
class DateTimeZone {
  const UTC = 1024; const ALL = 2047;
  private $__tz;
  public function __construct(string $timezone = "UTC") { if (!__valid_tz($timezone)) throw new DateInvalidTimeZoneException("DateTimeZone::__construct(): Unknown or bad timezone ($timezone)"); $this->__tz = $timezone; }
  public function getName(): string { return $this->__tz; }
  public function getOffset(DateTimeInterface $datetime): int { return __tz_info($datetime->getTimestamp(), $this->__tz)['offset']; }
  public static function listIdentifiers(int $timezoneGroup = 2047, ?string $countryCode = null): array { return ['UTC']; }
}
class DateInterval {
  public $y = 0; public $m = 0; public $d = 0; public $h = 0; public $i = 0; public $s = 0; public $f = 0; public $invert = 0; public $days = false;
  public function __construct(string $duration = "PT0S") {
    if (!preg_match('/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/', $duration, $m)) throw new DateMalformedIntervalStringException("Unknown or bad format ($duration)");
    $this->y = (int)($m[1] ?? 0); $this->m = (int)($m[2] ?? 0); $this->d = (int)($m[4] ?? 0) + 7 * (int)($m[3] ?? 0);
    $this->h = (int)($m[5] ?? 0); $this->i = (int)($m[6] ?? 0); $this->s = (int)($m[7] ?? 0);
  }
  public static function createFromDateString(string $datetime) { $b = 86400 * 365 * 30; $t = strtotime($datetime, $b); $iv = new DateInterval('PT0S'); $diff = $t - $b; $iv->s = $diff; return $iv; }
  public function format(string $format): string {
    $map = ['%y' => $this->y, '%Y' => sprintf('%04d', $this->y), '%m' => $this->m, '%M' => sprintf('%02d', $this->m), '%d' => $this->d, '%D' => sprintf('%02d', $this->d),
      '%h' => $this->h, '%H' => sprintf('%02d', $this->h), '%i' => $this->i, '%I' => sprintf('%02d', $this->i), '%s' => $this->s, '%S' => sprintf('%02d', $this->s),
      '%a' => $this->days === false ? '(unknown)' : $this->days, '%R' => $this->invert ? '-' : '+', '%r' => $this->invert ? '-' : '', '%f' => 0, '%F' => '000000', '%%' => '%'];
    return strtr($format, $map);
  }
}
// DateTime and DateTimeImmutable are unrelated classes in PHP; they share this implementation
trait __DateTimeImpl {
  protected $__ts; protected $__tz; protected $__us = 0;
  public function __construct(string $datetime = "now", ?DateTimeZone $timezone = null) {
    $this->__tz = $timezone ? $timezone->getName() : date_default_timezone_get();
    if (preg_match('/(?:^|\s)(Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i', $datetime, $zm) && !$timezone) { $z = strtoupper($zm[1]); $this->__tz = ($z === 'Z' || $z === 'GMT') ? 'UTC' : (strlen($z) === 5 ? substr($z, 0, 3) . ':' . substr($z, 3) : $z); }
    if (preg_match('/\.(\d{1,6})/', $datetime, $um)) $this->__us = (int)str_pad($um[1], 6, '0');
    elseif ($datetime === 'now') { $this->__us = (int)(fmod(microtime(true), 1) * 1000000); }
    $ts = __strtotime_tz(preg_replace('/\.\d+/', '', $datetime), time(), $this->__tz);
    if ($ts === false) throw new DateMalformedStringException("Failed to parse time string ($datetime) at position 0 (" . substr($datetime, 0, 1) . "): The timezone could not be found in the database");
    $this->__ts = $ts;
  }
  public function format(string $format): string { return __date_tz($format, $this->__ts, $this->__tz, $this->__us); }
  public function getTimestamp(): int { return $this->__ts; }
  public function getTimezone() { return new DateTimeZone($this->__tz); }
  public function getOffset(): int { return __tz_info($this->__ts, $this->__tz)['offset']; }
  public function getMicrosecond(): int { return $this->__us; }
  protected function __mut() { return $this; }
  public function setTimestamp(int $timestamp) { $c = $this->__mut(); $c->__ts = $timestamp; $c->__us = 0; return $c; }
  public function setTimezone(DateTimeZone $timezone) { $c = $this->__mut(); $c->__tz = $timezone->getName(); return $c; }
  public function setDate(int $year, int $month, int $day) { $c = $this->__mut(); $t = __tz_info($c->__ts, $c->__tz); $c->__ts = __local_to_ts($year, $month, $day, $t['h'], $t['i'], $t['s'], $c->__tz); return $c; }
  public function setTime(int $hour, int $minute, int $second = 0, int $microsecond = 0) { $c = $this->__mut(); $t = __tz_info($c->__ts, $c->__tz); $c->__ts = __local_to_ts($t['y'], $t['m'], $t['d'], $hour, $minute, $second, $c->__tz); $c->__us = $microsecond; return $c; }
  public function setISODate(int $year, int $week, int $dayOfWeek = 1) { $c = $this->__mut(); $jan4 = __local_to_ts($year, 1, 4, 0, 0, 0, $c->__tz); $dow = (int)__date_tz('N', $jan4, $c->__tz); $t = __tz_info($c->__ts, $c->__tz); $base = $jan4 - ($dow - 1) * 86400; $d = __tz_info($base + (($week - 1) * 7 + $dayOfWeek - 1) * 86400, $c->__tz); $c->__ts = __local_to_ts($d['y'], $d['m'], $d['d'], $t['h'], $t['i'], $t['s'], $c->__tz); return $c; }
  public function modify(string $modifier) { $c = $this->__mut(); $ts = __strtotime_tz($modifier, $c->__ts, $c->__tz); if ($ts === false) throw new DateMalformedStringException(($this instanceof DateTimeImmutable ? "DateTimeImmutable" : "DateTime") . "::modify(): Failed to parse time string ($modifier) at position 0 (" . substr($modifier, 0, 1) . "): The timezone could not be found in the database"); $c->__ts = $ts; return $c; }
  private function __applyInterval(DateInterval $iv, int $sign) {
    $c = $this->__mut(); $sign = $iv->invert ? -$sign : $sign;
    if ($iv->days !== false && $iv->y === 0 && $iv->m === 0 && false) { $c->__ts += $sign * $iv->days * 86400; return $c; }
    $t = __tz_info($c->__ts, $c->__tz);
    $c->__ts = __local_to_ts($t['y'] + $sign * $iv->y, $t['m'] + $sign * $iv->m, $t['d'] + $sign * $iv->d, $t['h'] + $sign * $iv->h, $t['i'] + $sign * $iv->i, $t['s'] + $sign * $iv->s, $c->__tz);
    return $c;
  }
  public function add(DateInterval $interval) { return $this->__applyInterval($interval, 1); }
  public function sub(DateInterval $interval) { return $this->__applyInterval($interval, -1); }
  public function diff(DateTimeInterface $targetObject, bool $absolute = false): DateInterval {
    $a = $this->getTimestamp(); $b = $targetObject->getTimestamp(); $iv = new DateInterval('PT0S');
    $invert = $b < $a; if ($invert) { [$a, $b] = [$b, $a]; }
    $ta = __tz_info($a, $this->__tz); $tb = __tz_info($b, $this->__tz);
    $y = $tb['y'] - $ta['y']; $m = $tb['m'] - $ta['m']; $d = $tb['d'] - $ta['d']; $h = $tb['h'] - $ta['h']; $i = $tb['i'] - $ta['i']; $s = $tb['s'] - $ta['s'];
    if ($s < 0) { $s += 60; $i--; } if ($i < 0) { $i += 60; $h--; } if ($h < 0) { $h += 24; $d--; }
    if ($d < 0) { $pm = $tb['m'] - 1; $py = $tb['y']; if ($pm < 1) { $pm = 12; $py--; } $d += cal_days_in_month(0, $pm, $py); $m--; }
    if ($m < 0) { $m += 12; $y--; }
    $iv->y = $y; $iv->m = $m; $iv->d = $d; $iv->h = $h; $iv->i = $i; $iv->s = $s; $iv->invert = ($invert && !$absolute) ? 1 : 0;
    $iv->days = intdiv($b - $a - ($tb['offset'] - $ta['offset']) * 0, 86400);
    return $iv;
  }
  public static function createFromFormat(string $format, string $datetime, ?DateTimeZone $timezone = null) {
    $tz = $timezone ? $timezone->getName() : date_default_timezone_get();
    $now = __tz_info(time(), $tz); $y = $now['y']; $mo = $now['m']; $d = $now['d']; $h = $now['h']; $mi = $now['i']; $s = $now['s']; $reset = false; $pos = 0; $timeGiven = false;
    $months = ['jan'=>1,'feb'=>2,'mar'=>3,'apr'=>4,'may'=>5,'jun'=>6,'jul'=>7,'aug'=>8,'sep'=>9,'oct'=>10,'nov'=>11,'dec'=>12]; $pm = null;
    for ($k = 0; $k < strlen($format); $k++) {
      $f = $format[$k]; $rest = substr($datetime, $pos);
      switch ($f) {
        case 'Y': if (!preg_match('/^\d{4}/', $rest, $mm)) return false; $y = (int)$mm[0]; $pos += 4; break;
        case 'y': if (!preg_match('/^\d{2}/', $rest, $mm)) return false; $y = (int)$mm[0]; $y += $y < 70 ? 2000 : 1900; $pos += 2; break;
        case 'm': case 'n': if (!preg_match('/^\d{1,2}/', $rest, $mm)) return false; $mo = (int)$mm[0]; $pos += strlen($mm[0]); break;
        case 'd': case 'j': if (!preg_match('/^\d{1,2}/', $rest, $mm)) return false; $d = (int)$mm[0]; $pos += strlen($mm[0]); break;
        case 'H': case 'G': case 'h': case 'g': if (!preg_match('/^\d{1,2}/', $rest, $mm)) return false; $h = (int)$mm[0]; $pos += strlen($mm[0]); $timeGiven = true; break;
        case 'i': if (!preg_match('/^\d{2}/', $rest, $mm)) return false; $mi = (int)$mm[0]; $pos += 2; $timeGiven = true; break;
        case 's': if (!preg_match('/^\d{2}/', $rest, $mm)) return false; $s = (int)$mm[0]; $pos += 2; $timeGiven = true; break;
        case 'A': case 'a': $pm = strtolower(substr($rest, 0, 2)) === 'pm'; $pos += 2; break;
        case 'M': case 'F': if (!preg_match('/^[a-zA-Z]+/', $rest, $mm)) return false; $mo = $months[strtolower(substr($mm[0], 0, 3))] ?? 1; $pos += strlen($mm[0]); break;
        case 'D': case 'l': if (!preg_match('/^[a-zA-Z]+/', $rest, $mm)) return false; $pos += strlen($mm[0]); break;
        case 'U': if (!preg_match('/^-?\d+/', $rest, $mm)) return false; $o = new static('@' . $mm[0]); return $o;
        case '!': $y = 1970; $mo = 1; $d = 1; $h = 0; $mi = 0; $s = 0; $reset = true; break;
        case '|': $reset = true; break;
        case '\\': $k++; $pos++; break;
        case 'u': case 'v': if (preg_match('/^\d+/', $rest, $mm)) $pos += strlen($mm[0]); break;
        case 'e': case 'T': case 'P': case 'O': if (preg_match('/^[A-Za-z_\/+\-:0-9]+/', $rest, $mm)) $pos += strlen($mm[0]); break;
        default: $pos++;
      }
    }
    if ($pm !== null) { if ($pm && $h < 12) $h += 12; if (!$pm && $h === 12) $h = 0; }
    if ($reset && !$timeGiven) { }
    $o = new static('now', $timezone);
    $o->__ts = __local_to_ts($y, $mo, $d, $h, $mi, $s, $tz); $o->__us = 0;
    return $o;
  }
  public static function createFromInterface(DateTimeInterface $object) { return new static('@' . $object->getTimestamp()); }
  public static function createFromImmutable($object) { $o = new static('@' . $object->getTimestamp()); $o->__tz = $object->getTimezone()->getName(); return $o; }
  public static function getLastErrors() { return false; }
  public function __serialize(): array { return ['date' => $this->format('Y-m-d H:i:s.u'), 'timezone_type' => 3, 'timezone' => $this->__tz]; }
  public function __nipProps(): array { return ['date' => $this->format('Y-m-d H:i:s.u'), 'timezone_type' => 3, 'timezone' => $this->__tz]; }
  public function __nipCompare($other) { return [$this->__ts, $this->__us] <=> [$other->getTimestamp(), $other->getMicrosecond()]; }
  public function __unserialize(array $data): void { $this->__tz = $data['timezone']; $this->__ts = __strtotime_tz(substr($data['date'], 0, 19), time(), $this->__tz); }
}
class DateTime implements DateTimeInterface {
  use __DateTimeImpl;
}
class DateTimeImmutable implements DateTimeInterface {
  use __DateTimeImpl;
  protected function __mut() { return clone $this; }
  public static function createFromMutable($object) { $o = new static('@' . $object->getTimestamp()); return $o->setTimezone($object->getTimezone()); }
}
class DatePeriod implements IteratorAggregate {
  const EXCLUDE_START_DATE = 1; const INCLUDE_END_DATE = 2;
  private $__s; private $__iv; private $__e; private $__opt;
  public function __construct($start, $interval = null, $end = null, $options = 0) { $this->__s = $start; $this->__iv = $interval; $this->__e = $end; $this->__opt = $options; }
  public function getIterator(): Iterator {
    $f = function () {
      $cur = DateTimeImmutable::createFromInterface($this->__s); $i = 0;
      if ($this->__opt & 1) $cur = $cur->add($this->__iv);
      if (is_int($this->__e)) { for ($n = 0; $n <= $this->__e; $n++) { yield $i++ => ($this->__s instanceof DateTimeImmutable ? $cur : DateTime::createFromImmutable($cur)); $cur = $cur->add($this->__iv); } return; }
      while ($cur->getTimestamp() < $this->__e->getTimestamp() || (($this->__opt & 2) && $cur->getTimestamp() == $this->__e->getTimestamp())) { yield $i++ => ($this->__s instanceof DateTimeImmutable ? $cur : DateTime::createFromImmutable($cur)); $cur = $cur->add($this->__iv); }
    };
    return $f();
  }
  public function getStartDate() { return $this->__s; } public function getEndDate() { return $this->__e; } public function getDateInterval() { return $this->__iv; }
}
function date_create($datetime = "now", $timezone = null) { try { return new DateTime($datetime, $timezone); } catch (Exception $e) { return false; } }
function date_create_immutable($datetime = "now", $timezone = null) { try { return new DateTimeImmutable($datetime, $timezone); } catch (Exception $e) { return false; } }
function date_diff($a, $b, $absolute = false) { return $a->diff($b, $absolute); }
function date_add($object, $interval) { return $object->add($interval); }
function date_sub($object, $interval) { return $object->sub($interval); }
function date_format($object, $format) { return $object->format($format); }
function date_modify($object, $modifier) { return $object->modify($modifier); }
function date_timestamp_get($object) { return $object->getTimestamp(); }
function date_interval_format($object, $format) { return $object->format($format); }
class DateError extends Error {}
class DateObjectError extends DateError {}
class DateRangeError extends DateError {}
class DateException extends Exception {}
class DateInvalidOperationException extends DateException {}
class DateInvalidTimeZoneException extends DateException {}
class DateMalformedIntervalStringException extends DateException {}
class DateMalformedPeriodStringException extends DateException {}
class DateMalformedStringException extends DateException {}
