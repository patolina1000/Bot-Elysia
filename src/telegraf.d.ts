declare module 'telegraf' {
  export interface TelegramLike {
    sendMessage(chatId: number | string, text: string, extra?: Record<string, any>): Promise<any>;
    sendPhoto(chatId: number | string, photo: string | Buffer, extra?: Record<string, any>): Promise<any>;
  }

  export class Telegraf<C = any> {
    telegram: TelegramLike;
    constructor(token: string);
    launch(...args: any[]): Promise<void>;
  }
}

declare module 'telegraf/typings/core/types/typegram' {
  export interface InlineKeyboardButton {
    text: string;
    callback_data?: string;
    web_app?: { url: string };
  }

  export interface InlineKeyboardMarkup {
    inline_keyboard: InlineKeyboardButton[][];
  }
}
