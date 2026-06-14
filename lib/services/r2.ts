import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Readable } from 'node:stream';

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME || 'media';
const publicUrl = process.env.R2_PUBLIC_URL || '';

// Keep these values conservative and high enough for larger video uploads.
const R2_CONNECTION_TIMEOUT_MS = 50_000;
const R2_REQUEST_TIMEOUT_MS = 40 * 60 * 1000;
const R2_SOCKET_TIMEOUT_MS = 40 * 60 * 1000;
const R2_MAX_ATTEMPTS = 3;

function sanitizeObjectName(name: string): string {
  return name.replace(/[^a-zA-Z0-9.-]/g, '');
}

function buildObjectKey(folder: string, name: string): string {
  return `${folder}/${Date.now()}-${sanitizeObjectName(name)}`;
}

export const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: accessKeyId || '',
    secretAccessKey: secretAccessKey || '',
  },
  maxAttempts: R2_MAX_ATTEMPTS,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
    requestTimeout: R2_REQUEST_TIMEOUT_MS,
    socketTimeout: R2_SOCKET_TIMEOUT_MS,
  }),
  // Request checksum calculation should only happen when required by the service,
  // not in flexible mode which adds extra checksum headers that can cause signature mismatches
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

async function readAwsErrorBodySnippet(body: unknown): Promise<string> {
  if (!body) return '';

  try {
    if (
      typeof body === 'object' &&
      body !== null &&
      'transformToString' in body &&
      typeof (body as { transformToString?: unknown }).transformToString ===
        'function'
    ) {
      const text = await (
        body as { transformToString: () => Promise<string> }
      ).transformToString();
      return text.slice(0, 500);
    }

    if (body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (chunks.reduce((acc, item) => acc + item.length, 0) > 1024) break;
      }
      return Buffer.concat(chunks).toString('utf8').slice(0, 500);
    }
  } catch {
    return '';
  }

  return '';
}

export const uploadVideoToR2 = async (
  file: File,
  folder: string = 'products/videos',
): Promise<{ url: string; key: string }> => {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are missing');
  }

  const key = buildObjectKey(folder, file.name);
  const bodyBuffer = Buffer.from(await file.arrayBuffer());

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: bodyBuffer,
    ContentLength: bodyBuffer.length,
    ContentType: file.type,
  });

  try {
    await s3Client.send(command);
  } catch (error) {
    const awsError = error as {
      name?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
      $response?: { body?: unknown };
    };

    const rawBodySnippet = await readAwsErrorBodySnippet(
      awsError.$response?.body,
    );

    console.error('R2 upload failed', {
      name: awsError.name,
      message: awsError.message,
      httpStatusCode: awsError.$metadata?.httpStatusCode,
      responseSnippet: rawBodySnippet,
    });

    throw error;
  }

  return {
    url: `${publicUrl}/${key}`,
    key,
  };
};

export const uploadFileToR2 = async (
  file: File,
  folder: string = 'products/images',
): Promise<{ url: string; key: string }> => {
  return uploadVideoToR2(file, folder);
};

export const deleteVideoFromR2 = async (key: string): Promise<boolean> => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error('Error deleting from R2:', error);
    return false;
  }
};

export const deleteFileFromR2 = async (key: string): Promise<boolean> => {
  return deleteVideoFromR2(key);
};

export const isR2Url = (url: string): boolean => {
  if (!publicUrl) return false;
  return url.startsWith(publicUrl);
};

export const extractR2Key = (url: string): string | null => {
  if (!publicUrl) return null;
  if (!url.startsWith(publicUrl)) return null;
  return url.replace(`${publicUrl}/`, '');
};

/**
 * Generate a presigned URL for direct client-side upload to R2
 * Clients upload directly to R2 using this URL (PUT request)
 * This enables real progress tracking in the browser
 */
export const generatePresignedUploadUrl = async (
  fileName: string,
  contentType: string,
  folder: string = 'products/videos',
  expiresIn: number = 900, // URL expires in 15 minutes by default
): Promise<{ uploadUrl: string; key: string; publicUrl: string }> => {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are missing');
  }

  const key = `${folder}/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '')}`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
    // Disable flexible checksums to avoid signature mismatch with R2
    ChecksumAlgorithm: undefined,
  });

  try {
    const uploadUrl = await getSignedUrl(s3Client as any, command, {
      expiresIn,
    });

    return {
      uploadUrl,
      key,
      publicUrl: `${publicUrl}/${key}`,
    };
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw error;
  }
};

export interface R2Object {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
  isFolder: boolean;
}

export interface R2FolderStructure {
  folders: string[];
  files: R2Object[];
}

/**
 * List objects in R2 bucket with optional prefix (folder)
 */
export const listR2Objects = async (
  prefix: string = '',
  delimiter: string = '/',
): Promise<R2FolderStructure> => {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are missing');
  }

  // Ensure prefix ends with / if it's not empty (for proper folder listing)
  const normalizedPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;

  const command = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: normalizedPrefix,
    Delimiter: delimiter,
  });

  try {
    const response = await s3Client.send(command);
    
    const folders: string[] = [];
    const files: R2Object[] = [];

    // Extract folders (CommonPrefixes)
    if (response.CommonPrefixes) {
      for (const commonPrefix of response.CommonPrefixes) {
        if (commonPrefix.Prefix) {
          // Remove trailing slash and prefix to get folder name
          const folderName = commonPrefix.Prefix
            .replace(normalizedPrefix, '')
            .replace(/\/$/, '');
          if (folderName) {
            folders.push(folderName);
          }
        }
      }
    }

    // Extract files (Contents)
    if (response.Contents) {
      for (const object of response.Contents) {
        if (object.Key && object.Key !== normalizedPrefix) {
          files.push({
            key: object.Key,
            size: object.Size || 0,
            lastModified: object.LastModified || new Date(),
            etag: object.ETag || '',
            isFolder: false,
          });
        }
      }
    }

    return { folders, files };
  } catch (error) {
    console.error('Error listing R2 objects:', error);
    throw error;
  }
};

/**
 * Get object metadata
 */
export const getR2ObjectMetadata = async (key: string): Promise<{
  size: number;
  lastModified: Date;
  contentType: string;
}> => {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are missing');
  }

  const command = new HeadObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    const response = await s3Client.send(command);
    return {
      size: response.ContentLength || 0,
      lastModified: response.LastModified || new Date(),
      contentType: response.ContentType || 'application/octet-stream',
    };
  } catch (error) {
    console.error('Error getting R2 object metadata:', error);
    throw error;
  }
};

/**
 * Generate a presigned URL for downloading an object
 */
export const generatePresignedDownloadUrl = async (
  key: string,
  expiresIn: number = 3600, // URL expires in 1 hour by default
): Promise<string> => {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are missing');
  }

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    return await getSignedUrl(s3Client as any, command, { expiresIn });
  } catch (error) {
    console.error('Error generating presigned download URL:', error);
    throw error;
  }
};

/**
 * Delete multiple objects from R2
 */
export const deleteMultipleR2Objects = async (keys: string[]): Promise<{ deleted: string[]; failed: string[] }> => {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are missing');
  }

  if (keys.length === 0) {
    return { deleted: [], failed: [] };
  }

  const command = new DeleteObjectsCommand({
    Bucket: bucketName,
    Delete: {
      Objects: keys.map((key) => ({ Key: key })),
      Quiet: false,
    },
  });

  try {
    const response = await s3Client.send(command);
    const deleted = response.Deleted?.map((item) => item.Key!) || [];
    const failed = response.Errors?.map((item) => item.Key!) || [];
    return { deleted, failed };
  } catch (error) {
    console.error('Error deleting multiple R2 objects:', error);
    throw error;
  }
};

/**
 * Delete all objects in a folder (recursive)
 */
export const deleteR2Folder = async (prefix: string): Promise<number> => {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are missing');
  }

  // First, list all objects with the prefix
  const listCommand = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
  });

  try {
    const listResponse = await s3Client.send(listCommand);
    const keys = listResponse.Contents?.map((obj) => obj.Key!).filter(Boolean) || [];

    if (keys.length === 0) {
      return 0;
    }

    // Delete all objects
    const deleteResult = await deleteMultipleR2Objects(keys);
    return deleteResult.deleted.length;
  } catch (error) {
    console.error('Error deleting R2 folder:', error);
    throw error;
  }
};
