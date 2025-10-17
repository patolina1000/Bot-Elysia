declare module 'luxon' {
  export class DateTime {
    static fromISO(s: string, opts?: { zone?: string }): DateTime;
    toUTC(): DateTime;
    toJSDate(): Date;
    readonly isValid: boolean;
  }
}
