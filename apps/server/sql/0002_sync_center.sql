-- 多端事件同步中心：事件持久化（断线补漏）+ 按资料库隔离 + 消费游标（同一事件不得重复消费）
-- 文档第 23 章：多端事件同步。

-- 事件总线落库：每一条事件只写一次，全局自增 seq 作为各端续传游标。
-- library_id 是隔离边界：所有补拉/游标查询都强制带 library_id。
CREATE TABLE IF NOT EXISTS sync_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- 单调递增，即 SSE 的 id: 与补拉游标
  library_id  TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('asset_processed','window_changed','reminder_created','reminder_updated')),
  payload     TEXT NOT NULL DEFAULT '{}',
  -- 业务幂等键：同一业务事实（如同一条窗口同日同因变化）在任何重试下只产生一条事件。
  -- NULL 表示调用方未提供（每次都是独立事件）。
  dedupe_key  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (library_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_event_library_seq ON sync_event(library_id, id);
CREATE INDEX IF NOT EXISTS idx_sync_event_created ON sync_event(created_at);

-- 每个端（设备/标签页）一条游标：记录"该端已确认消费到哪一条"。
-- 重连补拉从 last_event_id 之后开始；游标确认后即使再断线也不会重复投递。
CREATE TABLE IF NOT EXISTS sync_cursor (
  id              TEXT PRIMARY KEY,
  library_id      TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL,                 -- 端标识：设备/标签页各自生成并持久化
  last_event_id   INTEGER NOT NULL DEFAULT 0,
  last_connected  TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (library_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_cursor_library ON sync_cursor(library_id);
