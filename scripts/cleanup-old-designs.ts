/**
 * Script: Delete all order designs from PREVIOUS months.
 *
 * For every order created BEFORE the current month that has `designUrls`:
 *   1. Deletes each design image from R2 storage
 *   2. Removes the `designUrls` array from the order document
 *   3. Deletes all `OrderDesignVersion` records for those orders
 *   4. Deletes all `OrderDesignLog` records for those orders
 *
 * Orders from the CURRENT month are kept untouched.
 *
 * Usage:
 *   npx tsx scripts/cleanup-old-designs.ts
 *
 * With --dry-run flag, only prints what would be deleted without
 * actually deleting anything:
 *   npx tsx scripts/cleanup-old-designs.ts --dry-run
 */

import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Order, { type IOrder } from '../lib/models/Order';
import OrderDesignVersion from '../lib/models/OrderDesignVersion';
import OrderDesignLog from '../lib/models/OrderDesignLog';
import {
  extractR2Key,
  isR2Url,
  s3Client,
} from '../lib/services/r2';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

const isDryRun = process.argv.includes('--dry-run');

/**
 * Extract the R2 object key from a design URL.
 *
 * Design URLs look like:
 *   https://storage.manasik.net/design/orders-design/versions/MNK-.../v1.jpg
 *   https://storage.manasik.net/design/orders-design/MNK-....jpg
 *
 * The R2 key is everything after the first `/` following the domain.
 * We try the standard extractR2Key first (uses R2_PUBLIC_URL env), and
 * fall back to manual extraction for URLs on the storage domain.
 */
function getR2KeyFromUrl(url: string): string | null {
  // Try the standard extractor first
  const key = extractR2Key(url);
  if (key) return key;

  // Fallback: extract key from any HTTPS URL by removing the protocol + domain
  try {
    const parsed = new URL(url);
    // The key is the pathname without the leading slash
    const pathname = parsed.pathname.replace(/^\/+/, '');
    if (pathname) return pathname;
  } catch {
    // Not a valid URL
  }

  return null;
}

/**
 * Check if a URL is an R2/storage URL (regardless of env config).
 */
function isStorageUrl(url: string): boolean {
  if (isR2Url(url)) return true;
  // Check common storage domains
  return (
    url.includes('storage.manasik.net') ||
    url.includes('r2.cloudflarestorage.com') ||
    url.includes('r2.dev')
  );
}

/**
 * Delete an R2 object by its URL. Works even when R2_PUBLIC_URL is not set.
 */
async function deleteR2Url(url: string): Promise<boolean> {
  const key = getR2KeyFromUrl(url);
  if (!key) return false;

  if (isDryRun) {
    console.log(`    [DRY RUN] Would delete R2 key: ${key}`);
    return true;
  }

  try {
    const bucketName = process.env.R2_BUCKET_NAME || 'media';
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    await s3Client.send(command);
    console.log(`    Deleted R2 key: ${key}`);
    return true;
  } catch (error) {
    console.error(`    FAILED to delete R2 key: ${key}`, error);
    return false;
  }
}

async function cleanupOldDesigns() {
  await connectDB();

  // ── Current month boundary ──────────────────────────────────────
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  console.log(
    `Cleanup old designs — ${isDryRun ? '[DRY RUN] ' : ''}deleting designs for orders created before ${monthStart.toISOString().split('T')[0]}`,
  );

  // Find all orders before this month that have design URLs
  const cursor = Order.find({
    createdAt: { $lt: monthStart },
    'designUrls.0': { $exists: true },
  }).cursor();

  let scanned = 0;
  let r2Deleted = 0;
  let r2Failed = 0;
  let ordersUpdated = 0;
  const orderNumbersProcessed: string[] = [];

  for await (const rawOrder of cursor) {
    const order = rawOrder as unknown as IOrder & { save: () => Promise<unknown> };
    scanned += 1;

    const designUrls = order.designUrls || [];
    if (designUrls.length === 0) continue;

    console.log(
      `  Order ${order.orderNumber}: ${designUrls.length} design URL(s)`,
    );

    // ── 1. Delete each design from R2 ────────────────────────────
    for (const design of designUrls) {
      if (!design.url || !isStorageUrl(design.url)) {
        console.log(`    Skip (not storage): ${design.url}`);
        continue;
      }

      const ok = await deleteR2Url(design.url);
      if (ok) {
        r2Deleted++;
      } else {
        r2Failed++;
      }
    }

    // ── 2. Clear designUrls on the order ─────────────────────────
    if (!isDryRun) {
      order.designUrls = [];
      await order.save();
      ordersUpdated++;
    } else {
      ordersUpdated++;
    }

    orderNumbersProcessed.push(order.orderNumber);
  }

  // ── 3. Delete OrderDesignVersion records for these orders ───────
  if (orderNumbersProcessed.length > 0) {
    if (isDryRun) {
      const count = await OrderDesignVersion.countDocuments({
        orderNumber: { $in: orderNumbersProcessed },
      });
      console.log(`\n[DRY RUN] Would delete ${count} OrderDesignVersion record(s)`);
    } else {
      const result = await OrderDesignVersion.deleteMany({
        orderNumber: { $in: orderNumbersProcessed },
      });
      console.log(`\nDeleted ${result.deletedCount} OrderDesignVersion record(s)`);
    }
  }

  // ── 4. Delete OrderDesignLog records for these orders ───────────
  if (orderNumbersProcessed.length > 0) {
    if (isDryRun) {
      const count = await OrderDesignLog.countDocuments({
        orderNumber: { $in: orderNumbersProcessed },
      });
      console.log(`[DRY RUN] Would delete ${count} OrderDesignLog record(s)`);
    } else {
      const result = await OrderDesignLog.deleteMany({
        orderNumber: { $in: orderNumbersProcessed },
      });
      console.log(`Deleted ${result.deletedCount} OrderDesignLog record(s)`);
    }
  }

  console.log(`\n${isDryRun ? '[DRY RUN] ' : ''}Summary:`);
  console.log(`  Orders scanned:    ${scanned}`);
  console.log(`  Orders updated:    ${ordersUpdated}`);
  console.log(`  R2 files deleted:  ${r2Deleted}`);
  console.log(`  R2 files failed:   ${r2Failed}`);
}

cleanupOldDesigns()
  .catch((error) => {
    console.error('Failed to cleanup old designs:', error);
    throw error;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
