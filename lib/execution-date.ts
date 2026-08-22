import type { IBooking } from '@/lib/models/Booking';
import Booking from '@/lib/models/Booking';
import type { IOrder } from '@/lib/models/Order';

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
 * Get the current time in Egypt as HH:mm.
 */
function getEgyptNowTime(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: EGYPT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(now);
}

/**
 * Compare two HH:mm time strings.
 * Returns: negative if a < b, 0 if equal, positive if a > b.
 */
function compareTimeStrings(a: string, b: string): number {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return (ah * 60 + am) - (bh * 60 + bm);
}

/**
 * Check if the current time is at or after the cutoff on the given execution date.
 *
 * cutoffTime is HH:mm (e.g. "02:00") in Egypt local time.
 * baseDate is the execution date (YYYY-MM-DD).
 *
 * Instead of constructing an absolute timestamp with a hardcoded offset
 * (which breaks during DST), we compare in Egypt local time directly:
 * - Get the current Egypt date and time
 * - If today's Egypt date > baseDate → the day has fully passed → after cutoff
 * - If today's Egypt date == baseDate → compare times: if now >= cutoff → after cutoff
 * - If today's Egypt date < baseDate → before cutoff
 *
 * This correctly handles Egypt's DST transitions (UTC+2 in winter, UTC+3 in summer)
 * because Intl.DateTimeFormat with timeZone: 'Africa/Cairo' always returns the
 * correct local time regardless of the UTC offset.
 */
function isAtOrAfterCutoff(
  cutoffTime: string | null | undefined,
  baseDate: string,
): boolean {
  if (!cutoffTime || !baseDate) return false;

  const egyptToday = getEgyptToday();
  const egyptNowTime = getEgyptNowTime();

  // If the current Egypt date is past the base date, the cutoff has passed
  if (egyptToday > baseDate) return true;
  // If the current Egypt date is before the base date, cutoff hasn't reached
  if (egyptToday < baseDate) return false;

  // Same day — compare times
  return compareTimeStrings(egyptNowTime, cutoffTime) >= 0;
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
export function skipBlockedDates(
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
 * 2. If the stored date is strictly in the past (< today), catch up to today
 *    so we evaluate the cutoff on today's execution date.
 * 3. Apply the cutoff ON the current execution date (base). If the current
 *    Egypt local time has reached or passed the cutoff on base, advance to
 *    the next day. The cutoff is evaluated in Egypt local time (Africa/Cairo)
 *    to correctly handle DST transitions (UTC+2 winter, UTC+3 summer).
 * 4. Skip any blocked dates.
 * 5. If the admin manually ended the day today → push one more day forward.
 */
export function computeDefaultExecutionDate(
  booking: Pick<IBooking, 'cutoffTime' | 'lastDayEndAt' | 'blockedExecutionDates' | 'defaultExecutionDate' | 'prevDay'>,
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

  // If the stored date is strictly in the past, catch up to today so we can
  // evaluate the cutoff on today's execution date instead of yesterday's.
  if (base < today) {
    base = today;
  }

  // The cutoff is applied ON the execution date (base), in Egypt local time.
  // Example: base=2026-06-25, cutoff=02:00, Egypt now=2026-06-25 01:00
  //   → same day, 01:00 < 02:00 → false → keep 2026-06-25
  // Example: base=2026-06-25, cutoff=02:00, Egypt now=2026-06-25 02:30
  //   → same day, 02:30 >= 02:00 → true → advance to 2026-06-26
  // Example: base=2026-06-25, cutoff=02:00, Egypt now=2026-06-26 00:00
  //   → Egypt date > base → true → advance to 2026-06-26
  if (isAtOrAfterCutoff(booking.cutoffTime, base)) {
    base = addDays(base, 1);
  }

  base = skipBlockedDates(base, blockedDates);

  // Phase 2: apply manual day-end push
  // When the admin ends the day via the booking page, prevDay is saved and
  // defaultExecutionDate is already incremented. Don't double-count.
  if (isDayEndedToday(booking.lastDayEndAt)) {
    const alreadyAdvanced = !!booking.prevDay && base > booking.prevDay;
    if (!alreadyAdvanced) {
      base = addDays(base, 1);
      base = skipBlockedDates(base, blockedDates);
    }
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
    const refreshed = await Booking.findOne({ key: 'global' }).lean();
    if (!refreshed) return computeDefaultExecutionDate(booking);
    booking = refreshed;
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
 * Check if the given reference time is at or after the cutoff on the given date.
 *
 * cutoffTime is HH:mm (e.g. "02:00") in Egypt local time.
 * baseDate is YYYY-MM-DD.
 * refTime is a Date instance (any timezone — we convert to Egypt time).
 *
 * Uses the same DST-safe approach as isAtOrAfterCutoff: convert refTime to
 * Egypt local date + time, then compare.
 */
function isRefAtOrAfterCutoff(
  cutoffTime: string | null | undefined,
  baseDate: string,
  refTime: Date,
): boolean {
  if (!cutoffTime || !baseDate) return false;

  const refEgyptDate = getEgyptDateString(refTime);
  const refEgyptTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: EGYPT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(refTime);

  // If the reference date is past the base date, the cutoff has passed
  if (refEgyptDate > baseDate) return true;
  // If the reference date is before the base date, cutoff hasn't reached
  if (refEgyptDate < baseDate) return false;

  // Same day — compare times
  return compareTimeStrings(refEgyptTime, cutoffTime) >= 0;
}

/**
 * Get a YYYY-MM-DD string from a Date in the Egypt timezone.
 */
function getEgyptDateString(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EGYPT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Recompute an order's execution date when its status changes to paid/partial-paid.
 *
 * Rules:
 * 1. The relevant moment is the order's statusUpdateTime (when it became paid).
 * 2. Use the date part of that moment as the base.
 * 3. If the time is at or after the cutoff, push to the next day (because orders
 *    paid after the cutoff cannot be processed on that day).
 * 4. The result cannot be earlier than the order's createdAt date or the current
 *    executionDate value (preserves user-selected future dates).
 * 5. Skip any blocked dates.
 */
export function recomputeOrderExecutionDate(
  order: Pick<IOrder, 'createdAt' | 'statusUpdateTime' | 'reservationData'>,
  cutoffTime: string | null | undefined,
  blockedExecutionDates: string[],
  defaultExecutionDate: string | null | undefined,
): string | null {
  if (!order.statusUpdateTime) return null;

  const paidAt = new Date(order.statusUpdateTime);
  const createdAt = new Date(order.createdAt || paidAt);

  const paidDate = getEgyptDateString(paidAt);
  const nextDay = addDays(paidDate, 1);

  const afterCutoff = isRefAtOrAfterCutoff(cutoffTime, paidDate, paidAt);
  let candidate = afterCutoff ? nextDay : paidDate;

  // Cannot execute before the order was created
  const createdAtDate = getEgyptDateString(createdAt);
  if (candidate < createdAtDate) {
    candidate = createdAtDate;
  }

  // Preserve any user-selected future execution date (can't be earlier)
  const currentExecutionDate = (order.reservationData || [])
    .find((r) => r.key === 'executionDate')?.value;
  if (
    currentExecutionDate &&
    /^\d{4}-\d{2}-\d{2}$/.test(currentExecutionDate) &&
    currentExecutionDate > candidate
  ) {
    candidate = currentExecutionDate;
  }

  // Also respect the global default execution date (can't execute before today)
  if (defaultExecutionDate && candidate < defaultExecutionDate) {
    candidate = defaultExecutionDate;
  }

  const blockedDates = new Set(
    (blockedExecutionDates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  );

  return skipBlockedDates(candidate, blockedDates);
}

/**
 * Recompute an order's execution date when its invoice is confirmed.
 *
 * The invoice confirmation is the moment the order becomes "ready" for
 * execution. If the confirmation happens after the day's cutoff time,
 * the order cannot be processed on that day and must roll to the next.
 *
 * Rules:
 * 1. The relevant moment is "now" (when the admin confirms the invoice).
 * 2. Use the order's current execution date as the base.
 * 3. If the current time is at or after the cutoff on the execution date,
 *    push to the next day.
 * 4. Skip any blocked dates.
 * 5. Never move the date backwards — only forward.
 */
export function recomputeExecutionDateOnInvoiceConfirmed(
  order: Pick<IOrder, 'reservationData'>,
  booking: IBooking,
): string | null {
  // Extract the current execution date from reservationData
  const currentExecutionDate = (order.reservationData || [])
    .find((r) => r.key === 'executionDate')?.value;
  if (!currentExecutionDate || !/^\d{4}-\d{2}-\d{2}$/.test(currentExecutionDate)) {
    return null;
  }

  const now = new Date();
  const nowEgyptDate = getEgyptDateString(now);

  // If the execution date is in the future relative to today, keep it —
  // the order is already scheduled for a future day and confirming the
  // invoice doesn't change that.
  if (currentExecutionDate > nowEgyptDate) {
    return null;
  }

  // Check if "now" is at or after the cutoff on the execution date.
  // If the execution date is today (or past), evaluate the cutoff on it.
  const afterCutoff = isRefAtOrAfterCutoff(
    booking.cutoffTime,
    currentExecutionDate,
    now,
  );

  if (!afterCutoff) {
    // Still before cutoff on the execution date — keep the date as is.
    return null;
  }

  // Push to the next day and skip blocked dates
  const blockedDates = new Set(
    (booking.blockedExecutionDates || []).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    ),
  );

  let candidate = addDays(currentExecutionDate, 1);
  candidate = skipBlockedDates(candidate, blockedDates);

  // Also respect the global default execution date (can't execute before today)
  if (booking.defaultExecutionDate && candidate < booking.defaultExecutionDate) {
    candidate = booking.defaultExecutionDate;
    candidate = skipBlockedDates(candidate, blockedDates);
  }

  if (candidate === currentExecutionDate) return null;
  return candidate;
}

/**
 * Update an order's reservationData with the recomputed execution date.
 * Mutates the order document in place (Mongoose subdocuments are mutable arrays).
 * Returns the new execution date or null if no change was needed.
 */
export function updateOrderExecutionDateOnPaid(
  order: IOrder,
  booking: IBooking,
): string | null {
  if (!order.statusUpdateTime) return null;

  const newExecutionDate = recomputeOrderExecutionDate(
    order,
    booking.cutoffTime,
    booking.blockedExecutionDates || [],
    booking.defaultExecutionDate,
  );
  if (!newExecutionDate) return null;

  const reservation = (order.reservationData || []).find(
    (r) => r.key === 'executionDate',
  );
  if (!reservation) return null;

  if (reservation.value === newExecutionDate) return null;

  reservation.value = newExecutionDate;
  return newExecutionDate;
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
