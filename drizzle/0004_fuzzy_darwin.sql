ALTER TABLE "projects" ADD COLUMN "default_fps" integer DEFAULT 30;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_video_quality" varchar(10) DEFAULT 'balanced';