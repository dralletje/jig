import { User } from "@/models/User";
import { formatDate, capitalize } from "@/lib";

export function renderUserCard(user: User, compact: boolean) {
  const since = formatDate(user.createdAt, false);
  if (compact) return `${user.name} (${user.role})`;
  return `${user.name} <${user.email}>, ${capitalize(user.role)} since ${since}`;
}
