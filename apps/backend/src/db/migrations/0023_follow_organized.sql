-- 追更记住整理结果：share_follows.organized 是分享里各目录上次整理成什么（作品 / 季 / 集偏移），新文件交给整理时照着用；
-- organize_runs.hints 是这次新增路径带过来的识别提示，重新预览也照用。老数据都是 []。
ALTER TABLE `organize_runs` ADD `hints` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `share_follows` ADD `organized` text DEFAULT '[]' NOT NULL;