ALTER TABLE "assets" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "output_kind" varchar(10) DEFAULT 'image';--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "output_url" text;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "poster_url" text;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "mime_type" varchar(50);--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "duration_sec" integer;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "fps" integer;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "frame_count" integer;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "progress" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "has_video" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "video_defaults" jsonb;