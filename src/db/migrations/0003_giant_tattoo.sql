CREATE TABLE `embed_sources` (
	`file_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`source_url` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
