// Delivery lead time rule, identical to backend/lib/delivery-lead-time.js:
// the earliest rental start is `leadDays` calendar days after today on the German
// calendar (Europe/Berlin). 0 = today, 1 = tomorrow, 2 = the day after, ...
// The browser's own time zone is deliberately not used.

const berlinDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in Germany as YYYY-MM-DD. */
export function berlinToday(now: Date = new Date()): string {
  return berlinDateFormat.format(now);
}

/** Adds calendar days to a YYYY-MM-DD string (pure date arithmetic, no DST effects). */
export function addDaysToDateString(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function earliestStartDate(leadDays: number, now: Date = new Date()): string {
  return addDaysToDateString(berlinToday(now), leadDays);
}
