import Product from '@/lib/models/Product';
import Appearance from '@/lib/models/Appearance';
import Transaction from '@/lib/models/Transaction';
import {
  deleteFileFromR2,
  deleteVideoFromR2,
  extractR2Key,
  isDesignOwnedKey,
} from '@/lib/services/r2';

/**
 * Delete R2 files for media removed from a product — but only when no
 * other document still references the same URL.
 *
 * Product media files are shared by URL: duplicating a product copies the
 * same media URLs, and appearance banners / works images can reference
 * uploaded files too. Deleting the file while another document still
 * points at it produces a permanently broken image, so every deletion
 * goes through this reference check first.
 *
 * Soft-deleted products count as references on purpose — restoring one
 * must not surface broken images.
 *
 * Best-effort: failures are logged, never thrown.
 */
export async function cleanupRemovedProductMedia(
  removedUrls: string[],
  excludeProductId: string,
): Promise<void> {
  for (const url of removedUrls) {
    try {
      const key = extractR2Key(url);
      if (!key || isDesignOwnedKey(key)) continue;

      const [otherProduct, appearance] = await Promise.all([
        Product.exists({
          _id: { $ne: excludeProductId },
          'media.url': url,
        }),
        Appearance.exists({
          $or: [
            { 'productsBanners.imageUrl': url },
            { 'worksImages.row1': url },
            { 'worksImages.row2': url },
            { 'audioReviews.url': url },
            { 'audioReviews.userImage': url },
          ],
        }),
      ]);
      if (otherProduct || appearance) continue;

      if (key.startsWith('products/videos/')) {
        await deleteVideoFromR2(key);
      } else {
        await deleteFileFromR2(key);
      }
    } catch (error) {
      console.error('[product-media-cleanup] failed for URL:', url, error);
    }
  }
}

/**
 * Delete R2 files removed from an appearance document — same rules as
 * product media: only after a successful save, and only when no other
 * appearance doc (any project) or product still references the URL.
 */
export async function cleanupRemovedAppearanceMedia(
  removedUrls: string[],
  excludeProject: string,
): Promise<void> {
  for (const url of removedUrls) {
    try {
      const key = extractR2Key(url);
      if (!key || isDesignOwnedKey(key)) continue;

      const [otherAppearance, product] = await Promise.all([
        Appearance.exists({
          project: { $ne: excludeProject },
          $or: [
            { 'productsBanners.imageUrl': url },
            { 'worksImages.row1': url },
            { 'worksImages.row2': url },
            { 'audioReviews.url': url },
            { 'audioReviews.userImage': url },
          ],
        }),
        Product.exists({ 'media.url': url }),
      ]);
      if (otherAppearance || product) continue;

      await deleteFileFromR2(key);
    } catch (error) {
      console.error('[appearance-media-cleanup] failed for URL:', url, error);
    }
  }
}

/**
 * Delete a supplier-transaction attachment from R2 after the transaction
 * was updated or deleted — only when no other transaction still
 * references the same URL.
 */
export async function cleanupRemovedTransactionAttachment(
  url: string,
  excludeTransactionId: string,
): Promise<void> {
  try {
    const key = extractR2Key(url);
    if (!key || isDesignOwnedKey(key)) return;

    const other = await Transaction.exists({
      _id: { $ne: excludeTransactionId },
      attachment: url,
    });
    if (other) return;

    await deleteFileFromR2(key);
  } catch (error) {
    console.error('[transaction-attachment-cleanup] failed for URL:', url, error);
  }
}
