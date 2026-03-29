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

export const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKeyId || '',
    secretAccessKey: secretAccessKey || '',
  },
  requestHandler: new NodeHttpHandler({
    requestTimeout: 120_000,
    socketTimeout: 120_000,
  }),
});

export const uploadVideoToR2 = async (
  file: File,
  folder: string = 'products/videos',
): Promise<{ url: string; key: string }> => {
  const key = `${folder}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '')}`;
  const bodyStream = Readable.fromWeb(file.stream() as never);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: bodyStream,
    ContentLength: file.size,
    ContentType: file.type,
  });

  await s3Client.send(command);

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
