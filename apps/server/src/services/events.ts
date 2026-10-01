import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { getDb, nowIso, parseJson } from '../db.js';

export type SseEventType = 'asset_processed' | 'window_changed' | 'reminder_created' | 'reminder_updated';

export interface SseEvent {
  type: SseEventType;
  libraryId: string;
  payload: Record<string, unknown>;
}

/** 落库后的事件：id 即全局单调递增序号，也是各端断线续传的游标。 */
export interface RecordedEvent {
  id: number;
  libraryId: string;
  type: SseEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** 补拉最多一次返回的条数；超过窗口（30 天前已清理）则要求客户端全量重拉。 */
export const MAX_REPLAY = 500;
const RETENTION_DAYS = 30;

/**
 * 内存总线只负责"在线实时扇出"；可补漏的事实来源是 sync_event 表。
 * 监听器收到的永远是已落库的 RecordedEvent（带序号），按资料库过滤。
 */
const bus = new EventEmitter();
bus.setMaxListeners(200);

const clients = new Set<{ libraryId: string; res: Response }>();

function rowToEvent(row: Record<string, unknown>): RecordedEvent {
  return {
    id: row.id as number,
    libraryId: row.library_id as string,
    type: row.type as SseEventType,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: row.created_at as string,
  };
}

export interface RecordResult {
  event: RecordedEvent;
  inserted: boolean; // false = 命中幂等键被抑制（事件早已记录/扇出过）
}

/**
 * 事件落库（业务幂等的最后一道闸）。
 * 同一 (library_id, dedupe_key) 只保留第一条：任何上游重试/重复触发都不会产生第二条事件。
 * 不传 dedupeKey 时 SQLite 唯一索引把多个 NULL 视为互不相同，每次都是独立事件。
 */
export function recordEvent(event: SseEvent, dedupeKey?: string): RecordResult {
  const db = getDb();
  const ts = nowIso();
  const info = db
    .prepare('INSERT OR IGNORE INTO sync_event (library_id, type, payload, dedupe_key, created_at) VALUES (?,?,?,?,?)')
    .run(event.libraryId, event.type, JSON.stringify(event.payload ?? {}), dedupeKey ?? null, ts);

  let row: Record<string, unknown>;
  let inserted: boolean;
  if (info.changes > 0) {
    row = db.prepare('SELECT * FROM sync_event WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
    inserted = true;
  } else {
    // 命中唯一键（dedupeKey 重复）：取回既有事件并标记为"未新插入"，调用方据此跳过扇出。
    row =
      dedupeKey !== undefined
        ? (db
            .prepare('SELECT * FROM sync_event WHERE library_id = ? AND dedupe_key = ?')
            .get(event.libraryId, dedupeKey) as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    inserted = false;
  }

  return { event: rowToEvent(row), inserted };
}

/** 向该资料库当前在线的端实时扇出一条已落库事件。 */
function fanout(rec: RecordedEvent): void {
  bus.emit('event', rec);
}

function formatSse(rec: RecordedEvent): string {
  return `id: ${rec.id}\nevent: ${rec.type}\ndata: ${JSON.stringify(rec.payload)}\n\n`;
}

/**
 * 记录并实时扇出（无外层事务时使用）。
 * 被 dedupeKey 抑制时不重复扇出，保证同一业务事实只下发一次。
 * 返回新事件；命中幂等键被抑制时返回 null。
 */
export function emitEvent(event: SseEvent, dedupeKey?: string): RecordedEvent | null {
  const { event: rec, inserted } = recordEvent(event, dedupeKey);
  if (inserted) fanout(rec);
  return inserted ? rec : null;
}

/**
 * 在一个数据库事务内执行业务并收集其中产生的事件：
 * - 事件与业务改动在同一事务里落库——事务回滚则事件一并消失，绝不下发"没有发生的事"；
 * - 事务成功提交后才统一实时扇出——端上不会先收到通知、读数据却还查不到。
 */
export function runInEventTx<T>(fn: (record: (event: SseEvent, dedupeKey?: string) => void) => T): T {
  const buffered: RecordedEvent[] = [];
  const record = (event: SseEvent, dedupeKey?: string): void => {
    const { event: rec, inserted } = recordEvent(event, dedupeKey);
    if (inserted) buffered.push(rec);
  };
  const tx = getDb().transaction(fn);
  const result = tx(record);
  for (const rec of buffered) fanout(rec);
  return result;
}

/**
 * 订阅某资料库的实时事件；返回退订函数。
 * isPast 用于在"先订阅、后回放"时滤掉回放范围内、可能已被实时监听到的事件，
 * 保证 replay 与 live 按 id 不重叠（同一事件不投递两次）。
 */
export function subscribe(
  libraryId: string,
  res: Response,
  isPast: (id: number) => boolean = () => false,
): () => void {
  const client = { libraryId, res };
  clients.add(client);
  const listener = (rec: RecordedEvent) => {
    if (rec.libraryId !== libraryId) return;
    if (isPast(rec.id)) return;
    res.write(formatSse(rec));
  };
  bus.on('event', listener);
  return () => {
    clients.delete(client);
    bus.off('event', listener);
  };
}

export function clientCount(): number {
  return clients.size;
}

export interface ReplayResult {
  events: RecordedEvent[];
  latestId: number;
  /** true 表示游标已落在保留窗口之外（缺口），事件补不回来，端上必须全量重拉。 */
  resync: boolean;
}

/**
 * 断线补漏：取某资料库中序号严格大于 afterId 的事件（按资料库隔离）。
 * afterId=0 表示从头取（REST 分页）；游标过旧、缺口超出保留窗口时 resync=true。
 */
export function eventsAfter(libraryId: string, afterId: number, limit = MAX_REPLAY): ReplayResult {
  const db = getDb();
  const bounds = db
    .prepare('SELECT COALESCE(MIN(id),0) AS min_id, COALESCE(MAX(id),0) AS max_id FROM sync_event WHERE library_id = ?')
    .get(libraryId) as { min_id: number; max_id: number };

  if (bounds.max_id <= afterId) {
    return { events: [], latestId: bounds.max_id, resync: false };
  }
  // 游标比现存最老事件还旧：中间的事件已过保留期被清理，存在无法补齐的缺口。
  if (afterId > 0 && afterId < bounds.min_id - 1) {
    return { events: [], latestId: bounds.max_id, resync: true };
  }

  const rows = db
    .prepare('SELECT * FROM sync_event WHERE library_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(libraryId, afterId, limit + 1) as Record<string, unknown>[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(rowToEvent);
  return { events: page, latestId: bounds.max_id, resync: hasMore };
}

/** 某资料库当前最新事件序号（新端首次连接时作为"只看实时"的起点）。 */
export function latestEventId(libraryId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(id),0) AS max_id FROM sync_event WHERE library_id = ?')
    .get(libraryId) as { max_id: number };
  return row.max_id;
}

// ---------------------------------------------------------------- 端游标

/** 读取某端已确认消费到的序号；无记录返回 undefined（首次连接）。 */
export function getCursor(libraryId: string, clientId: string): number | undefined {
  const row = getDb()
    .prepare('SELECT last_event_id FROM sync_cursor WHERE library_id = ? AND client_id = ?')
    .get(libraryId, clientId) as { last_event_id: number } | undefined;
  return row?.last_event_id;
}

/**
 * 连接登记/心跳：更新最近连接时间。
 * 新端首次连接（无游标）时用 baseline 作为基线位置，避免它重连时回放连接前的全部历史；
 * 已有游标（lastEventId>0）的端绝不改动其消费位置。
 */
export function touchCursor(libraryId: string, clientId: string, userAgent: string | null, baseline = 0): void {
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO sync_cursor (id, library_id, client_id, last_event_id, last_connected, user_agent, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (library_id, client_id) DO UPDATE SET last_connected = excluded.last_connected, updated_at = excluded.updated_at`,
  ).run(`cur_${libraryId}_${clientId}`.slice(0, 64), libraryId, clientId, baseline, ts, userAgent, ts, ts);
}

/**
 * 确认消费：单调推进游标，乱序/重复的 ack 绝不能把位置回拨
 * （回拨会让已消费事件被再次补拉，破坏"同一事件不得重复消费"）。
 * 返回推进后的序号。
 */
export function advanceCursor(libraryId: string, clientId: string, lastEventId: number): number {
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO sync_cursor (id, library_id, client_id, last_event_id, last_connected, user_agent, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (library_id, client_id) DO UPDATE SET
       last_event_id = CASE WHEN excluded.last_event_id > sync_cursor.last_event_id
                            THEN excluded.last_event_id ELSE sync_cursor.last_event_id END,
       updated_at = excluded.updated_at`,
  ).run(`cur_${libraryId}_${clientId}`.slice(0, 64), libraryId, clientId, lastEventId, ts, null, ts, ts);
  return getCursor(libraryId, clientId) ?? 0;
}

/** 清理超过保留期的事件日志；游标保留（其位置过旧时由 eventsAfter 判定为 resync）。 */
export function pruneEventLog(now = new Date()): number {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  const info = getDb().prepare('DELETE FROM sync_event WHERE created_at < ?').run(cutoff);
  return info.changes;
}
