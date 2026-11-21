export function truncate(text: string, length: number, suffix: string) {
  return text.length <= length ? text : text.slice(0, length - suffix.length) + suffix;
}
