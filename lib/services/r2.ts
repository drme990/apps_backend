import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
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

  const key = `${folder}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '')}`;
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

export const isR2Url = (url: string): boolean => {
  if (!publicUrl) return false;
  return url.startsWith(publicUrl);
};

export const extractR2Key = (url: string): string | null => {
  if (!publicUrl) return null;
  if (!url.startsWith(publicUrl)) return null;
  return url.replace(`${publicUrl}/`, '');
};
