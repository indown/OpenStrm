-- 夸克监控改成按目录指纹增量对比：根目录自己的指纹和上次整棵对比的时间存在快照的 meta 里（JSON）。老的快照行是 {}，第一轮按整棵列补上。
-- 同步任务在跑的目录，监控先把事件记下（status = deferred），同步结束再按先后补：每轮按账号查一遍，部分索引只收这几行。
ALTER TABLE `drive_snapshots` ADD `meta` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `life_events_deferred_idx` ON `life_events` (`account_name`) WHERE "life_events"."status" = 'deferred';