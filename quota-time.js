// Quota period helpers — the GSC indexing "day" resets at 1 PM Pacific Time.

/**
 * Get the current Pacific date and hour using Intl (handles DST automatically).
 */
function _getPacificNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    year: parseInt(get("year")),
    month: parseInt(get("month")),
    day: parseInt(get("day")),
    hour: parseInt(get("hour")),
  };
}

/**
 * Return a stable period ID string for the current quota window.
 * The window runs from 1 PM Pacific to 1 PM Pacific the next day.
 * Before 1 PM → belongs to previous day's window.
 */
function getQuotaPeriodId() {
  const p = _getPacificNow();
  let y = p.year, m = p.month, d = p.day;
  if (p.hour < 13) {
    // Still in yesterday's window — roll back one day
    const prev = new Date(y, m - 1, d - 1); // JS Date handles month/year rollover
    y = prev.getFullYear();
    m = prev.getMonth() + 1;
    d = prev.getDate();
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}T13`;
}

/**
 * Return the UTC timestamp (ms) of the next 1 PM Pacific reset.
 */
function getNextResetMs() {
  const p = _getPacificNow();
  let targetDate;
  if (p.hour < 13) {
    // Next reset is today at 1 PM Pacific
    targetDate = new Date(p.year, p.month - 1, p.day);
  } else {
    // Next reset is tomorrow at 1 PM Pacific
    targetDate = new Date(p.year, p.month - 1, p.day + 1);
  }

  // Build a date string for the target day at 13:00 in Pacific, then find its UTC equivalent.
  // We iterate to handle the DST offset of the *target* day (not today).
  const iso = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}-${String(targetDate.getDate()).padStart(2, "0")}`;

  // Start with a rough guess: target day 13:00 at -08:00 (PST), then adjust if the
  // target day is actually in PDT (UTC-7).
  const guess = new Date(`${iso}T13:00:00-08:00`); // assume PST first
  const checkParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit", hour12: false,
  }).formatToParts(guess);
  const checkHour = parseInt(checkParts.find((p) => p.type === "hour").value);

  if (checkHour === 14) {
    // We're in PDT (UTC-7), so -08:00 was wrong by 1 hour — adjust
    return guess.getTime() - 3600000;
  }
  return guess.getTime();
}
