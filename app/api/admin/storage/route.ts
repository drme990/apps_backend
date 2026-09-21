import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPageAccess } from '@/lib/auth';
import { listR2Objects, deleteR2Folder, deleteMultipleR2Objects, type R2FolderStructure } from '@/lib/services/r2';

// Public CDN URL for R2 objects (e.g. https://storage.manasik.net)
const publicUrl = process.env.R2_PUBLIC_URL || '';

// Simple in-memory cache for list operations
const listCache = new Map<string, { data: R2FolderStructure; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(prefix: string): string {
  return `list:${prefix}`;
}

function getFromCache(key: string): R2FolderStructure | null {
  const cached = listCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > CACHE_TTL) {
    listCache.delete(key);
    return null;
  }

  return cached.data;
}

function setCache(key: string, data: R2FolderStructure): void {
  listCache.set(key, { data, timestamp: Date.now() });
}

function clearCache(prefix?: string): void {
  if (prefix) {
    // Clear all cache entries that start with the prefix
    for (const key of listCache.keys()) {
      if (key.startsWith(`list:${prefix}`)) {
        listCache.delete(key);
      }
    }
  } else {
    // Clear all cache
    listCache.clear();
  }
}

// GET /api/storage - List objects in R2
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('storage-manager');
    if ('error' in auth) return auth.error;

    const { searchParams } = new URL(request.url);
    const prefix = searchParams.get('prefix') || '';

    const cacheKey = getCacheKey(prefix);
    const cached = getFromCache(cacheKey);

    if (cached) {
      return NextResponse.json({ success: true, data: cached, publicUrl, cached: true });
    }

    const data = await listR2Objects(prefix);
    setCache(cacheKey, data);

    return NextResponse.json({ success: true, data, publicUrl, cached: false });
  } catch (error) {
    console.error('Error listing storage:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to list storage' },
      { status: 500 }
    );
  }
}

// DELETE /api/storage - Delete objects or folders
//
// Protected folders: shared global assets that must never be bulk-deleted
// because they're referenced by many projects/templates. Deleting these
// would break designs across the entire system.
const PROTECTED_FOLDER_PREFIXES = [
  'design/shapes/',         // shared PNG shapes used by all projects/templates
  'design/fonts/',          // shared font files used by all projects
  'design/template-bg/',    // template background images — shared by
  // duplicates and order designs (which inherit
  // the template's bg URL by reference). Bulk
  // deletion would break all templates and
  // their generated order designs.
  'design/projects-images/',   // layer images referenced by URL inside
  // project `layers` data — the key has no projectId segment so the same
  // image is commonly shared between a template, its duplicates, and the
  // order designs inflated from it. Deleting here breaks live designs.
  'design/orders-design/versions/',  // immutable version archives — every
  // `design_order_versions` doc points at one; deleting breaks "restore
  // version" in the admin panel.
];

function isProtectedKey(key: string): boolean {
  return PROTECTED_FOLDER_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('storage-manager');
    if ('error' in auth) return auth.error;

    const body = await request.json();
    const { keys, folder } = body;

    if (folder) {
      // Block deletion of protected shared folders — in BOTH directions:
      // the folder itself / anything inside it (`folder.startsWith(prefix)`)
      // AND any parent of a protected folder (`prefix.startsWith(folder)`),
      // so deleting "design/" can't wipe the protected subtrees.
      const normalizedFolder = folder.endsWith('/') ? folder : `${folder}/`;
      if (PROTECTED_FOLDER_PREFIXES.some((prefix) =>
        normalizedFolder === prefix ||
        normalizedFolder.startsWith(prefix) ||
        prefix.startsWith(normalizedFolder),
      )) {
        return NextResponse.json(
          {
            success: false,
            error: `Cannot delete protected folder "${folder}". This folder contains shared assets used by all projects.`,
          },
          { status: 403 },
        );
      }
      // Delete entire folder
      const count = await deleteR2Folder(folder);
      clearCache(folder);
      console.log(`[DELETE /api/admin/storage] Folder "${folder}" deleted (${count} objects)`);
      return NextResponse.json({ success: true, deletedCount: count });
    }

    if (keys && Array.isArray(keys)) {
      // Filter out any protected keys (safety net)
      const safeKeys = keys.filter((k: string) => !isProtectedKey(k));
      const blockedCount = keys.length - safeKeys.length;
      if (blockedCount > 0) {
        console.warn(
          `[DELETE /api/admin/storage] Blocked deletion of ${blockedCount} protected key(s): ` +
          keys.filter((k: string) => isProtectedKey(k)).join(', '),
        );
      }

      if (safeKeys.length === 0) {
        return NextResponse.json(
          {
            success: false,
            error: 'All specified keys are protected shared assets and cannot be deleted.',
          },
          { status: 403 },
        );
      }

      const result = await deleteMultipleR2Objects(safeKeys);

      // Clear cache for affected prefixes
      for (const key of safeKeys) {
        const prefix = key.substring(0, key.lastIndexOf('/'));
        clearCache(prefix ? `${prefix}/` : '');
      }

      console.log(`[DELETE /api/admin/storage] Deleted ${safeKeys.length} key(s)${blockedCount > 0 ? ` (${blockedCount} blocked)` : ''}`);
      return NextResponse.json({ success: true, ...result });
    }

    return NextResponse.json(
      { success: false, error: 'No keys or folder specified' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Error deleting from storage:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete from storage' },
      { status: 500 }
    );
  }
}
