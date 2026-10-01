import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, migrate, closeDb } from '../src/db.js';
import {
  emitEvent,
  recordEvent,
  replayEvents,
  latestSeq,
  touchConsumer,
  getConsumer,
  pruneEventLog,
  openEventStream,
} from '../src/services/events.js';

let tmpDir = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-events-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.JWT_SECRET = 'test-secret';
  migrate();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const LIB_A = 'lib-a';
const LIB_B = 'lib-b';

describe('事件同步中心：持久化日志', () => {
  it('事件按序落库，seq 单调递增', () => {
    const e1 = emitEvent({ type: 'asset_processed', libraryId: LIB_A, dedupKey: 't:1', payload: { n: 1 } });
    const e2 = emitEvent({ type: 'window_changed', libraryId: LIB_A, dedupKey: 't:2', payload: { n: 2 } });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect(e1.id).toBeTruthy();
    expect(e1.payload).toEqual({ n: 1 });
  });

  it('同一 dedupKey 重复 emit 只落一条（同一事件不得重复消费的服务端总闸）', () => {
    const first = emitEvent({ type: 'reminder_created', libraryId: LIB_A, dedupKey: 'dup:1', payload: { x: 1 } });
    const second = emitEvent({ type: 'reminder_created', libraryId: LIB_A, dedupKey: 'dup:1', payload: { x: 2 } });
    expect(second.seq).toBe(first.seq);
    expect(second.payload).toEqual({ x: 1 }); // 返回的是首次落库的事实
    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM event_log WHERE dedup_key = ?').get('dup:1') as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('recordEvent 在事务内与业务数据原子写入；事务回滚则事件也不留下', () => {
    const countBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const latestBefore = latestSeq(LIB_A);

    const failing = getDb().transaction(() => {
      recordEvent({ type: 'window_changed', libraryId: LIB_A, dedupKey: 'tx:fail', payload: {} });
      throw new Error('rollback');
    });
    expect(() => failing()).toThrow('rollback');
    // 回滚后：行数不变、本库最新 seq 不变（注：AUTOINCREMENT 序列本身会消耗，属 SQLite 正常行为）
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(countBefore);
    expect(latestSeq(LIB_A)).toBe(latestBefore);

    const succeeding = getDb().transaction(() => {
      recordEvent({ type: 'window_changed', libraryId: LIB_A, dedupKey: 'tx:commit', payload: {} });
    });
    succeeding();
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n).toBe(countBefore + 1);
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM event_log WHERE dedup_key = ?').get('tx:commit') as { n: number },
    ).toEqual({ n: 1 });
  });
});

describe('事件同步中心：按资料库隔离', () => {
  it('replayEvents 只返回指定库的事件，且不含异库任何数据', () => {
    emitEvent({ type: 'asset_processed', libraryId: LIB_A, dedupKey: `iso:a${Math.random()}`, payload: {} });
    const beforeB = replayEvents(LIB_B, 0).length;
    emitEvent({ type: 'asset_processed', libraryId: LIB_B, dedupKey: `iso:b${Math.random()}`, payload: {} });
    const a = replayEvents(LIB_A, 0);
    const b = replayEvents(LIB_B, 0);
    expect(a.every((e) => e.libraryId === LIB_A)).toBe(true);
    expect(b.every((e) => e.libraryId === LIB_B)).toBe(true);
    expect(b.length).toBe(beforeB + 1);
    // 异库事件一条都不允许漏过来
    expect(a.some((e) => e.libraryId === LIB_B)).toBe(false);
  });
});

describe('事件同步中心：断线重连补漏', () => {
  it('afterSeq 之后的事件按序返回，边界为严格大于', () => {
    const base = latestSeq(LIB_A);
    const first = emitEvent({
      type: 'reminder_updated',
      libraryId: LIB_A,
      dedupKey: `gap:1:${Math.random()}`,
      payload: { i: 1 },
    });
    emitEvent({ type: 'reminder_updated', libraryId: LIB_A, dedupKey: `gap:2:${Math.random()}`, payload: { i: 2 } });
    emitEvent({ type: 'reminder_updated', libraryId: LIB_A, dedupKey: `gap:3:${Math.random()}`, payload: { i: 3 } });
    const missed = replayEvents(LIB_A, first.seq); // 从第二条开始补（严格大于）
    expect(missed.map((e) => (e.payload as { i: number }).i)).toEqual([2, 3]);
    expect(base).toBeGreaterThanOrEqual(0);
  });

  it('服务端消费游标只增不减，换库不会串游标', () => {
    const clientId = `dev-cursor-${Math.random().toString(36).slice(2)}`;
    const c = touchConsumer(clientId, LIB_A, 10);
    expect(c.created).toBe(true);
    expect(touchConsumer(clientId, LIB_A, 5).lastSeq).toBe(10); // 不回拨
    expect(touchConsumer(clientId, LIB_A, 20).lastSeq).toBe(20);
    expect(getConsumer(clientId)?.libraryId).toBe(LIB_A);
  });

  it('事件超过保留窗口被清理（补漏承诺有界）', () => {
    const e = emitEvent({
      type: 'asset_processed',
      libraryId: LIB_A,
      dedupKey: `old:${Math.random()}`,
      payload: {},
    });
    getDb().prepare('UPDATE event_log SET created_at = ? WHERE seq = ?').run(
      new Date(Date.now() - 30 * 86400_000).toISOString(),
      e.seq,
    );
    pruneEventLog(7);
    expect(replayEvents(LIB_A, 0).find((x) => x.seq === e.seq)).toBeUndefined();
  });
});

// -----------------------------------------------------------------
// SSE 流：用最小可写 Response mock 验证帧格式、补漏与去重
// -----------------------------------------------------------------

function mockRes(): {
  res: Response;
  chunks: string[];
  closed: boolean;
  headers: Record<string, string>;
} {
  const chunks: string[] = [];
  const state = {
    chunks,
    closed: false,
    headers: {} as Record<string, string>,
  };
  const res = {
    writeHead(_status: number, headers: Record<string, string>) {
      state.headers = headers;
    },
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
    emit() {},
  } as unknown as Response;
  return { res, get chunks() { return state.chunks; }, get closed() { return state.closed; }, headers: state.headers };
}

/** 从写入的文本块中解析出业务事件帧 */
function parseFrames(chunks: string[]): { event: string; id?: number; data?: Record<string, unknown> }[] {
  const text = chunks.join('');
  const frames = text.split('\n\n').filter((f) => f.trim() && !f.startsWith(':') && !f.startsWith('event: hello'));
  return frames
    .map((frame) => {
      const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
      const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      return {
        event: eventLine?.slice(7) ?? '',
        id: idLine ? Number(idLine.slice(4)) : undefined,
        data: dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : undefined,
      };
    })
    .filter((f) => f.event && f.event !== 'resync_required');
}

describe('事件同步中心：SSE 流', () => {
  it('建流时先回放 afterSeq 之后的历史事件，并推进游标', () => {
    const eA = emitEvent({
      type: 'asset_processed',
      libraryId: LIB_B,
      dedupKey: `sse:1:${Math.random()}`,
      payload: { v: 'a' },
    });
    const eB = emitEvent({
      type: 'window_changed',
      libraryId: LIB_B,
      dedupKey: `sse:2:${Math.random()}`,
      payload: { v: 'b' },
    });

    const mock = mockRes();
    openEventStream(mock.res, LIB_B, { clientId: 'dev-sse-1', afterSeq: eA.seq - 1 });
    const frames = parseFrames(mock.chunks);
    expect(frames.map((f) => f.data?.v)).toEqual(['a', 'b']);
    expect(frames[0].id).toBe(eA.seq);
    expect(getConsumer('dev-sse-1')?.lastSeq).toBe(eB.seq);
  });

  it('同库事件实时推送；异库事件被隔离；同 seq 绝不投递两次', () => {
    const mock = mockRes();
    openEventStream(mock.res, LIB_A, { clientId: 'dev-sse-2', afterSeq: latestSeq(LIB_A) });
    const before = parseFrames(mock.chunks).length;

    // 异库：不应出现
    emitEvent({ type: 'asset_processed', libraryId: LIB_B, dedupKey: `live:b:${Math.random()}`, payload: { who: 'b' } });
    // 同库：应出现一次
    const live = emitEvent({
      type: 'reminder_updated',
      libraryId: LIB_A,
      dedupKey: `live:a:${Math.random()}`,
      payload: { who: 'a' },
    });
    // 重复触发同键：不新增帧
    emitEvent({ type: 'reminder_updated', libraryId: LIB_A, dedupKey: live.dedupKey, payload: { who: 'a2' } });

    const frames = parseFrames(mock.chunks);
    expect(frames.length).toBe(before + 1);
    expect(frames[frames.length - 1].id).toBe(live.seq);
    expect(frames[frames.length - 1].data?.who).toBe('a');
    expect(frames.some((f) => f.data?.who === 'b')).toBe(false);
  });

  it('回放与实时交界重叠时按 seq 去重（断线重连的经典竞态）', () => {
    // 先建流拿游标，模拟"断线"期间到达一条事件，再用旧 seq 重连
    const mock1 = mockRes();
    const h1 = openEventStream(mock1.res, LIB_B, { clientId: 'dev-sse-3', afterSeq: latestSeq(LIB_B) });
    h1.unsubscribe();

    const duringOffline = emitEvent({
      type: 'window_changed',
      libraryId: LIB_B,
      dedupKey: `race:${Math.random()}`,
      payload: { phase: 'offline' },
    });
    // 重连：afterSeq 指向断线前 → 回放该事件
    const mock2 = mockRes();
    openEventStream(mock2.res, LIB_B, { clientId: 'dev-sse-3', afterSeq: duringOffline.seq - 1 });
    const frames = parseFrames(mock2.chunks);
    expect(frames.filter((f) => f.id === duringOffline.seq)).toHaveLength(1);
  });
});
