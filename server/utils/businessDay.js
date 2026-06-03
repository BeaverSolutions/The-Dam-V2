'use strict';

const MALAYSIA_TIME_ZONE = 'Asia/Kuala_Lumpur';

function todayInMalaysia(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MALAYSIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function dayOfWeekFromDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextBusinessDate(dateKey, holidays = new Set()) {
  let current = String(dateKey).slice(0, 10);
  let guard = 0;
  while (guard++ < 365) {
    const day = dayOfWeekFromDateKey(current);
    if (day === 6) current = addDaysToDateKey(current, 2);
    else if (day === 0) current = addDaysToDateKey(current, 1);

    if (holidays.has(current)) {
      current = addDaysToDateKey(current, 1);
      continue;
    }
    return current;
  }
  throw new Error(`nextBusinessDate: exceeded 365 iterations from ${dateKey}`);
}

module.exports = {
  MALAYSIA_TIME_ZONE,
  addDaysToDateKey,
  nextBusinessDate,
  todayInMalaysia,
};
