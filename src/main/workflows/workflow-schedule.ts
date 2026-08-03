/**
 * Parses the friendly schedule strings the workflow editor accepts
 * ("Daily, 9:00 AM", "Weekly, Mon 10:00 AM", "Every 30 minutes") into something
 * the scheduler can compare against the clock.
 *
 * Only these shapes are understood on purpose: the field is free text in the UI,
 * so anything unparseable must degrade to "never fires automatically" rather
 * than guessing and running a workflow at the wrong time.
 */
export type WorkflowSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };

const weekdays: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** Returns null when the text is not a schedule this app knows how to fire. */
export function parseSchedule(raw: string | null | undefined): WorkflowSchedule | null {
  const text = raw?.trim().toLowerCase();
  if (!text) return null;

  const everyMinutes = matchInterval(text);
  if (everyMinutes) return everyMinutes;

  const time = matchTime(text);
  // A clock-shaped token that failed to parse ("Daily, 99:99") must not fall back
  // to the default hour. The author clearly meant a specific time, so defaulting
  // to 9:00 AM would run the workflow at a time nobody asked for. A schedule with
  // no time token at all ("Daily") is different, and still takes the default.
  if (!time && /\d{1,2}:\d{1,2}/.test(text)) return null;

  if (text.startsWith("weekly") || findWeekday(text) !== null) {
    const weekday = findWeekday(text);
    if (weekday === null) return null;
    return { kind: "weekly", weekday, hour: time?.hour ?? 9, minute: time?.minute ?? 0 };
  }

  if (text.startsWith("monthly")) {
    const day = matchMonthDay(text) ?? 1;
    return { kind: "monthly", day, hour: time?.hour ?? 9, minute: time?.minute ?? 0 };
  }

  if (text.startsWith("daily") || text.startsWith("every day") || (time && /^[\d:\sapm.]+$/.test(text))) {
    return { kind: "daily", hour: time?.hour ?? 9, minute: time?.minute ?? 0 };
  }

  return null;
}

/**
 * The latest moment this schedule should have fired at or before `now`, or null
 * when it has never come due yet (e.g. a monthly schedule in a shorter month).
 */
export function previousOccurrence(schedule: WorkflowSchedule, now: Date): Date | null {
  switch (schedule.kind) {
    case "interval": {
      const period = schedule.minutes * 60_000;
      return new Date(Math.floor(now.getTime() / period) * period);
    }
    case "daily": {
      const candidate = atTime(now, schedule.hour, schedule.minute);
      if (candidate <= now) return candidate;
      candidate.setDate(candidate.getDate() - 1);
      return candidate;
    }
    case "weekly": {
      const candidate = atTime(now, schedule.hour, schedule.minute);
      const drift = (candidate.getDay() - schedule.weekday + 7) % 7;
      candidate.setDate(candidate.getDate() - drift);
      if (candidate > now) candidate.setDate(candidate.getDate() - 7);
      return candidate;
    }
    case "monthly": {
      for (let monthsBack = 0; monthsBack < 3; monthsBack += 1) {
        const month = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
        const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        if (schedule.day > lastDay) continue;
        const candidate = new Date(
          month.getFullYear(),
          month.getMonth(),
          schedule.day,
          schedule.hour,
          schedule.minute,
          0,
          0,
        );
        if (candidate <= now) return candidate;
      }
      return null;
    }
  }
}

function atTime(reference: Date, hour: number, minute: number): Date {
  const candidate = new Date(reference);
  candidate.setHours(hour, minute, 0, 0);
  return candidate;
}

function matchInterval(text: string): WorkflowSchedule | null {
  if (/^hourly\b/.test(text) || /^every hour\b/.test(text)) return { kind: "interval", minutes: 60 };

  const match = /every\s+(\d+)?\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/.exec(text);
  if (!match) return null;

  const count = Number(match[1] ?? "1");
  if (!Number.isFinite(count) || count <= 0) return null;
  const perUnit = match[2].startsWith("h") ? 60 : 1;
  return { kind: "interval", minutes: Math.min(count * perUnit, 60 * 24 * 7) };
}

function matchTime(text: string): { hour: number; minute: number } | null {
  // A bare number can also be a day of month ("monthly 15th at 9:00"), so only
  // fall back to one when the text holds no explicit clock time.
  const match =
    /(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(text) ??
    /\b(\d{1,2})()\s*(am|pm)\b/.exec(text) ??
    /\b(\d{1,2})()\b/.exec(text);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = match[3];
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;

  return { hour, minute };
}

function findWeekday(text: string): number | null {
  for (const [name, value] of Object.entries(weekdays)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return value;
  }
  return null;
}

function matchMonthDay(text: string): number | null {
  const match = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text.replace(/\d{1,2}:\d{2}/g, " "));
  if (!match) return null;
  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : null;
}
