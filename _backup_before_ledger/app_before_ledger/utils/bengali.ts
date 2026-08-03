const BENGALI_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];

export function toBengaliDigits(input: number | string): string {
  if (input === null || input === undefined) return "";
  const str = String(input);
  return str.replace(/\d/g, (digit) => BENGALI_DIGITS[parseInt(digit, 10)]);
}

export function formatBDT(amount: number | null | undefined, useBengaliDigits: boolean = true): string {
  if (amount === null || amount === undefined || isNaN(amount)) return useBengaliDigits ? "৳ ০" : "৳ 0";
  
  // Format with commas (South Asian style or standard locale)
  const formattedNumber = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(amount);

  if (useBengaliDigits) {
    return `৳ ${toBengaliDigits(formattedNumber)}`;
  }
  return `৳ ${formattedNumber}`;
}

export const BENGALI_MONTHS = [
  "জানুয়ারী",
  "ফেব্রুয়ারী",
  "মার্চ",
  "এপ্রিল",
  "মে",
  "জুন",
  "জুলাই",
  "আগস্ট",
  "সেপ্টেম্বর",
  "অক্টোবর",
  "নভেম্বর",
  "ডিসেম্বর",
];

export function formatBengaliDate(dateInput: Date | string, useBengaliDigits: boolean = true): string {
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return "";

  const day = date.getDate();
  const monthIndex = date.getMonth();
  const year = date.getFullYear();

  const monthName = BENGALI_MONTHS[monthIndex];

  if (useBengaliDigits) {
    return `${toBengaliDigits(day)} ${monthName} ${toBengaliDigits(year)}`;
  }

  return `${day} ${monthName} ${year}`;
}

export function getMonthName(monthIndex1Based: number): string {
  if (monthIndex1Based < 1 || monthIndex1Based > 12) return "";
  return BENGALI_MONTHS[monthIndex1Based - 1];
}
