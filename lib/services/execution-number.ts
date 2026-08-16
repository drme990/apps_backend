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
