ALTER TABLE "projects" ADD COLUMN "default_format" varchar(10) DEFAULT 'png';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_quality" integer DEFAULT 90;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_scale" integer DEFAULT 1;