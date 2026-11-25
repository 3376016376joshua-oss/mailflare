-- Local fork, not part of upstream Mailflare: the Tasks app (src/lib/tasks). Purely additive.
-- Rollback: DROP TABLE local_tasks; DROP TABLE local_task_lists; then delete the ledger row named 9000_local_tasks.sql.
CREATE TABLE "local_task_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"position" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"list_id" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'needs-action' NOT NULL,
	"completed_at" bigint,
	"due_date" text,
	"due_at" bigint,
	"time_zone" text,
	"remind_at" bigint,
	"reminded_at" bigint,
	"starred_at" bigint,
	"position" text NOT NULL,
	"message_id" text,
	"repeat_freq" text,
	"repeat_interval" bigint DEFAULT 1 NOT NULL,
	"repeat_anchor_day" bigint,
	"repeat_until" text,
	"repeat_count" bigint,
	"repeat_index" bigint DEFAULT 0 NOT NULL,
	"series_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_task_lists" ADD CONSTRAINT "local_task_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "local_tasks" ADD CONSTRAINT "local_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "local_tasks" ADD CONSTRAINT "local_tasks_list_id_local_task_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."local_task_lists"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "local_tasks" ADD CONSTRAINT "local_tasks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "local_task_lists_user_position_idx" ON "local_task_lists" USING btree ("user_id","position");
--> statement-breakpoint
CREATE INDEX "local_tasks_list_parent_position_idx" ON "local_tasks" USING btree ("list_id","parent_id","position");
--> statement-breakpoint
CREATE INDEX "local_tasks_user_due_idx" ON "local_tasks" USING btree ("user_id","due_date");
--> statement-breakpoint
CREATE INDEX "local_tasks_user_starred_idx" ON "local_tasks" USING btree ("user_id","starred_at");
--> statement-breakpoint
CREATE INDEX "local_tasks_remind_idx" ON "local_tasks" USING btree ("remind_at");
--> statement-breakpoint
CREATE INDEX "local_tasks_message_idx" ON "local_tasks" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "local_tasks_parent_idx" ON "local_tasks" USING btree ("parent_id");
--> statement-breakpoint
CREATE INDEX "local_tasks_series_idx" ON "local_tasks" USING btree ("series_id","repeat_index");
