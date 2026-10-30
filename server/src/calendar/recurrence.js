import { addDays, addMonths } from '../finance/money.js';

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; }
}

// Offset (ms) of timeZone from UTC at the given instant.
function offsetAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in a zone -> UTC ISO string. Times skipped by a spring-forward gap move forward;
// ambiguous fall-back times resolve to the first occurrence.
export function wallToUtc(date, time, timeZone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - offsetAt(guess, timeZone);
  utc = guess - offsetAt(utc, timeZone);
  return new Date(utc).toISOString();
}

// Expands one event into occurrences whose local start date is within [from, to] (inclusive, YYYY-MM-DD).
// The wall-clock time is preserved across DST, so the UTC instant shifts when the offset does.
export function occurrences(ev, from, to, cap = 400) {
  const startDate = ev.start_local.slice(0, 10);
  const time = ev.all_day ? '00:00' : ev.start_local.slice(11, 16);
  const endDate = ev.end_local ? ev.end_local.slice(0, 10) : startDate;
  const endTime = ev.end_local && !ev.all_day ? ev.end_local.slice(11, 16) : null;
  const spanDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400_000);
  const out = [];
  let i = 0;
  let date = startDate;
  const anchorDay = Number(startDate.slice(8, 10));
  const limit = ev.recurrence_until && ev.recurrence_until < to ? ev.recurrence_until : to;
  while (date <= limit && out.length < cap) {
    if (date >= from || addDays(date, spanDays) >= from) {
      const occEnd = addDays(date, spanDays);
      out.push({
        date,
        start_local: ev.all_day ? date : `${date}T${time}`,
        end_local: ev.end_local ? (ev.all_day ? occEnd : `${occEnd}T${endTime}`) : null,
        start_utc: ev.all_day ? null : wallToUtc(date, time, ev.timezone),
      });
    }
    if (ev.recurrence === 'none') break;
    i += 1;
    const step = i * ev.recurrence_interval;
    date = ev.recurrence === 'daily' ? addDays(startDate, step)
      : ev.recurrence === 'weekly' ? addDays(startDate, step * 7)
      : ev.recurrence === 'monthly' ? addMonths(startDate, step, anchorDay)
      : addMonths(startDate, step * 12, anchorDay);
  }
  return out.filter((o) => o.date <= to);
}
