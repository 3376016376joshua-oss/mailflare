-- Local fork, not part of upstream Mailflare: the Tasks app (src/lib/tasks). Purely additive.
-- Rollback: DROP TABLE local_tasks; DROP TABLE local_task_lists; then delete the ledger row named 9000_local_tasks.sql.
CREATE TABLE `local_task_lists` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`title` longtext NOT NULL,
	`position` varchar(191) NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `local_task_lists_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `local_tasks` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`list_id` varchar(191) NOT NULL,
	`parent_id` varchar(191),
	`title` longtext NOT NULL,
	`notes` longtext NOT NULL DEFAULT (''),
	`status` varchar(64) NOT NULL DEFAULT 'needs-action',
	`completed_at` bigint,
	`due_date` varchar(191),
	`due_at` bigint,
	`time_zone` longtext,
	`remind_at` bigint,
	`reminded_at` bigint,
	`starred_at` bigint,
	`position` varchar(191) NOT NULL,
	`message_id` varchar(191),
	`repeat_freq` varchar(64),
	`repeat_interval` bigint NOT NULL DEFAULT 1,
	`repeat_anchor_day` bigint,
	`repeat_until` longtext,
	`repeat_count` bigint,
	`repeat_index` bigint NOT NULL DEFAULT 0,
	`series_id` varchar(191),
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `local_tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `local_task_lists` ADD CONSTRAINT `local_task_lists_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `local_tasks` ADD CONSTRAINT `local_tasks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `local_tasks` ADD CONSTRAINT `local_tasks_list_id_local_task_lists_id_fk` FOREIGN KEY (`list_id`) REFERENCES `local_task_lists`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `local_tasks` ADD CONSTRAINT `local_tasks_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `local_task_lists_user_position_idx` ON `local_task_lists` (`user_id`,`position`);
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
