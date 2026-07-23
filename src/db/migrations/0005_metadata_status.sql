ALTER TABLE `files` ADD `metadata_status` text DEFAULT 'possible' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `strip_media_metadata` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `strip_document_metadata` integer DEFAULT true NOT NULL;