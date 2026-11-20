// domain.js — pure logic for the clock-in PWA. No DOM, no I/O.
// All times are local time. Clock-in/out are "HH:MM" strings; a day record
// belongs to its clock-in date. Durations always use times floored DOWN to
// the 15-minute boundary.

export const TARGET_AVERAGE = 8.1;
export const QUARTER_MINUTES = 15;

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function monthKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function parseHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function minutesToHHMM(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function floorToQuarterMinutes(mins) {
  return Math.floor(mins / QUARTER_MINUTES) * QUARTER_MINUTES;
}

/** Floor an "HH:MM" string down to the 15-minute boundary, e.g. "10:07" -> "10:00". */
export function floorHHMM(hhmm) {
  const mins = parseHHMM(hhmm);
  if (mins === null) return null;
  return minutesToHHMM(floorToQuarterMinutes(mins));
}

/**
 * Duration in minutes between floored clock-in and clock-out.
 * clockOut <= clockIn means the shift ended after midnight (overnight).
 * Returns null when either time is missing/invalid.
 */
export function durationMinutes(clockIn, clockOut) {
  const inM = parseHHMM(clockIn);
  const outM = parseHHMM(clockOut);
  if (inM === null || outM === null) return null;
  const fi = floorToQuarterMinutes(inM);
  let fo = floorToQuarterMinutes(outM);
  if (fo <= fi) fo += 1440;
  return fo - fi;
}

/** Minutes -> one-decimal hours, e.g. 495 -> 8.3. */
export function hoursDecimal(minutes) {
  return Number((minutes / 60).toFixed(1));
}

export function roundToQuarter(hours) {
  return Math.round(hours * 4) / 4;
}

// ---------------------------------------------------------------------------
// US federal holidays (with observed-day shifting: Sat -> preceding Fri,
// Sun -> following Mon). Generated for a range of years so cross-year
// observed days (e.g. Dec 31 / Jan 2) are covered.
// ---------------------------------------------------------------------------

function nthWeekday(year, month0, weekday, n) {
  const first = new Date(year, month0, 1);
  const delta = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month0, 1 + delta + (n - 1) * 7);
}

function lastWeekday(year, month0, weekday) {
  const last = new Date(year, month0 + 1, 0);
  const delta = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month0 + 1, 0 - delta);
}

function observed(date) {
  const d = new Date(date);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  else if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
}

/** The 11 US federal holidays for one year, as a Set of "YYYY-MM-DD" (observed dates). */
export function federalHolidays(year) {
  const days = [
    observed(new Date(year, 0, 1)), // New Year's Day
    nthWeekday(year, 0, 1, 3), // MLK Day — 3rd Mon of Jan
    nthWeekday(year, 1, 1, 3), // Presidents Day — 3rd Mon of Feb
    lastWeekday(year, 4, 1), // Memorial Day — last Mon of May
    observed(new Date(year, 5, 19)), // Juneteenth
    observed(new Date(year, 6, 4)), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day — 1st Mon of Sep
    nthWeekday(year, 9, 1, 2), // Columbus Day — 2nd Mon of Oct
    observed(new Date(year, 10, 11)), // Veterans Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving — 4th Thu of Nov
    observed(new Date(year, 11, 25)), // Christmas Day
  ];
  return new Set(days.map(dateKey));
}

/** Holidays for year-1, year and year+1, so observed days crossing a year boundary are included. */
export function holidaySetAround(year) {
  const set = new Set();
  for (const y of [year - 1, year, year + 1]) {
    for (const d of federalHolidays(y)) set.add(d);
  }
  return set;
}

export function isWorkday(date, holidays) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(dateKey(date));
}

/** Count workdays from start to end inclusive (Mon–Fri, excluding holidays). */
export function countWorkdays(start, end, holidays) {
  let count = 0;
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (d <= last) {
    if (isWorkday(d, holidays)) count += 1;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/**
 * Auto remaining workdays: weekdays from TOMORROW through month-end,
 * excluding US federal holidays. Today is never counted.
 */
export function autoRemainingDays(today, holidays) {
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  if (tomorrow > monthEnd) return 0;
  return countWorkdays(tomorrow, monthEnd, holidays);
}

/** Completed days in a calendar month. In-progress (open) shifts are excluded. */
export function monthStats(days, year, month0) {
  let completedDays = 0;
  let completedMinutes = 0;
  for (const day of days) {
    const d = parseDateKey(day.date);
    if (d.getFullYear() !== year || d.getMonth() !== month0) continue;
    if (!day.clockOut) continue;
    const dur = durationMinutes(day.clockIn, day.clockOut);
    if (dur === null) continue;
    completedDays += 1;
    completedMinutes += dur;
  }
  return { completedDays, completedMinutes, completedHours: completedMinutes / 60 };
}

/**
 * Required daily average for the remaining workdays so the final monthly
 * average lands on target (default 8.1). Rounded to the nearest 0.25 hour.
 * Returns null when there are no remaining workdays.
 */
export function forecastRequired(completedDays, completedHours, remainingDays, target = TARGET_AVERAGE) {
  if (remainingDays <= 0) return null;
  const raw = (target * (completedDays + remainingDays) - completedHours) / remainingDays;
  return Math.max(0, roundToQuarter(raw));
}
