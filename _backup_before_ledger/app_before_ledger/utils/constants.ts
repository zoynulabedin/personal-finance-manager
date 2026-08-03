/**
 * Client-safe shared constants.
 *
 * Kept out of `validation.server.ts` because anything imported by a component
 * must not live in a `.server` module — React Router refuses to build when
 * client code reaches into server-only files.
 */
export const PAYMENT_METHODS = [
  "Cash",
  "Bank",
  "bKash",
  "Nagad",
  "Rocket",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
