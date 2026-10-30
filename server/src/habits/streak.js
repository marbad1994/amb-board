import { addDays } from '../finance/money.js';

// Pure, deterministic streak maths. `dates` is a set/array of 'YYYY-MM-DD' completion dates, `today` is injected.

export function dailyStreak(dates, today) {
  const set = new Set(dates);
  // today not yet done does not break the streak; it simply has not been extended yet
  let cursor = set.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (set.has(cursor)) { current += 1; cursor = addDays(cursor, -1); }
  const sorted = [...set].sort();
  let longest = 0; let run = 0; let prev = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  return { current, longest };
}

// Monday of the ISO week containing date.
export function weekStart(date) {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

// A week counts when it has >= target completions. The week in progress extends the streak only if already met.
export function weeklyStreak(dates, target, today) {
  const counts = {};
  for (const d of new Set(dates)) counts[weekStart(d)] = (counts[weekStart(d)] || 0) + 1;
  const met = (w) => (counts[w] || 0) >= target;
  let w = weekStart(today);
  let current = 0;
  if (met(w)) current += 1;
  w = addDays(w, -7);
  while (met(w)) { current += 1; w = addDays(w, -7); }
  const weeks = Object.keys(counts).filter(met).sort();
  let longest = 0; let run = 0; let prev = null;
  for (const wk of weeks) {
    run = prev && addDays(prev, 7) === wk ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = wk;
  }
  return { current, longest };
}

export function streakFor(habit, dates, today) {
  return habit.frequency === 'daily' ? dailyStreak(dates, today) : weeklyStreak(dates, habit.target_per_week, today);
}
