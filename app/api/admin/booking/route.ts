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

function isCurrentEgyptDay(dateIso: string): boolean {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return false;

  const egyptToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const dateEgypt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

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

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking?.blockedExecutionDates ?? [],
        cutoffTime: normalizedCutoff ?? getDefaultCutoffTime(),
        lastDayEndAt: booking?.lastDayEndAt ?? null,
        defaultExecutionDate: booking?.defaultExecutionDate ?? null,
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
        if (!isCurrentEgyptDay(body.lastDayEndAt)) {
          return NextResponse.json(
            {
              success: false,
              error: 'lastDayEndAt must be set for the current Egypt day only',
            },
            { status: 400 },
          );
        }
        // END DAY: save current defaultExecutionDate to prevDay, then advance +1
        const current = await Booking.findOne({ key: 'global' }).lean();
        const today = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Africa/Cairo',
        }).format(new Date());
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
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
      }).format(new Date());
      const addOneDay = (d: string) => {
        const [y, m, day] = d.split('-').map(Number);
        const date = new Date(Date.UTC(y, m - 1, day));
        date.setUTCDate(date.getUTCDate() + 1);
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      };
      const tomorrow = addOneDay(today);
      const dayAfterTomorrow = addOneDay(tomorrow);

      if (body.defaultExecutionDate !== tomorrow && body.defaultExecutionDate !== dayAfterTomorrow) {
        return NextResponse.json(
          {
            success: false,
            error: `defaultExecutionDate must be either ${tomorrow} or ${dayAfterTomorrow}`,
          },
          { status: 400 },
        );
      }
      update.defaultExecutionDate = body.defaultExecutionDate;
    }

    if (body.prevDay !== undefined) {
      update.prevDay = body.prevDay;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No fields to update' },
        { status: 400 },
      );
    }

    // Always ensure the document exists
    let existing = await Booking.findOne({ key: 'global' }).lean();
    if (!existing) {
      await Booking.create({ key: 'global' });
    }

    await Booking.findOneAndUpdate(
      { key: 'global' },
      { $set: update },
      { upsert: true, new: true, runValidators: true },
    );

    const booking = await Booking.findOne({ key: 'global' }).lean();

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

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking?.blockedExecutionDates ?? [],
        cutoffTime: parseCutoffTime(booking?.cutoffTime ?? '') ?? getDefaultCutoffTime(),
        lastDayEndAt: booking?.lastDayEndAt ?? null,
        defaultExecutionDate: booking?.defaultExecutionDate ?? null,
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
