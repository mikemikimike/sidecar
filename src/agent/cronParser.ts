// ---------------------------------------------------------------------------
// Minimal cron expression parser — no external dependencies.
//
// Supports standard 5-field cron: "minute hour day month weekday"
// Each field accepts: * | number | */step | n-m | n,m,... (and combinations)
//
// Only used by the Scheduler to check whether the current wall-clock time
// matches a cron expression. Called once per minute by a setInterval tick.
// ---------------------------------------------------------------------------

type CronField = (minute: number) => boolean;

interface Field {
  match: CronField;
  // False for a bare `*` (or `*` with step 1): an unrestricted field, which
  // matters for the day/weekday rule.
  restricted: boolean;
}

/**
 * One cron field: `*`, `n`, `a-b`, and a `/step` on any of them (every-15
 * on `*`, `0-23/6`, `5/10`), comma-separated. Null when any part is malformed or out
 * of range, so the whole expression is rejected instead of never matching
 * (#121). The old parser split `0-23/6` on '-' and read `parseInt('23/6')` as
 * 23 -- every hour instead of every six -- and turned a bad field into a
 * matcher that was silently always false.
 */
function parseField(raw: string, min: number, max: number): Field | null {
  const values = new Set<number>();
  let restricted = false;
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : parseInt(m[2], 10);
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min;
      hi = max;
      if (step > 1) restricted = true;
    } else {
      restricted = true;
      const [a, b] = m[1].split('-').map((x) => parseInt(x, 10));
      lo = a;
      // `5/10` means from 5 to the end, every 10.
      hi = b !== undefined ? b : m[2] !== undefined ? max : a;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let n = lo; n <= hi; n += step) values.add(n);
  }
  return { match: (n) => values.has(n), restricted };
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
  /** Both restricted: cron fires when EITHER matches (POSIX), not both. */
  dayAndWeekdayBothRestricted?: boolean;
}

/**
 * Parse a 5-field cron expression. Returns null if the expression is malformed.
 */
export function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;
  const minute = parseField(minuteRaw, 0, 59);
  const hour = parseField(hourRaw, 0, 23);
  const day = parseField(dayRaw, 1, 31);
  const month = parseField(monthRaw, 1, 12);
  // 0-7: both 0 and 7 are Sunday.
  const weekdayField = parseField(weekdayRaw, 0, 7);
  if (!minute || !hour || !day || !month || !weekdayField) return null;
  const weekday: CronField = (n) => weekdayField.match(n) || (n === 0 && weekdayField.match(7));
  return {
    minute: minute.match,
    hour: hour.match,
    day: day.match,
    month: month.match,
    weekday,
    dayAndWeekdayBothRestricted: day.restricted && weekdayField.restricted,
  };
}

/**
 * Returns true if the given Date matches the parsed cron expression.
 * Month is 1-indexed (as cron requires); weekday 0 = Sunday.
 */
export function cronMatches(cron: ParsedCron, date: Date): boolean {
  // `0 9 1 * 1` is "the 1st of the month AND every Monday" in cron, not
  // "Mondays that fall on the 1st" (#121). With either field `*`, AND is the
  // same thing.
  const dayOk = cron.dayAndWeekdayBothRestricted
    ? cron.day(date.getDate()) || cron.weekday(date.getDay())
    : cron.day(date.getDate()) && cron.weekday(date.getDay());
  return cron.minute(date.getMinutes()) && cron.hour(date.getHours()) && cron.month(date.getMonth() + 1) && dayOk;
}
