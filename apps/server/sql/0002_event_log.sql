-- 多端事件同步中心：持久化事件日志 + 每端消费游标
-- 设计要点：
--   1) seq 单调递增（INTEGER PRIMARY KEY 即 rowid 别名），断线重连用 Last-Event-ID 补漏；
--   2) library_id 强制隔离，订阅与回放都只取本库事件；
--   3) dedup_key 全局唯一：同一业务事件（同一资产/同一窗口判定跳变/同一提醒）
--      无论被触发多少次，事件日志里只落一条，从源头杜绝重复消费。

CREATE TABLE IF NOT EXISTS event_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,          -- 事件公开 ID（= SSE id: 行）
  library_id  TEXT NOT NULL,                 -- 不设外键约束，避免库删除阻塞日志写入
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  dedup_key   TEXT NOT NULL UNIQUE,          -- 业务幂等键；同键重复 emit 返回既有事件
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_library_seq ON event_log(library_id, seq);

-- 每个消费端（浏览器/设备）一条游标：last_seq 之前的事件视为已投递。
-- 服务端在连接建立、以及每次发送后推进游标，配合 SSE 自带 Last-Event-ID 双保险。
CREATE TABLE IF NOT EXISTS event_consumer (
  client_id   TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_consumer_library ON event_consumer(library_id);
