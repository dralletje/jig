import { User, Role } from "@/models";
import { capitalize, slugify } from "@/lib";
import createLogger from "@/lib/logger";
import Store from "./store";

const log = createLogger("users", "info");
const users = new Store<User>();

export function createUser(name: string, email: string, role: Role) {
  const user: User = { id: slugify(name, 32), name: capitalize(name), email, role, createdAt: new Date() };
  console.log("created user", user.id);
  log.info(`created ${user.id}`);
  return users.add(user);
}

export function findUser(id: string) {
  return users.get(id);
}

export function isAdmin(user: User) {
  return user.role === "admin";
}
