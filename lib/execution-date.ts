import type { IBooking } from '@/lib/models/Booking';
import Booking from '@/lib/models/Booking';

const EGYPT_TIMEZONE = 'Africa/Cairo';

/**
 * Get the current date in Egypt as a YYYY-MM-DD string.
 */
function getEgyptToday(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EGYPT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}

/**
 * Get current time-of-day in Egypt as HH:mm string.
 */
function getEgyptTime(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: EGYPT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(now);
}

/**
 * Add days to a YYYY-MM-DD string and return the new YYYY-MM-DD string.
 */
function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Check if the current Egypt time is at or after the given cutoff HH:mm.
 */
function isAtOrAfterCutoff(cutoffTime: string | null | undefined): boolean {
  if (!cutoffTime) return false;

  const [cutoffHours, cutoffMinutes] = cutoffTime.split(':').map(Number);
  const [egyptHours, egyptMinutes] = getEgyptTime().split(':').map(Number);

  if (egyptHours > cutoffHours) return true;
  if (egyptHours < cutoffHours) return false;
  return egyptMinutes >= cutoffMinutes;
}

/**
 * Extract HH:mm from a string, handling both "HH:mm" and legacy ISO formats.
 */
function extractTime(value: string): string | null {
  if (/^\d{2}:\d{2}$/.test(value)) return value;

  const isoMatch = value.match(/T(\d{2}):(\d{2}):/);
  if (isoMatch) return `${isoMatch[1]}:${isoMatch[2]}`;

  return null;
}

/**
 * Check if a date string is in the blocked dates set.
 */
function isBlocked(dateStr: string, blockedDates: Set<string>): boolean {
  return blockedDates.has(dateStr);
}

/**
 * Skip blocked dates by adding days until a non-blocked date is found.
 */
function skipBlockedDates(
  dateStr: string,
  blockedDates: Set<string>,
): string {
  let candidate = dateStr;
  let iterations = 0;
  const MAX_ITERATIONS = 365;
  while (isBlocked(candidate, blockedDates) && iterations < MAX_ITERATIONS) {
    candidate = addDays(candidate, 1);
    iterations += 1;
  }
  return candidate;
}

/**
 * Check if lastDayEndAt is for the current Egypt day.
 */
function isDayEndedToday(lastDayEndAt: string | null | undefined): boolean {
  if (!lastDayEndAt) return false;
  const endedDate = new Date(lastDayEndAt);
  if (Number.isNaN(endedDate.getTime())) return false;

  const egyptToday = getEgyptToday();
  const endedEgyptDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: EGYPT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(endedDate);

  return endedEgyptDate === egyptToday;
}

/**
 * Check if lastDayEndAt is for a PREVIOUS Egypt day (stale / auto-reset needed).
 */
function isDayEndedYesterday(
  lastDayEndAt: string | null | undefined,
): boolean {
  if (!lastDayEndAt) return false;
  const endedDate = new Date(lastDayEndAt);
  if (Number.isNaN(endedDate.getTime())) return false;

  const egyptToday = getEgyptToday();
  const endedEgyptDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: EGYPT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(endedDate);

  return endedEgyptDate < egyptToday;
}

/**
 * Compute the default execution date.
 *
 * Rules:
 * 1. Start from the stored defaultExecutionDate, or tomorrow if none.
 * 2. If the stored date is in the past (<= today), catch up to tomorrow.
 * 3. If the stored date is "tomorrow" and the daily cutoff has passed → push to day-after-tomorrow.
 * 4. If the admin manually ended the day today → push one more day forward.
 * 5. Skip any blocked dates.
 */
export function computeDefaultExecutionDate(
  booking: Pick<IBooking, 'cutoffTime' | 'lastDayEndAt' | 'blockedExecutionDates' | 'defaultExecutionDate'>,
): string {
  const today = getEgyptToday();
  const tomorrow = addDays(today, 1);
  const blockedDates = new Set(
    (booking.blockedExecutionDates ?? []).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    ),
  );

  // Phase 1: start from stored value or tomorrow
  let base = booking.defaultExecutionDate || tomorrow;

  // If the stored date is stale (today or earlier), catch up
  if (base <= today) {
    base = tomorrow;
  }

  // If the stored date is exactly "tomorrow" and we've passed the daily cutoff → push forward
  if (base === tomorrow && isAtOrAfterCutoff(booking.cutoffTime)) {
    base = addDays(base, 1);
  }

  base = skipBlockedDates(base, blockedDates);

  // Phase 2: apply manual day-end push
  if (isDayEndedToday(booking.lastDayEndAt)) {
    base = addDays(base, 1);
    base = skipBlockedDates(base, blockedDates);
  }

  return base;
}

/**
 * If lastDayEndAt is from a previous Egypt day, auto-reset:
 * - Restore defaultExecutionDate from prevDay
 * - Clear lastDayEndAt and prevDay
 *
 * Returns the updated (or original) booking document.
 */
export async function autoResetDayEndIfStale(): Promise<IBooking | null> {
  const booking = await Booking.findOne({ key: 'global' }).lean();
  if (!booking) return null;

  if (isDayEndedYesterday(booking.lastDayEndAt)) {
    const restored = booking.prevDay || booking.defaultExecutionDate;
    await Booking.updateOne(
      { key: 'global' },
      {
        $set: {
          defaultExecutionDate: restored,
          lastDayEndAt: null,
          prevDay: null,
        },
      },
    );
    return { ...booking, defaultExecutionDate: restored, lastDayEndAt: null, prevDay: null };
  }

  return booking;
}

/**
 * Compute the live defaultExecutionDate and update the DB cache if stale.
 * Call this at the start of checkout.
 *
 * 1. Auto-reset stale day-end if needed
 * 2. Compute the date from cutoffTime + lastDayEndAt
 * 3. Update DB cache if changed
 */
export async function refreshDefaultExecutionDateCache(): Promise<string> {
  let booking = await autoResetDayEndIfStale();
  if (!booking) {
    const created = await Booking.create({
      key: 'global',
      cutoffTime: '02:00',
    });
    return computeDefaultExecutionDate(created);
  }

  // Re-fetch if auto-reset happened (booking is already updated, but let's be safe)
  if (!booking._id) {
    booking = await Booking.findOne({ key: 'global' }).lean();
  }

  const computed = computeDefaultExecutionDate(booking);
  if (booking.defaultExecutionDate !== computed) {
    await Booking.updateOne(
      { key: 'global' },
      { $set: { defaultExecutionDate: computed } },
    );
  }
  return computed;
}

/**
 * Parse and normalize a cutoff time input.
 * Accepts HH:mm or legacy ISO strings, always returns HH:mm or null.
 */
export function parseCutoffTime(value: string | null): string | null {
  if (!value) return null;

  const normalized = extractTime(value);
  if (!normalized) return null;

  const [hours, minutes] = normalized.split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;

  return normalized;
}

/**
 * Return the default cutoff time as HH:mm.
 */
export function getDefaultCutoffTime(): string {
  return '02:00';
}
