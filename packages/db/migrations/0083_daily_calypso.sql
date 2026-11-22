ALTER TABLE "meetings_notes" ADD COLUMN "decisions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings_notes" ADD COLUMN "questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings_notes" ADD COLUMN "chapters" jsonb DEFAULT '[]'::jsonb NOT NULL;