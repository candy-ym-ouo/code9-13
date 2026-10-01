import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let tmpDir = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-sync-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const { getDb, newId, nowIso, migrate } = await import('../src/db.js');
  migrate();
  const db = getDb();
  // 事件表对 library 有外键，先造用户与两个资料库
  db.prepare('INSERT INTO "user" (id,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('owner-1', 'o@test.local', 'x', 'Owner', nowIso(), nowIso());
  const mkLibrary = (id: string) =>
    db
      .prepare('INSERT INTO library (id,name,owner_id,tz,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, id, 'owner-1', 'Asia/Shanghai', nowIso(), nowIso());
  mkLibrary('lib-a');
  mkLibrary('lib-b');
  return db;
}

describe('多端事件同步中心', () => {
  it('事件落库后全局序号单调递增，且按资料库隔离', async () => {
    await setup();
    const events = await import('../src/services/events.js');

    const e1 = events.emitEvent({ type: 'asset_processed', libraryId: 'lib-a', payload: { n: 1 } }, 'a1');
    const e2 = events.emitEvent({ type: 'window_changed', libraryId: 'lib-b', payload: { n: 2 } }, 'b1');
    const e3 = events.emitEvent({ type: 'reminder_created', libraryId: 'lib-a', payload: { n: 3 } }, 'a2');

    expect(e2!.id).toBeGreaterThan(e1!.id);
    expect(e3!.id).toBeGreaterThan(e2!.id);

    const onlyA = events.eventsAfter('lib-a', 0).events.map((e) => e.libraryId);
    expect(onlyA).toEqual(['lib-a', 'lib-a']);
    const onlyB = events.eventsAfter('lib-b', 0).events;
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].libraryId).toBe('lib-b');
  });

  it('同一幂等键重复触发只保留一条事件（同一业务事实不重复消费）', async () => {
    const events = await import('../src/services/events.js');
    const first = events.emitEvent(
      { type: 'window_changed', libraryId: 'lib-a', payload: { date: '2026-10-11', to: 'good' } },
      'window:x:2026-10-11:bad>good',
    );
    const second = events.emitEvent(
      { type: 'window_changed', libraryId: 'lib-a', payload: { date: '2026-10-11', to: 'good' } },
      'window:x:2026-10-11:bad>good',
    );
    expect(second).toBeNull();
    expect(first).not.toBeNull();
    const count = events
      .eventsAfter('lib-a', 0)
      .events.filter((e) => e.payload.date === '2026-10-11').length;
    expect(count).toBe(1);
  });

  it('断线补漏：afterId 之后的事件连续可补，且不含游标本身', async () => {
    const events = await import('../src/services/events.js');
    const all = events.eventsAfter('lib-a', 0).events;
    const mid = all[0].id;
    const missed = events.eventsAfter('lib-a', mid).events;
    expect(missed.every((e) => e.id > mid)).toBe(true);
    expect(missed.map((e) => e.id)).toEqual([...missed].map((e) => e.id).sort((x, y) => x - y));
  });

  it('消费游标单调推进：乱序/重复 ack 不回拨，已确认事件不再补拉', async () => {
    const events = await import('../src/services/events.js');
    const all = events.eventsAfter('lib-a', 0).events;
    const first = all[0].id;
    const last = all[all.length - 1].id;

    // 先确认到最后
    expect(events.advanceCursor('lib-a', 'device-1', last)).toBe(last);
    // 再用更旧的序号确认：游标不得回拨
    expect(events.advanceCursor('lib-a', 'device-1', first)).toBe(last);
    // 以游标为起点补拉：没有任何新事件（不会把已消费的再发一遍）
    expect(events.eventsAfter('lib-a', last).events).toHaveLength(0);
    // 不同端各自独立
    expect(events.getCursor('lib-a', 'device-2')).toBeUndefined();
  });

  it('事务回滚时事件一并消失，绝不扇出"没有发生的事"', async () => {
    const events = await import('../src/services/events.js');
    const before = events.eventsAfter('lib-a', 0).events.length;
    expect(() =>
      events.runInEventTx((record) => {
        record({ type: 'asset_processed', libraryId: 'lib-a', payload: { rollback: true } }, 'rollback-1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const after = events.eventsAfter('lib-a', 0).events.filter((e) => e.payload.rollback).length;
    expect(after).toBe(0);
    expect(events.eventsAfter('lib-a', 0).events.length).toBe(before);
  });

  it('事务提交后事件才落库，且提交的事件在补拉中可见', async () => {
    const events = await import('../src/services/events.js');
    events.runInEventTx((record) => {
      record({ type: 'reminder_updated', libraryId: 'lib-b', payload: { ok: true } }, 'commit-1');
    });
    const got = events.eventsAfter('lib-b', 0).events.find((e) => e.payload.ok === true);
    expect(got).toBeTruthy();
  });

  it('游标落在保留窗口之外时返回 resync，要求全量重拉', async () => {
    const { getDb } = await import('../src/db.js');
    const events = await import('../src/services/events.js');
    // 人为造一条很旧的事件并删掉中间历史，制造无法补齐的缺口
    const db = getDb();
    db.prepare("DELETE FROM sync_event WHERE library_id = 'lib-a' AND payload NOT LIKE '%gap%'").run();
    db.prepare(
      "INSERT INTO sync_event (library_id,type,payload,created_at) VALUES ('lib-a','asset_processed','{\"gap\":true}','2000-01-01T00:00:00.000Z')",
    ).run();
    const res = events.eventsAfter('lib-a', 1);
    expect(res.resync).toBe(true);
  });
});
