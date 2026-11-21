import "@/setup";
import type { Role } from "@/models";
import { badge, WIDGET_PREFIX } from "@/widgets";
import { slugify, toDateString, type UserRole } from "@/utils";
import { capitalize as cap, type Level } from "@/lib";

export function renderRoleBadge(role: Role, since: Date, level: Level) {
  const kind: UserRole = role;
  return `${WIDGET_PREFIX}${slugify(kind, 16)} ${badge(cap(role))} ${toDateString(since, false)} (${level})`;
}
