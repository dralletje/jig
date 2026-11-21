import { label, shorten } from "./ui";

export function view(title: string) {
  return label(shorten(title, 12, "…"));
}
