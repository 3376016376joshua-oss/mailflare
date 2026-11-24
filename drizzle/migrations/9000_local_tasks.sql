-- Local fork, not part of upstream Mailflare: the Tasks app (src/lib/tasks). Purely additive.
-- Rollback: DROP TABLE local_tasks; DROP TABLE local_task_lists; then delete the ledger row named 9000_local_tasks.sql.
CREATE TABLE `local_task_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`position` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `local_task_lists_user_position_idx` ON `local_task_lists` (`user_id`,`position`);
--> statement-breakpoint
CREATE TABLE `local_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`list_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'needs-action' NOT NULL,
	`completed_at` integer,
	`due_date` text,
	`due_at` integer,
	`time_zone` text,
	`remind_at` integer,
	`reminded_at` integer,
	`starred_at` integer,
	`position` text NOT NULL,
	`message_id` text,
	`repeat_freq` text,
	`repeat_interval` integer DEFAULT 1 NOT NULL,
	`repeat_anchor_day` integer,
	`repeat_until` text,
	`repeat_count` integer,
	`repeat_index` integer DEFAULT 0 NOT NULL,
	`series_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `local_task_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `local_tasks_list_parent_position_idx` ON `local_tasks` (`list_id`,`parent_id`,`position`);
--> statement-breakpoint
CREATE INDEX `local_tasks_user_due_idx` ON `local_tasks` (`user_id`,`due_date`);
--> statement-breakpoint
CREATE INDEX `local_tasks_user_starred_idx` ON `local_tasks` (`user_id`,`starred_at`);
--> statement-breakpoint
CREATE INDEX `local_tasks_remind_idx` ON `local_tasks` (`remind_at`);
--> statement-breakpoint
CREATE INDEX `local_tasks_message_idx` ON `local_tasks` (`message_id`);
--> statement-breakpoint
CREATE INDEX `local_tasks_parent_idx` ON `local_tasks` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `local_tasks_series_idx` ON `local_tasks` (`series_id`,`repeat_index`);
