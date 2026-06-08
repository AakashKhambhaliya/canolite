import * as schema from "./schema";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import { asc, eq } from "drizzle-orm";

/**
 * Optional headless setup: if ADMIN_EMAIL and ADMIN_PASSWORD are both set and
 * the admin account isn't configured yet, provision it from the env vars so the
 * first-run setup wizard is skipped (useful for Docker / CI deploys). Runs on
 * every boot but is a no-op once the account is configured.
 */
export async function autoProvisionAdminFromEnv(db: any): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;

  const [admin] = await db
    .select()
    .from(schema.users)
    .orderBy(asc(schema.users.createdAt))
    .limit(1);
  if (!admin || admin.passwordHash) return;

  const passwordHash = await bcrypt.hash(password, 12);
  await db
    .update(schema.users)
    .set({
      email: email.trim().toLowerCase(),
      passwordHash,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, admin.id));
  console.log("✅ Admin auto-provisioned from ADMIN_EMAIL/ADMIN_PASSWORD");
}

/**
 * Seed demo data if the database is empty. Idempotent — checks for the demo
 * user before inserting anything. Shared by the app startup hook and the
 * `npm run db:seed` script.
 */
export async function seedIfEmpty(db: any): Promise<void> {
  const existing = await db.select().from(schema.users).limit(1);
  if (existing.length > 0) {
    return;
  }

  console.log("🌱 Seeding database...");

  // Single-admin model: bootstrap one admin user + project. Sign-in is gated by
  // the ADMIN_PASSWORD env var, not this row's password.
  const [user] = await db
    .insert(schema.users)
    .values({
      name: "Admin",
      email: "admin@localhost",
      passwordHash: null,
    })
    .returning();

  console.log("✅ Created admin user (configure it via the first-run setup wizard)");

  const [project] = await db
    .insert(schema.projects)
    .values({
      name: "Default Project",
      userId: user.id,
    })
    .returning();

  const templateId = `tmpl_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const sampleDesign = {
    version: "5.3.0",
    objects: [
      {
        type: "rect",
        left: 0,
        top: 0,
        width: 1080,
        height: 1350,
        fill: "#1a1a2e",
        selectable: false,
        evented: false,
      },
      {
        type: "rect",
        left: 0,
        top: 900,
        width: 1080,
        height: 450,
        fill: "#16213e",
        name: "band",
        dynamic: false,
      },
      {
        type: "textbox",
        left: 60,
        top: 950,
        width: 960,
        fontSize: 56,
        fontFamily: "Arial",
        fontWeight: "bold",
        fill: "#ffffff",
        text: "AASTHA ENTERPRISE",
        textAlign: "center",
        name: "dealer_name",
        dynamic: true,
      },
      {
        type: "textbox",
        left: 60,
        top: 1030,
        width: 960,
        fontSize: 32,
        fontFamily: "Arial",
        fill: "#e0a13a",
        text: "AHMEDABAD",
        textAlign: "center",
        name: "city",
        dynamic: true,
      },
      {
        type: "textbox",
        left: 60,
        top: 1100,
        width: 960,
        fontSize: 24,
        fontFamily: "Arial",
        fill: "#94a3b8",
        text: "+91 98765 43210",
        textAlign: "center",
        name: "phone",
        dynamic: true,
      },
    ],
    background: "#1a1a2e",
  };

  const [template] = await db
    .insert(schema.templates)
    .values({
      templateId,
      projectId: project.id,
      name: "Dealer Poster",
      description:
        "A promotional poster template with dealer name, city, and phone. The exact 300/day workflow use case.",
      width: 1080,
      height: 1350,
      designJson: sampleDesign,
      outputDefaults: { format: "png", quality: 90, scale: 1 },
    })
    .returning();

  await db.insert(schema.templateFields).values([
    {
      templateId: template.id,
      name: "dealer_name",
      type: "text",
      defaultValue: "AASTHA ENTERPRISE",
      properties: {
        fontFamily: "Arial",
        fontSize: 56,
        fontWeight: "bold",
        fill: "#ffffff",
      },
      sortOrder: 0,
    },
    {
      templateId: template.id,
      name: "city",
      type: "text",
      defaultValue: "AHMEDABAD",
      properties: { fontFamily: "Arial", fontSize: 32, fill: "#e0a13a" },
      sortOrder: 1,
    },
    {
      templateId: template.id,
      name: "phone",
      type: "text",
      defaultValue: "+91 98765 43210",
      properties: { fontFamily: "Arial", fontSize: 24, fill: "#94a3b8" },
      sortOrder: 2,
    },
  ]);

  console.log(`✅ Seed complete. Sample template: ${templateId}`);
  console.log("   Open the app to create your admin account (setup wizard)");
}
