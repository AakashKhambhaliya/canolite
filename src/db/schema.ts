import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  boolean,
  varchar,
  index,
} from "drizzle-orm/pg-core";

// ============================================================
// Users
// ============================================================
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionToken: text("session_token").notNull().unique(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull().unique(),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

// ============================================================
// Projects
// ============================================================
export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().default("My Project"),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  // Universal output defaults. Every surface (Settings, editor, Playground,
  // v1 API) resolves against these — see lib/output-settings.ts.
  defaultFormat: varchar("default_format", { length: 10 }).default("png"),
  defaultQuality: integer("default_quality").default(90),
  defaultScale: integer("default_scale").default(1),
  defaultFps: integer("default_fps").default(30),
  defaultVideoQuality: varchar("default_video_quality", { length: 10 }).default(
    "balanced"
  ),
  retentionHours: integer("retention_hours").default(24),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

// ============================================================
// Templates
// ============================================================
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: varchar("template_id", { length: 32 }).notNull().unique(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull().default("Untitled Template"),
    description: text("description"),
    width: integer("width").notNull().default(1080),
    height: integer("height").notNull().default(1350),
    designJson: jsonb("design_json"),
    outputDefaults: jsonb("output_defaults").$type<{
      format?: "png" | "jpg" | "webp" | "mp4";
      quality?: number;
      scale?: number;
      background?: string;
    }>(),
    hasVideo: boolean("has_video").default(false),
    videoDefaults: jsonb("video_defaults").$type<{
      fps?: number;
      durationSec?: number;
      crf?: number;
    }>(),
    thumbnailUrl: text("thumbnail_url"),
    tags: text("tags").array(),
    isDeleted: boolean("is_deleted").default(false),
    version: integer("version").default(1),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("templates_project_idx").on(table.projectId),
    templateIdIdx: index("templates_template_id_idx").on(table.templateId),
  })
);

// ============================================================
// Template Fields (cached from design_json)
// ============================================================
export const templateFields = pgTable(
  "template_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .references(() => templates.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(), // text, image, shape
    defaultValue: text("default_value"),
    properties: jsonb("properties"), // store default font, size, etc.
    sortOrder: integer("sort_order").default(0),
  },
  (table) => ({
    templateIdx: index("template_fields_template_idx").on(table.templateId),
  })
);

// ============================================================
// API Keys
// ============================================================
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: varchar("key_prefix", { length: 16 }).notNull(),
    lastUsedAt: timestamp("last_used_at", { mode: "date" }),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("api_keys_project_idx").on(table.projectId),
    prefixIdx: index("api_keys_prefix_idx").on(table.keyPrefix),
  })
);

// ============================================================
// Render Jobs
// ============================================================
export const renderJobs = pgTable(
  "render_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    uid: varchar("uid", { length: 32 }).notNull().unique(),
    batchUid: varchar("batch_uid", { length: 32 }),
    templateId: uuid("template_id")
      .references(() => templates.id)
      .notNull(),
    projectId: uuid("project_id")
      .references(() => projects.id)
      .notNull(),
    status: varchar("status", { length: 20 })
      .notNull()
      .default("queued"), // queued, processing, done, failed
    modifications: jsonb("modifications"),
    format: varchar("format", { length: 10 }).default("png"),
    quality: integer("quality").default(90),
    scale: integer("scale").default(1),
    background: varchar("background", { length: 20 }),
    imageUrl: text("image_url"),
    outputKind: varchar("output_kind", { length: 10 }).default("image"),
    outputUrl: text("output_url"),
    posterUrl: text("poster_url"),
    mimeType: varchar("mime_type", { length: 50 }),
    durationSec: integer("duration_sec"),
    fps: integer("fps"),
    frameCount: integer("frame_count"),
    progress: integer("progress").default(0),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    webhookUrl: text("webhook_url"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (table) => ({
    uidIdx: index("render_jobs_uid_idx").on(table.uid),
    batchIdx: index("render_jobs_batch_idx").on(table.batchUid),
    projectIdx: index("render_jobs_project_idx").on(table.projectId),
    statusIdx: index("render_jobs_status_idx").on(table.status),
  })
);

// ============================================================
// Assets
// ============================================================
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    type: varchar("type", { length: 50 }).notNull(), // image, font, svg
    mimeType: varchar("mime_type", { length: 100 }),
    size: integer("size"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index("assets_project_idx").on(table.projectId),
  })
);

// ============================================================
// Template Versions (for version history)
// ============================================================
export const templateVersions = pgTable("template_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  templateId: uuid("template_id")
    .references(() => templates.id, { onDelete: "cascade" })
    .notNull(),
  version: integer("version").notNull(),
  designJson: jsonb("design_json"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});
