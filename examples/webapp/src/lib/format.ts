import config from "@/config";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function formatDate(date: Date, withTime: boolean) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (!withTime) return day;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatCurrency(amount: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
}

export function formatPrice(amount: number) {
  return formatCurrency(amount, config.currency, config.locale);
}
