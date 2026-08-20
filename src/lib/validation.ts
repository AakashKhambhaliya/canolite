import { z } from "zod";

/**
 * Zod schemas for v1 API input validation
 */

export const modificationSchema = z.object({
  name: z.string().min(1, "Modification name is required"),
  text: z.string().optional(),
  image_url: z.string().url("Must be a valid URL").optional(),
  video_url: z.string().url("Must be a valid URL").optional(),
  trim_start: z.number().min(0).optional(),
  trim_end: z.number().min(0).optional(),
  start_at: z.number().min(0).optional(),
  volume: z.number().min(0).max(2).optional(),
  muted: z.boolean().optional(),
  loop: z.boolean().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().min(1).max(1000).optional(),
  fontWeight: z.string().optional(),
  fontStyle: z.string().optional(),
  fill: z.string().optional(),
  textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  lineHeight: z.number().min(0.1).max(10).optional(),
  height: z.number().min(1).optional(),
  charSpacing: z.number().optional(),
  underline: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  backgroundColor: z.string().optional(),
});

export const renderRequestSchema = z.object({
  template_id: z.string().min(1, "template_id is required"),
  modifications: z.array(modificationSchema).optional().default([]),
  format: z.enum(["png", "jpg", "jpeg", "webp", "mp4"]).optional(),
  quality: z.number().min(1).max(100).optional(),
  scale: z.number().min(1).max(3).optional(),
  webhook_url: z.string().url().optional(),
  // When true, the request waits for the render to finish and returns the
  // image_url directly instead of a queued job uid to poll.
  synchronous: z.boolean().optional().default(false),
});

export const videoRenderRequestSchema = z.object({
  template_id: z.string().min(1, "template_id is required"),
  modifications: z.array(modificationSchema).optional().default([]),
  fps: z.number().min(1).max(60).optional(),
  duration: z.number().min(0.1).max(120).optional(),
  quality: z.enum(["high", "balanced", "small"]).optional(),
  webhook_url: z.string().url().optional(),
});

export const batchRequestSchema = z.object({
  template_id: z.string().min(1, "template_id is required"),
  items: z
    .array(
      z.object({
        modifications: z.array(modificationSchema).optional().default([]),
        webhook_url: z.string().url().optional(),
      })
    )
    .min(1, "At least one item is required")
    .max(500, "Maximum 500 items per batch"),
  format: z.enum(["png", "jpg", "jpeg", "webp", "mp4"]).optional(),
  quality: z.number().min(1).max(100).optional(),
  scale: z.number().min(1).max(3).optional(),
});

export const settingsSchema = z.object({
  // Empty string means "clear the field" (matches the settings form's
  // behavior); z.coerce.number() both accepts a proper number as-is and
  // rejects garbage (non-numeric strings, NaN) instead of silently letting
  // it through the way a bare `Number(x)` in the route handler used to.
  webhookUrl: z.union([z.string().url(), z.literal("")]).optional(),
  webhookSecret: z.string().optional(),
  defaultFormat: z.enum(["png", "jpg", "jpeg", "webp", "mp4"]).optional(),
  defaultQuality: z.coerce.number().min(1).max(100).optional(),
  defaultScale: z.coerce.number().min(1).max(3).optional(),
  retentionHours: z.coerce.number().min(1).max(8760).optional(),
});

export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type VideoRenderRequest = z.infer<typeof videoRenderRequestSchema>;
export type BatchRequest = z.infer<typeof batchRequestSchema>;
export type SettingsRequest = z.infer<typeof settingsSchema>;
