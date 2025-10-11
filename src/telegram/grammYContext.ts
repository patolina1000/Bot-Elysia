import { Context } from 'grammy';
import { Logger } from '../logger.js';
import { Pool } from 'pg';

export interface MyContextExtras {
  bot_id: string;
  bot_slug: string;
  bot_token: string;
  logger: Logger;
  db: Pool;
}

export type MyContext = Context & MyContextExtras;
