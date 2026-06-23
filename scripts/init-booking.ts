/// <reference types="node" />
import { connectDB } from '../lib/db';
import Booking from '../lib/models/Booking';
import {
  computeDefaultExecutionDate,
  parseCutoffTime,
  getDefaultCutoffTime,
  autoResetDayEndIfStale,
} from '../lib/execution-date';

async function main() {
  await connectDB();

  let booking = await Booking.findOne({ key: 'global' }).lean();

  if (!booking) {
    console.log('Creating global booking document...');
    await Booking.create({
      key: 'global',
      cutoffTime: getDefaultCutoffTime(),
    });
    booking = await Booking.findOne({ key: 'global' }).lean();
    console.log('Created with default cutoff:', booking?.cutoffTime);
  } else {
    console.log('Global booking document exists.');
  }

  // Migrate legacy cutoffTime values (ISO datetime or HH:mm) to normalized HH:mm
  if (booking.cutoffTime) {
    const normalized = parseCutoffTime(booking.cutoffTime);
    if (normalized && normalized !== booking.cutoffTime) {
      console.log(
        `Migrating cutoffTime "${booking.cutoffTime}" -> "${normalized}"`,
      );
      await Booking.updateOne(
        { key: 'global' },
        { $set: { cutoffTime: normalized } },
      );
      booking = { ...booking, cutoffTime: normalized };
    } else if (!normalized) {
      console.log(
        `Clearing invalid cutoffTime: "${booking.cutoffTime}"`,
      );
      await Booking.updateOne(
        { key: 'global' },
        { $set: { cutoffTime: getDefaultCutoffTime() } },
      );
      booking = { ...booking, cutoffTime: getDefaultCutoffTime() };
    }
  }

  // Auto-reset stale day-end before recomputing
  const resetBooking = await autoResetDayEndIfStale();
  if (resetBooking) {
    booking = resetBooking;
    console.log('Auto-reset stale day-end.');
  }

  // Recompute and fix stale defaultExecutionDate
  const computed = computeDefaultExecutionDate(booking);
  if (booking.defaultExecutionDate !== computed) {
    console.log(
      `Updating defaultExecutionDate: "${booking.defaultExecutionDate}" -> "${computed}"`,
    );
    await Booking.updateOne(
      { key: 'global' },
      { $set: { defaultExecutionDate: computed } },
    );
  } else {
    console.log(`defaultExecutionDate is up to date: "${computed}"`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((error) => {
  console.error('init-booking error:', error);
  process.exit(1);
});
