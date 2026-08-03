import { PAYMENT_METHODS, type PaymentMethod } from "../utils/constants";

/**
 * Shared input parsing for loaders and actions.
 *
 * Everything here fails closed: an unparseable value comes back as `null` (or
 * the supplied fallback) rather than NaN / Invalid Date, both of which used to
 * slip past guards like `amount <= 0` and reach Prisma.
 */

/** Round to 2 decimals so repeated 1% math doesn't accumulate float dust. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Parse a money amount from form data.
 * Returns null unless the value is a finite number greater than zero.
 * NOTE: `NaN <= 0` is false, which is why a plain parseFloat guard is unsafe.
 */
export function parseAmount(
  value: FormDataEntryValue | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.toString().trim();
  if (raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return roundMoney(parsed);
}

/** Same as parseAmount but allows zero and negatives (e.g. a bank balance). */
export function parseBalance(
  value: FormDataEntryValue | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.toString().trim();
  if (raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return roundMoney(parsed);
}

/** Trimmed non-empty string, or null. */
export function parseText(
  value: FormDataEntryValue | null | undefined
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.toString().trim();
  return trimmed === "" ? null : trimmed;
}

/** Optional trimmed string — empty becomes null rather than "". */
export function parseOptionalText(
  value: FormDataEntryValue | null | undefined
): string | null {
  return parseText(value);
}

/**
 * Parse a `<input type="date">` value ("YYYY-MM-DD") as **local** midnight.
 *
 * `new Date("2026-08-03")` parses as UTC midnight, which lands on a different
 * calendar day from the local-time range boundaries used by the filters. Build
 * the date from parts so both sides agree.
 */
export function parseDateInput(
  value: FormDataEntryValue | null | undefined
): Date | null {
  if (value === null || value === undefined) return null;
  const raw = value.toString().trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) {
    const [, y, m, d] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Bounded integer from a query string, with a fallback for junk input. */
export function parseIntParam(
  value: string | null | undefined,
  { min, max, fallback }: { min: number; max: number; fallback: number }
): number {
  if (value === null || value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

export function parseMonthParam(value: string | null | undefined): number {
  return parseIntParam(value, {
    min: 1,
    max: 12,
    fallback: new Date().getMonth() + 1,
  });
}

export function parseYearParam(value: string | null | undefined): number {
  return parseIntParam(value, {
    min: 1970,
    max: 9999,
    fallback: new Date().getFullYear(),
  });
}

/** Years offered in the month/year pickers, centred on the current year. */
export function selectableYears(): number[] {
  const current = new Date().getFullYear();
  return [current - 2, current - 1, current, current + 1];
}


export { PAYMENT_METHODS };
export type { PaymentMethod };

export function parsePaymentMethod(
  value: FormDataEntryValue | null | undefined
): PaymentMethod {
  const raw = value?.toString();
  return PAYMENT_METHODS.includes(raw as PaymentMethod)
    ? (raw as PaymentMethod)
    : "Cash";
}

/** Inclusive local-time bounds for a calendar month. */
export function monthRange(year: number, month1Based: number) {
  return {
    start: new Date(year, month1Based - 1, 1, 0, 0, 0, 0),
    end: new Date(year, month1Based, 0, 23, 59, 59, 999),
  };
}

/** Inclusive local-time bounds for a calendar day. */
export function dayRange(date: Date) {
  return {
    start: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0),
    end: new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      23,
      59,
      59,
      999
    ),
  };
}
