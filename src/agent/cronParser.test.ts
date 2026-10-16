import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches } from './cronParser.js';

function date(minute: number, hour: number, day: number, month: number, weekday: number): Date {
  // Use 2024-01-01 as a Monday (weekday=1) anchor; offset day/month as needed.
  // We only care that getMinutes/getHours/getDate/getMonth/getDay return the
  // values we specify — fake with a direct Date constructor.
  const d = new Date(2024, month - 1, day, hour, minute, 0, 0);
  // Override getDay since we can't control it without a real calendar fixture.
  // Wrap Date to inject weekday.
  Object.defineProperty(d, 'getDay', { value: () => weekday });
  return d;
}

describe('parseCron', () => {
  it('returns null for wrong field count', () => {
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('* * * * * *')).toBeNull();
    expect(parseCron('')).toBeNull();
  });

  it('parses wildcard expression', () => {
    const cron = parseCron('* * * * *');
    expect(cron).not.toBeNull();
  });
});

describe('cronMatches', () => {
  it('matches all times with * * * * *', () => {
    const cron = parseCron('* * * * *')!;
    expect(cronMatches(cron, date(30, 14, 15, 6, 3))).toBe(true);
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(true);
  });

  it('matches exact minute', () => {
    const cron = parseCron('30 * * * *')!;
    expect(cronMatches(cron, date(30, 8, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(31, 8, 1, 1, 0))).toBe(false);
  });

  it('matches exact hour', () => {
    const cron = parseCron('0 9 * * *')!;
    expect(cronMatches(cron, date(0, 9, 1, 1, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 10, 1, 1, 1))).toBe(false);
  });

  it('matches step expression */15', () => {
    const cron = parseCron('*/15 * * * *')!;
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(15, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(30, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(45, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(7, 0, 1, 1, 0))).toBe(false);
  });

  it('matches range expression 9-17', () => {
    const cron = parseCron('0 9-17 * * *')!;
    expect(cronMatches(cron, date(0, 9, 1, 1, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 17, 1, 1, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 8, 1, 1, 1))).toBe(false);
    expect(cronMatches(cron, date(0, 18, 1, 1, 1))).toBe(false);
  });

  it('matches list expression 1,3,5', () => {
    const cron = parseCron('0 0 * * 1,3,5')!;
    expect(cronMatches(cron, date(0, 0, 1, 1, 1))).toBe(true); // Monday
    expect(cronMatches(cron, date(0, 0, 1, 1, 3))).toBe(true); // Wednesday
    expect(cronMatches(cron, date(0, 0, 1, 1, 5))).toBe(true); // Friday
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(false); // Sunday
    expect(cronMatches(cron, date(0, 0, 1, 1, 2))).toBe(false); // Tuesday
  });

  it('matches specific day of month', () => {
    const cron = parseCron('0 0 1 * *')!;
    expect(cronMatches(cron, date(0, 0, 1, 3, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 0, 2, 3, 1))).toBe(false);
  });

  it('matches specific month', () => {
    const cron = parseCron('0 0 1 1 *')!;
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(0, 0, 1, 2, 0))).toBe(false);
  });

  // #121: a bad field used to parse into a matcher that never fired, so the
  // task silently never ran. The expression is rejected now (the scheduler
  // warns and skips it).
  it('rejects unknown field syntax and out-of-range values', () => {
    expect(parseCron('abc * * * *')).toBeNull();
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('* 5-3 * * *')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull();
  });
});

describe('cron semantics (#121)', () => {
  it('a step on a range: 0-23/6 is hours 0, 6, 12 and 18, not every hour', () => {
    const cron = parseCron('0 0-23/6 * * *')!;
    expect([0, 6, 12, 18].every((h) => cronMatches(cron, date(0, h, 15, 1, 0)))).toBe(true);
    expect(cronMatches(cron, date(0, 1, 15, 1, 0))).toBe(false);
  });

  it('n/step starts at n: 5/20 is minutes 5, 25 and 45', () => {
    const cron = parseCron('5/20 * * * *')!;
    expect([5, 25, 45].every((m) => cronMatches(cron, date(m, 3, 15, 1, 0)))).toBe(true);
    expect(cronMatches(cron, date(0, 3, 15, 1, 0))).toBe(false);
  });

  it('weekday 7 is Sunday, like 0', () => {
    const cron = parseCron('0 9 * * 7')!;
    const sunday = new Date(2026, 9, 18, 9, 0); // Sun 18 Oct 2026
    expect(sunday.getDay()).toBe(0);
    expect(cronMatches(cron, sunday)).toBe(true);
  });

  it('day-of-month and weekday both restricted: either one fires (POSIX)', () => {
    const cron = parseCron('0 9 1 * 1')!; // the 1st, and every Monday
    expect(cronMatches(cron, new Date(2026, 9, 1, 9, 0))).toBe(true); // Thu 1 Oct
    expect(cronMatches(cron, new Date(2026, 9, 19, 9, 0))).toBe(true); // Mon 19 Oct
    expect(cronMatches(cron, new Date(2026, 9, 20, 9, 0))).toBe(false); // Tue 20 Oct
  });

  it('with one of them unrestricted, both must match as before', () => {
    const cron = parseCron('0 9 * * 1')!;
    expect(cronMatches(cron, new Date(2026, 9, 19, 9, 0))).toBe(true);
    expect(cronMatches(cron, new Date(2026, 9, 20, 9, 0))).toBe(false);
  });
});
