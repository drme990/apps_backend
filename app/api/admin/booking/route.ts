import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Booking from '@/lib/models/Booking';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { bookingUpdateSchema } from '@/lib/validation/schemas';
import {
  parseCutoffTime,
  getDefaultCutoffTime,
  autoResetDayEndIfStale,
} from '@/lib/execution-date';

function normalizeBlockedDates(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const normalized = input
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));

  return Array.from(new Set(normalized)).sort();
}

/**
 * Get the effective UTC offset in minutes for Egypt, respecting the
 * manual summer-time override.
 *
 * - `true`  → 180 (UTC+3, summer time active)
 * - `false` → 120 (UTC+2, standard time — Egypt abolished DST in 2014)
 * - `null`/`undefined` → auto-detect from `Africa/Cairo` IANA timezone
 *   (fallback for legacy data that predates the toggle)
 */
function getEgyptOffsetMinutes(summerTime: boolean | null | undefined): number {
  if (summerTime === true) return 180;  // UTC+3 — summer time
  if (summerTime === false) return 120; // UTC+2 — standard time

  // Auto-detect only for null/undefined (legacy data without the flag)
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Cairo',
    timeZoneName: 'shortOffset',
  }).formatToParts(now);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName');
  if (offsetPart) {
    const match = offsetPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (match) {
      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const minutes = match[3] ? parseInt(match[3], 10) : 0;
      return sign * (hours * 60 + minutes);
    }
  }
  return 120;
}

function toEgyptDateString(date: Date, summerTime: boolean | null | undefined): string {
  const offsetMs = getEgyptOffsetMinutes(summerTime) * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isCurrentEgyptDay(
  dateIso: string,
  summerTime: boolean | null | undefined = undefined,
): boolean {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return false;

  const egyptToday = toEgyptDateString(new Date(), summerTime);
  const dateEgypt = toEgyptDateString(date, summerTime);

  return dateEgypt === egyptToday;
}

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('booking');
    if ('error' in auth) return auth.error;

    // Auto-reset stale day-end before returning
    let booking = await autoResetDayEndIfStale();

    if (!booking) {
      await Booking.create({
        key: 'global',
        cutoffTime: getDefaultCutoffTime(),
      });
      booking = await Booking.findOne({ key: 'global' }).lean();
    }

    // Normalize legacy ISO cutoffTime to HH:mm for the client
    const normalizedCutoff = booking?.cutoffTime
      ? parseCutoffTime(booking.cutoffTime)
      : null;

    // Convert Mongoose Map to plain object for JSON response
    const rawTolerances = booking?.paymentMethodTolerances;
    const tolerances: Record<string, { type: string; value: number }> = {};
    if (rawTolerances && typeof rawTolerances === 'object') {
      for (const [key, val] of Object.entries(rawTolerances as Record<string, unknown>)) {
        if (val && typeof val === 'object' && 'type' in val && 'value' in val) {
          tolerances[key] = val as { type: string; value: number };
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking?.blockedExecutionDates ?? [],
        cutoffTime: normalizedCutoff ?? getDefaultCutoffTime(),
        lastDayEndAt: booking?.lastDayEndAt ?? null,
        defaultExecutionDate: booking?.defaultExecutionDate ?? null,
        summerTimeEnabled: booking?.summerTimeEnabled ?? false,
        paymentMethodTolerances: tolerances,
      },
    });
  } catch (error) {
    console.error('Error fetching booking settings:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch booking settings' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('booking');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, bookingUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const update: Record<string, unknown> = {};

    if (body.blockedExecutionDates !== undefined) {
      update.blockedExecutionDates = normalizeBlockedDates(
        body.blockedExecutionDates,
      );
    }

    if (body.cutoffTime !== undefined) {
      if (body.cutoffTime === null) {
        update.cutoffTime = null;
      } else {
        const parsedCutoff = parseCutoffTime(body.cutoffTime);
        if (!parsedCutoff) {
          return NextResponse.json(
            { success: false, error: 'Invalid cutoff time format' },
            { status: 400 },
          );
        }
        update.cutoffTime = parsedCutoff;
      }
    }

    if (body.lastDayEndAt !== undefined) {
      if (body.lastDayEndAt === null) {
        // OPEN DAY: restore defaultExecutionDate from prevDay
        const current = await Booking.findOne({ key: 'global' }).lean();
        if (current?.prevDay) {
          update.defaultExecutionDate = current.prevDay;
          update.prevDay = null;
        }
        update.lastDayEndAt = null;
      } else {
        // Fetch current booking to get summerTimeEnabled for correct
        // Egypt day validation
        const currentForCheck = await Booking.findOne({ key: 'global' }).lean();
        const summerTime = currentForCheck?.summerTimeEnabled;
        if (!isCurrentEgyptDay(body.lastDayEndAt, summerTime)) {
          return NextResponse.json(
            {
              success: false,
              error: 'lastDayEndAt must be set for the current Egypt day only',
            },
            { status: 400 },
          );
        }
        // END DAY: save current defaultExecutionDate to prevDay, then advance +1
        const current = currentForCheck;
        const today = toEgyptDateString(new Date(), summerTime);
        const addOneDay = (d: string) => {
          const [y, m, day] = d.split('-').map(Number);
          const date = new Date(Date.UTC(y, m - 1, day));
          date.setUTCDate(date.getUTCDate() + 1);
          return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
        };

        update.prevDay = current?.defaultExecutionDate ?? addOneDay(today);
        update.defaultExecutionDate = addOneDay(
          current?.defaultExecutionDate ?? addOneDay(today),
        );
        update.lastDayEndAt = body.lastDayEndAt;
      }
    }

    if (body.defaultExecutionDate !== undefined) {
      const currentForDate = await Booking.findOne({ key: 'global' }).lean();
      const summerTime = currentForDate?.summerTimeEnabled;
      const today = toEgyptDateString(new Date(), summerTime);
      const addOneDay = (d: string) => {
        const [y, m, day] = d.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, day));
        date.setUTCDate(date.getUTCDate() + 1);
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      };
      const tomorrow = addOneDay(today);
      const dayAfterTomorrow = addOneDay(tomorrow);

      const allowed = [today, tomorrow, dayAfterTomorrow];
      if (!allowed.includes(body.defaultExecutionDate)) {
        return NextResponse.json(
          {
            success: false,
            error: `defaultExecutionDate must be one of ${allowed.join(', ')}`,
          },
          { status: 400 },
        );
      }
      update.defaultExecutionDate = body.defaultExecutionDate;
    }

    if (body.prevDay !== undefined) {
      update.prevDay = body.prevDay;
    }

    if (body.summerTimeEnabled !== undefined) {
      update.summerTimeEnabled = body.summerTimeEnabled;
    }

    if (body.paymentMethodTolerances !== undefined) {
      // Validate and normalize the tolerances map
      const tolerances = body.paymentMethodTolerances;
      if (tolerances === null) {
        update.paymentMethodTolerances = {};
      } else if (typeof tolerances === 'object' && !Array.isArray(tolerances)) {
        const normalized: Record<string, { type: 'percentage' | 'fixnumber'; value: number }> = {};
        for (const [method, config] of Object.entries(tolerances)) {
          if (
            config &&
            typeof config === 'object' &&
            (config.type === 'percentage' || config.type === 'fixnumber') &&
            typeof config.value === 'number' &&
            config.value >= 0
          ) {
            normalized[method] = { type: config.type, value: config.value };
          }
        }
        update.paymentMethodTolerances = normalized;
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No fields to update' },
        { status: 400 },
      );
    }

    // Always ensure the document exists
    const existing = await Booking.findOne({ key: 'global' }).lean();
    if (!existing) {
      await Booking.create({ key: 'global' });
    }

    await Booking.findOneAndUpdate(
      { key: 'global' },
      { $set: update },
      { upsert: true, new: true, runValidators: true },
    );

    const booking = await Booking.findOne({ key: 'global' }).lean();
    if (!booking) {
      return NextResponse.json(
        { success: false, error: 'Booking document not found after update' },
        { status: 500 },
      );
    }

    const changedFields = Object.keys(update).join(', ');
    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'booking',
      resourceId: booking._id.toString(),
      details: `Updated booking settings: ${changedFields}`,
    });

    const rawTolerancesResp = booking?.paymentMethodTolerances;
    const tolerancesResponse: Record<string, { type: string; value: number }> = {};
    if (rawTolerancesResp && typeof rawTolerancesResp === 'object') {
      for (const [key, val] of Object.entries(rawTolerancesResp as Record<string, unknown>)) {
        if (val && typeof val === 'object' && 'type' in val && 'value' in val) {
          tolerancesResponse[key] = val as { type: string; value: number };
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking?.blockedExecutionDates ?? [],
        cutoffTime: parseCutoffTime(booking?.cutoffTime ?? '') ?? getDefaultCutoffTime(),
        lastDayEndAt: booking?.lastDayEndAt ?? null,
        defaultExecutionDate: booking?.defaultExecutionDate ?? null,
        summerTimeEnabled: booking?.summerTimeEnabled ?? false,
        paymentMethodTolerances: tolerancesResponse,
      },
    });
  } catch (error) {
    console.error('Error updating booking settings:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update booking settings' },
      { status: 500 },
    );
  }
}
