import { NextRequest, NextResponse } from 'next/server';
import { listR2Objects, deleteR2Folder, deleteMultipleR2Objects, generatePresignedDownloadUrl } from '@/lib/services/r2';

// Simple in-memory cache for list operations
const listCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(prefix: string): string {
  return `list:${prefix}`;
}

function getFromCache(key: string): any | null {
  const cached = listCache.get(key);
  if (!cached) return null;
  
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    listCache.delete(key);
    return null;
  }
  
  return cached.data;
}

function setCache(key: string, data: any): void {
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
    const { searchParams } = new URL(request.url);
    const prefix = searchParams.get('prefix') || '';
    
    const cacheKey = getCacheKey(prefix);
    const cached = getFromCache(cacheKey);
    
    if (cached) {
      return NextResponse.json({ success: true, data: cached, cached: true });
    }
    
    const data = await listR2Objects(prefix);
    setCache(cacheKey, data);
    
    return NextResponse.json({ success: true, data, cached: false });
  } catch (error) {
    console.error('Error listing storage:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to list storage' },
      { status: 500 }
    );
  }
}

// DELETE /api/storage - Delete objects or folders
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { keys, folder } = body;
    
    if (folder) {
      // Delete entire folder
      const count = await deleteR2Folder(folder);
      clearCache(folder);
      return NextResponse.json({ success: true, deletedCount: count });
    }
    
    if (keys && Array.isArray(keys)) {
      // Delete multiple objects
      const result = await deleteMultipleR2Objects(keys);
      
      // Clear cache for affected prefixes
      for (const key of keys) {
        const prefix = key.substring(0, key.lastIndexOf('/'));
        clearCache(prefix ? `${prefix}/` : '');
      }
      
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
