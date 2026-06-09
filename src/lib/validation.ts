import { z } from "zod";

/**
 * Zod schemas for v1 API input validation
 */

export const modificationSchema = z.object({
  name: z.string().min(1, "Modification name is required"),
  text: z.string().optional(),
  image_url: z.string().url("Must be a valid URL").optional(),
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
  format: z.enum(["png", "jpg", "jpeg", "webp"]).optional(),
  quality: z.number().min(1).max(100).optional(),
  scale: z.number().min(1).max(3).optional(),
  webhook_url: z.string().url().optional(),
  // When true, the request waits for the render to finish and returns the
  // image_url directly instead of a queued job uid to poll.
  synchronous: z.boolean().optional().default(false),
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
  format: z.enum(["png", "jpg", "jpeg", "webp"]).optional(),
  quality: z.number().min(1).max(100).optional(),
  scale: z.number().min(1).max(3).optional(),
});

export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type BatchRequest = z.infer<typeof batchRequestSchema>;
