import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { asc } from "drizzle-orm";

/**
 * Single-admin helpers.
 *
 * The bootstrapped admin user row (created by the seed) owns the project and
 * all data. "Setup" means that row has been given an email + password hash —
 * either via the first-run setup wizard or the ADMIN_EMAIL/ADMIN_PASSWORD env
 * vars (auto-provisioned on boot).
 */
export async function getAdminUser() {
  const [admin] = await db
    .select()
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  return admin ?? null;
}

export async function isSetupComplete(): Promise<boolean> {
  const admin = await getAdminUser();
  return !!(admin && admin.passwordHash);
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
