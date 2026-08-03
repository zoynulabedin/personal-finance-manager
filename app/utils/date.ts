/**
 * Format a date for `<input type="date">` using **local** calendar parts.
 *
 * `date.toISOString().split("T")[0]` converts to UTC first, so for any user
 * east or west of UTC it can hand back the previous or next day — which meant
 * opening the edit dialog silently shifted the saved date.
 */
export function toDateInputValue(input: Date | string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Today, formatted for `<input type="date">`. */
export function todayInputValue(): string {
  return toDateInputValue(new Date());
}
