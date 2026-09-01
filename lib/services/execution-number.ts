import ExecutionNumberCounter from '@/lib/models/ExecutionNumberCounter';

/**
 * Extract the execution date (YYYY-MM-DD) from an order's reservationData.
 */
export function getOrderExecutionDate(order: {
  reservationData?: Array<{ key: string; value: string }> | undefined;
}): string | null {
  const value = order.reservationData?.find((r) => r.key === 'executionDate')?.value;
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

/**
 * Allocate the next execution number for the given execution date.
 *
 * Uses an atomic findOneAndUpdate with $inc on a per-date counter
 * document, so concurrent order saves cannot receive the same number.
 */
export async function allocateExecutionNumber(executionDate: string): Promise<number> {
  const counter = await ExecutionNumberCounter.findOneAndUpdate(
    { _id: executionDate },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true },
  );

  if (!counter) {
    throw new Error(`Failed to allocate execution number for ${executionDate}`);
  }

  return counter.seq;
}

/**
 * Renumber all paid/partial-paid orders on the given execution date so
 * they form a clean, gap-free 1..N sequence sorted by createdAt.
 *
 * This should be called whenever an order leaves a date (its execution
 * date changed, or its status moved away from paid/partial-paid) so the
 * remaining orders on that day don't have gaps like 1, 2, 4, 5, 8.
 *
 * The per-date counter is also reset to the new highest number so future
 * allocations continue from N+1.
 *
 * Best-effort: errors are logged but not thrown, so a failed renumber
 * never blocks the originating save.
 */
export async function renumberExecutionDay(executionDate: string): Promise<void> {
  if (!executionDate) return;

  try {
    // Lazy import to avoid circular dependency: Order.ts imports from
    // this module, and this function needs Order.
    const { default: Order } = await import('@/lib/models/Order');

    // Find all paid/partial-paid orders whose reservationData has
    // executionDate === executionDate, sorted by createdAt ascending
    // so the oldest order gets #1.
    const orders = await Order.find(
      {
        status: { $in: ['paid', 'partial-paid'] },
        reservationData: {
          $elemMatch: { key: 'executionDate', value: executionDate },
        },
      },
      { _id: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .lean();

    if (orders.length === 0) {
      // No orders left on this date — reset the counter to 0.
      await ExecutionNumberCounter.findByIdAndUpdate(
        executionDate,
        { $set: { seq: 0 } },
        { upsert: true },
      );
      return;
    }

    // Assign sequential numbers 1..N
    const bulkOps = orders.map((order, index) => ({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { executionNumber: index + 1 } },
      },
    }));

    await Order.bulkWrite(bulkOps, { ordered: false });

    // Reset the per-date counter to N so the next allocation gives N+1.
    await ExecutionNumberCounter.findByIdAndUpdate(
      executionDate,
      { $set: { seq: orders.length } },
      { upsert: true },
    );
  } catch (error) {
    console.error(
      `[renumberExecutionDay] Failed to renumber execution date ${executionDate}:`,
      error,
    );
  }
}
