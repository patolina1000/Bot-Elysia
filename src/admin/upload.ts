import fs from 'node:fs';
import path from 'node:path';
import multer, { type FileFilterCallback } from 'multer';
import express, { type Express, type Request, type RequestHandler } from 'express';
import { authAdminMiddleware } from '../http/middleware/authAdmin.js';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (
    _req: Request,
    _file: Express.Multer.File,
    cb: (error: Error | null, destination: string) => void,
  ) => cb(null, UPLOAD_DIR),
  filename: (
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, filename: string) => void,
  ) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path
      .basename(file.originalname || 'file', ext)
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 60);
    const safeBase = base || 'file';
    cb(null, `${Date.now()}_${safeBase}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    if (!file.mimetype) return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE'));
    if (/^(image|video|audio)\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE'));
    }
  },
});

export function mountAdminUpload(app: Express) {
  // arquivos públicos
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

  // upload único
  const handler: RequestHandler = (req, res, next) => {
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
      const { file } = request;
      const url = `/uploads/${file.filename}`;
      return res.json({
        ok: true,
        url,
        filename: file.originalname,
        size: file.size,
        mime: file.mimetype,
      });
    });
  };

  app.post(['/api/admin/upload', '/admin/upload'], authAdminMiddleware, handler);
}
