import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('8080').transform(Number),
  APP_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(10),
  NODE_ENV: z.enum(['development', 'production']).default('production'),
});

export const env = envSchema.parse(process.env);
