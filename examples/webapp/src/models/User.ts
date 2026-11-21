export type Role = "admin" | "member" | "guest";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: Date;
}
