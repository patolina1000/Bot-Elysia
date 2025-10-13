import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer, { type FileFilterCallback } from 'multer';
import express, { type Express, type Request, type RequestHandler } from 'express';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? '';
const R2_BUCKET = process.env.R2_BUCKET ?? '';
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

const USE_R2 = Boolean(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY &&
  R2_BUCKET &&
  R2_PUBLIC_BASE_URL,
);

const s3 = USE_R2
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (!file.mimetype) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE'));
    if (/^(image|video|audio)\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE'));
    }
  },
});

function sanitizeName(name: string) {
  return (name || 'file').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file';
}

function makeKey(originalname: string) {
  const ext = path.extname(originalname || '').toLowerCase();
  const base = sanitizeName(path.basename(originalname || 'file', ext));
  const random = crypto.randomBytes(6).toString('hex');
  const date = new Date().toISOString().slice(0, 10);
  return `uploads/${date}/${Date.now()}_${random}_${base}${ext}`;
}

async function uploadToLocal(key: string, buffer: Buffer) {
  const relativeKey = key.replace(/^uploads\//, '');
  const outPath = path.join(UPLOAD_DIR, relativeKey);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, buffer);
  return `/uploads/${relativeKey.replace(/\\/g, '/')}`;
}

export function mountAdminUpload(app: Express) {
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

  const multerMiddleware: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const mappedErrors: Record<string, string> = {
          LIMIT_UNEXPECTED_FILE: 'unsupported_type',
          LIMIT_FILE_SIZE: 'file_too_large',
        };
        const errorCode = err.code;
        const error = mappedErrors[errorCode] ?? errorCode;
        return res.status(400).json({ ok: false, error });
      }
      if (err) return next(err);
      const request = req as Request & { file?: Express.Multer.File };
      if (!request.file) return res.status(400).json({ ok: false, error: 'no_file' });
      next();
    });
  };

  const handler: RequestHandler = async (req, res) => {
    const request = req as Request & { file: Express.Multer.File };
    const { originalname, buffer, mimetype, size } = request.file;
    const key = makeKey(originalname);

    try {
      if (USE_R2 && s3) {
        await s3.send(
          new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: buffer,
            ContentType: mimetype || 'application/octet-stream',
          }),
        );
        const url = `${R2_PUBLIC_BASE_URL}/${key}`;
        return res.json({ ok: true, url, filename: originalname, size, mime: mimetype });
      }

      const url = await uploadToLocal(key, buffer);
      return res.json({ ok: true, url, filename: originalname, size, mime: mimetype });
    } catch (error) {
      console.error({ error }, '[upload] failed');
      return res.status(500).json({ ok: false, error: 'upload_failed' });
    }
  };

  app.post(
    [
      '/api/admin/upload',
      '/admin/upload',
      // alias para compatibilidade com o admin-wizard de downsells
      '/admin/api/uploads/downsells'
    ],
    authAdminMiddleware,
    multerMiddleware,
    handler
  );
}
