import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { getDb, nowIso } from '../db.js';
import { logger } from '../logger.js';

export type SseEventType = 'asset_processed' | 'window_changed' | 'reminder_created' | 'reminder_updated';

export interface SseEvent {
  type: SseEventType;
  libraryId: string;
  payload: Record<string, unknown>;
  /**
   * 业务幂等键：同一业务事实（同一批素材处理、同一次判定跳变、同一条提醒的同一次状态迁移）
   * 无论触发多少次，event_log 中只落一条。必须由调用方提供，禁止缺省。
   */
  dedupKey: string;
}

export interface PersistedEvent {
  seq: number;
  id: string;
  libraryId: string;
  type: SseEventType;
  payload: Record<string, unknown>;
  dedupKey: string;
  createdAt: string;
}

/** 事件保留窗口（天）：超过后清理，断线重连只承诺该窗口内可补漏 */
const RETENTION_DAYS = 7;
/** 单次连接最多回放条数，避免新客户端拖出巨量历史 */
const MAX_REPLAY = 500;

// ---------------------------------------------------------------------------
// 实时扇出（仅活连接；可靠性由 event_log 保证，进程重启/断线期间靠重放补漏）
// ---------------------------------------------------------------------------

const bus = new EventEmitter();
bus.setMaxListeners(200);

interface LiveClient {
  libraryId: string;
  deliver: (event: PersistedEvent) => void;
}

const clients = new Set<LiveClient>();

function fanout(event: PersistedEvent): void {
  bus.emit('event', event);
}

// ---------------------------------------------------------------------------
// 持久化：durable log，dedup_key 唯一约束在数据库层兜底
// ---------------------------------------------------------------------------

function rowToEvent(row: Record<string, unknown>): PersistedEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload as string);
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    seq: Number(row.seq),
    id: row.id as string,
    libraryId: row.library_id as string,
    type: row.type as SseEventType,
    payload,
    dedupKey: row.dedup_key as string,
    createdAt: row.created_at as string,
  };
}

function insertOrGet(event: SseEvent): PersistedEvent | null {
  const db = getDb();
  try {
    const ts = nowIso();
    const result = db
      .prepare(
        `INSERT INTO event_log (id, library_id, type, payload, dedup_key, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(randomUUID(), event.libraryId, event.type, JSON.stringify(event.payload ?? {}), event.dedupKey, ts);
    const row = db.prepare('SELECT * FROM event_log WHERE seq = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    return rowToEvent(row);
  } catch (err) {
    // UNIQUE 冲突 = 同一业务事件已被记录过：取回既有记录，绝不重复落库
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const row = db
        .prepare('SELECT * FROM event_log WHERE library_id = ? AND dedup_key = ?')
        .get(event.libraryId, event.dedupKey) as Record<string, unknown> | undefined;
      if (row) return rowToEvent(row);
      return null;
    }
    throw err;
  }
}

/**
 * 仅持久化、不实时推送。用于"外层数据库事务尚未提交"的场景：
 * 与业务数据在同一事务内写入（原子性），提交后由调用方扇出。
 * 返回 null 表示该 dedupKey 的事件已存在（本次是重复触发，调用方不应再推送）。
 */
export function recordEvent(event: SseEvent): PersistedEvent | null {
  return insertOrGet(event);
}

/**
 * 持久化并实时推送给当前在线的同库客户端。
 * dedupKey 已存在时直接返回既有事件、不重复推送 —— 同一事件不重复消费的服务端总闸。
 */
export function emitEvent(event: SseEvent): PersistedEvent {
  const persisted = insertOrGet(event);
  if (persisted) fanout(persisted);
  return persisted ?? loadByDedup(event);
}

function loadByDedup(event: SseEvent): PersistedEvent {
  const row = getDb()
    .prepare('SELECT * FROM event_log WHERE dedup_key = ?')
    .get(event.dedupKey) as Record<string, unknown>;
  return rowToEvent(row);
}

/** 事务提交后批量扇出（已被 dedup 的条目为 null，自然跳过） */
export function fanoutPending(events: (PersistedEvent | null)[]): void {
  for (const e of events) if (e) fanout(e);
}

/** 断线重连补漏：取本库 seq 严格大于 afterSeq 的事件，按序返回；库隔离在 SQL 层强制 */
export function replayEvents(libraryId: string, afterSeq: number, limit = MAX_REPLAY): PersistedEvent[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM event_log WHERE library_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    )
    .all(libraryId, afterSeq, limit) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function latestSeq(libraryId: string): number {
  const row = getDb()
    .prepare('SELECT MAX(seq) AS s FROM event_log WHERE library_id = ?')
    .get(libraryId) as { s: number | null };
  return Number(row.s ?? 0);
}

/** 清理超出保留窗口的事件；顺带删除孤儿消费端游标 */
export function pruneEventLog(retentionDays = RETENTION_DAYS): void {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const db = getDb();
  db.prepare('DELETE FROM event_log WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM event_consumer WHERE last_seen_at < ?').run(cutoff);
}

// ---------------------------------------------------------------------------
// 消费端游标：服务端记住每个多端（浏览器/设备）收到哪里
// ---------------------------------------------------------------------------

export function getConsumer(clientId: string): { clientId: string; libraryId: string; lastSeq: number } | null {
  const row = getDb().prepare('SELECT * FROM event_consumer WHERE client_id = ?').get(clientId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    clientId: row.client_id as string,
    libraryId: row.library_id as string,
    lastSeq: Number(row.last_seq),
  };
}

/**
 * 登记/心跳一个消费端。
 * 游标只增不减（last_seq = max），避免乱序重连把已投递位置回拨。
 */
export function touchConsumer(clientId: string, libraryId: string, lastSeq = 0): { lastSeq: number; created: boolean } {
  const db = getDb();
  const existing = getConsumer(clientId);
  const ts = nowIso();
  if (existing) {
    if (existing.libraryId !== libraryId) {
      // clientId 复用但库变了（理论上不该发生）：重置，绝不跨库串数据
      db.prepare('UPDATE event_consumer SET library_id = ?, last_seq = ?, last_seen_at = ? WHERE client_id = ?').run(
        libraryId,
        lastSeq,
        ts,
        clientId,
      );
      return { lastSeq, created: false };
    }
    const next = Math.max(existing.lastSeq, lastSeq);
    db.prepare('UPDATE event_consumer SET last_seq = ?, last_seen_at = ? WHERE client_id = ?').run(next, ts, clientId);
    return { lastSeq: next, created: false };
  }
  db.prepare(
    'INSERT INTO event_consumer (client_id, library_id, last_seq, last_seen_at, created_at) VALUES (?,?,?,?,?)',
  ).run(clientId, libraryId, lastSeq, ts, ts);
  return { lastSeq, created: true };
}

function advanceConsumer(clientId: string, seq: number): void {
  getDb()
    .prepare('UPDATE event_consumer SET last_seq = ?, last_seen_at = ? WHERE client_id = ? AND last_seq < ?')
    .run(seq, nowIso(), clientId, seq);
}

// ---------------------------------------------------------------------------
// SSE 连接：回放补漏 → 实时订阅 → 心跳保活
// ---------------------------------------------------------------------------

export interface StreamOptions {
  clientId: string;
  /** SSE 标准 Last-Event-ID 头；显式 afterSeq 优先，其次游标，最后 Last-Event-ID */
  lastEventId?: string;
  afterSeq?: number;
  keepAliveMs?: number;
}

export interface StreamHandle {
  unsubscribe: () => void;
}

/**
 * 打开一条按库隔离的事件流。
 * 调用方必须在进入前完成鉴权并写好响应头之前调用（本函数写 200 与 SSE 头）。
 *
 * 补漏顺序（优先级）：?afterSeq > Last-Event-ID 头 > 服务端持久游标。
 * 同一连接内用 deliveredSeqs 去重；重放与实时消息交界期可能重叠，重叠事件只投递一次。
 */
export function openEventStream(res: Response, libraryId: string, options: StreamOptions): StreamHandle {
  const { clientId, keepAliveMs = 25000 } = options;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 明确告知中间代理不要缓冲，保证补漏/实时消息即时到达
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  const client: LiveClient = {
    libraryId,
    deliver: (event) => writeEvent(event),
  };

  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  // 只增去重集合，封顶后只保留最新一半（seq 单调，更旧的序号不可能重放）
  let deliveredSeqs = new Set<number>();
  const capDelivered = (): void => {
    if (deliveredSeqs.size <= 4096) return;
    const keep = [...deliveredSeqs].sort((a, b) => b - a).slice(0, 2048);
    deliveredSeqs = new Set(keep);
  };

  const writeEvent = (event: PersistedEvent): void => {
    if (closed) return;
    if (event.libraryId !== libraryId) return; // 双保险：库隔离
    if (deliveredSeqs.has(event.seq)) return; // 同一条绝不投递第二次
    deliveredSeqs.add(event.seq);
    capDelivered();
    res.write(`id: ${event.seq}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify({ ...event.payload, eventId: event.id, seq: event.seq })}\n\n`);
    advanceConsumer(clientId, event.seq);
  };

  // ---- 确定补漏起点：显式参数 > Last-Event-ID > 服务端游标 ----
  const existing = touchConsumer(clientId, libraryId, 0);
  let afterSeq = existing.lastSeq;
  if (options.afterSeq !== undefined && Number.isFinite(options.afterSeq)) {
    afterSeq = Math.max(0, Math.floor(options.afterSeq));
  } else if (options.lastEventId !== undefined && /^\d+$/.test(options.lastEventId)) {
    afterSeq = Math.max(afterSeq, Number(options.lastEventId));
  }

  // ---- 先挂实时监听，再回放：回放窗口内到达的新事件也不会丢 ----
  const listener = (event: PersistedEvent): void => client.deliver(event);
  bus.on('event', listener);
  clients.add(client);

  try {
    const backlog = replayEvents(libraryId, afterSeq);
    for (const e of backlog) writeEvent(e);
    const remaining = latestSeq(libraryId) - afterSeq;
    if (remaining > backlog.length) {
      // 缺口超出单次回放上限：通知客户端走全量刷新，不要假装补全了
      res.write(`event: resync_required\ndata: ${JSON.stringify({ reason: 'backlog_too_large', afterSeq })}\n\n`);
    }
    const cursor = getConsumer(clientId)?.lastSeq ?? afterSeq;
    res.write(`event: hello\ndata: ${JSON.stringify({ libraryId, clientId, lastSeq: cursor, replayed: backlog.length })}\n\n`);
  } catch (err) {
    logger.warn('事件回放失败', { clientId, error: String(err) });
    if (!closed) {
      res.write(`event: resync_required\ndata: ${JSON.stringify({ reason: 'replay_failed' })}\n\n`);
    }
  }

  keepAlive = setInterval(() => {
    if (closed) return;
    res.write(': keep-alive\n\n');
    // 心跳顺带续游标生命周期，使持续在线的设备不被清理
    try {
      getDb()
        .prepare('UPDATE event_consumer SET last_seen_at = ? WHERE client_id = ?')
        .run(nowIso(), clientId);
    } catch {
      // 数据库关闭中（停机）等场景：忽略
    }
  }, keepAliveMs);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    bus.off('event', listener);
    clients.delete(client);
  };

  res.on('close', cleanup);

  return { unsubscribe: cleanup };
}

export function clientCount(): number {
  return clients.size;
}
