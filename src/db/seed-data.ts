import * as schema from "./schema";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import { asc, eq, isNotNull } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DATA_DIR = "/app/data";
const INSTANCE_MARKER = path.join(DATA_DIR, ".instance.json");

/**
 * Whether the demo template should be inserted on a fresh DB. Explicit env var
 * wins; otherwise demo data is on for development and OFF for production — an
 * empty dashboard is an unmistakable alarm, whereas a resurrected demo template
 * looks like the app overwrote the customer's work.
 */
function shouldSeedDemoData(): boolean {
  const explicit = process.env.SEED_DEMO_DATA;
  if (explicit !== undefined) return explicit === "true";
  return process.env.NODE_ENV !== "production";
}

function getAppVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface InstanceMarker {
  instanceId?: string;
  createdAt?: string;
  version?: string;
}

export function readInstanceMarker(): InstanceMarker | null {
  try {
    if (!fs.existsSync(INSTANCE_MARKER)) return null;
    return JSON.parse(fs.readFileSync(INSTANCE_MARKER, "utf-8"));
  } catch {
    return null;
  }
}

/** Write the instance marker once (idempotent). No-op outside /app/data. */
export function writeInstanceMarker(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) return; // local dev — no persistent dir
    if (fs.existsSync(INSTANCE_MARKER)) return;
    const marker: InstanceMarker = {
      instanceId: randomUUID(),
      createdAt: new Date().toISOString(),
      version: getAppVersion(),
    };
    fs.writeFileSync(INSTANCE_MARKER, JSON.stringify(marker, null, 2));
    console.log("[instance] Wrote instance marker:", INSTANCE_MARKER);
  } catch (e) {
    console.warn("[instance] Could not write instance marker:", e);
  }
}

/**
 * Boot-time consistency check. Logs a prominent warning when the DB and the
 * persisted files disagree with the instance marker — a signature of a lost or
 * swapped volume. Also writes the marker once the admin is configured.
 */
export async function checkInstanceConsistency(db: any): Promise<void> {
  const marker = readInstanceMarker();

  const [firstUser] = await db.select().from(schema.users).limit(1);
  const hasUsers = !!firstUser;

  const storageRoot =
    process.env.STORAGE_DIR || path.join(process.cwd(), "public", "storage");
  let storageHasFiles = false;
  try {
    storageHasFiles = fs.readdirSync(storageRoot).length > 0;
  } catch {
    storageHasFiles = false;
  }

  if (marker && !hasUsers) {
    console.warn(
      "⚠️  [instance] VOLUME MISMATCH: an instance marker exists at " +
        `${INSTANCE_MARKER} but the database has no users. The database may ` +
        "have been lost or pointed at a fresh backend — review your volume " +
        "mounts and DATABASE_URL before continuing."
    );
  }
  if (!marker && storageHasFiles) {
    console.warn(
      "⚠️  [instance] VOLUME MISMATCH: rendered files exist in storage but no " +
        "instance marker was found. A volume may have been lost or swapped — " +
        "review your volume mounts."
    );
  }

  // Write the marker once the admin account has been configured.
  if (!marker) {
    const [configured] = await db
      .select()
      .from(schema.users)
      .where(isNotNull(schema.users.passwordHash))
      .limit(1);
    if (configured) writeInstanceMarker();
  }
}

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
  writeInstanceMarker();
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

  // Demo template is gated: off by default in production so a fresh DB shows
  // an empty dashboard (an unmistakable alarm) instead of a resurrected demo.
  if (!shouldSeedDemoData()) {
    console.log(
      "ℹ️  Skipping demo template (SEED_DEMO_DATA not enabled). " +
        "The dashboard will start empty."
    );
    return;
  }

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
