import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { authAdminMiddleware } from './middleware/authAdmin.js';

export const uploadR2Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

function createR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials not configured');
  }

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

uploadR2Router.post(
  '/api/uploads/pix-image',
  authAdminMiddleware,
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'file obrigatório' });
        return;
      }

      const bucket = process.env.R2_BUCKET;
      if (!bucket) {
        res.status(500).json({ error: 'R2_BUCKET not configured' });
        return;
      }

      const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
      const timestamp = Date.now();
      const rand = crypto.randomBytes(4).toString('hex');
      const key = `uploads/${new Date().toISOString().slice(0, 10)}/${timestamp}-${rand}.${ext}`;

      const client = createR2Client();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype || 'application/octet-stream',
        })
      );

      const baseUrl = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');
      const url = `${baseUrl}/${key}`;
      res.json({ url, key });
    } catch (error) {
      console.error('[R2 upload] error', error);
      const message = error instanceof Error ? error.message : 'Upload failed';
      res.status(500).json({ error: message });
    }
  }
);
