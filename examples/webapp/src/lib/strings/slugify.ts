const SEPARATOR = "-";

export function slugify(text: string, maxLength: number) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, SEPARATOR)
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLength);
}

export function isSlug(text: string) {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(text);
}
