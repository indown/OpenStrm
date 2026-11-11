-- CloudDrive2 的地址和凭据从设置（app.cd2，只在 v2.26.0-rc.2 里出现过）搬成账户页里的一个 cd2 账号，设置里只留「用哪个账号」和挂载映射。
-- 三步都只认 app.cd2 是 JSON 对象的；跑两遍不会多建账号（第一遍之后设置里已经没有 url）。
--
-- 1. 填过地址、还没指向账号的：先定下账号名记进 $.account。叫 cd2；已经有同名账号就加一段随机后缀。
UPDATE `settings`
SET `value` = json_set(`value`, '$.account',
  CASE WHEN EXISTS (SELECT 1 FROM `accounts` WHERE `name` = 'cd2') THEN 'cd2-' || lower(hex(randomblob(3))) ELSE 'cd2' END)
WHERE `key` = 'app.cd2' AND json_valid(`value`) AND json_type(`value`) = 'object'
  AND trim(coalesce(json_extract(`value`, '$.url'), '')) <> ''
  AND coalesce(json_extract(`value`, '$.account'), '') = '';
--> statement-breakpoint
-- 2. 按记下的名字建账号：地址、令牌、用户名、口令原样搬过去，没填的（NULL / 空串）不带（json_patch 会把 NULL 的键去掉）。
INSERT INTO `accounts` (`name`, `account_type`, `data`)
SELECT json_extract(`value`, '$.account'), 'cd2', json_patch('{}', json_object(
  'accountType', 'cd2',
  'name', json_extract(`value`, '$.account'),
  'url', trim(json_extract(`value`, '$.url')),
  'apiToken', nullif(json_extract(`value`, '$.apiToken'), ''),
  'username', nullif(json_extract(`value`, '$.username'), ''),
  'password', nullif(json_extract(`value`, '$.password'), '')
))
FROM `settings`
WHERE `key` = 'app.cd2' AND json_valid(`value`) AND json_type(`value`) = 'object'
  AND trim(coalesce(json_extract(`value`, '$.url'), '')) <> ''
  AND coalesce(json_extract(`value`, '$.account'), '') <> ''
ON CONFLICT(`name`) DO NOTHING;
--> statement-breakpoint
-- 3. 设置里只留账号名和挂载映射；没填过地址的也走这一步，等于只把连接字段去掉。
UPDATE `settings`
SET `value` = json_patch('{}', json_object(
    'account', nullif(json_extract(`value`, '$.account'), ''),
    'mounts', json_extract(`value`, '$.mounts')
  )),
  `updated_at` = unixepoch()
WHERE `key` = 'app.cd2' AND json_valid(`value`) AND json_type(`value`) = 'object';
