import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { offlineOpSchema } from '@flil/shared';
import { getDb, newId, nowIso } from '../db.js';
import { config } from '../config.js';
import { ah, ok } from '../http/respond.js';
import { authenticate, requireOwner } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import { createBackup, exportAll, listBackups, restoreBackup } from '../services/backup.js';
import { addTags, createInspiration, requireInspiration } from '../services/inspirations.js';
import {
  advanceCursor,
  eventsAfter,
  getCursor,
  latestEventId,
  MAX_REPLAY,
  subscribe,
  touchCursor,
} from '../services/events.js';
import { recomputeHitRate } from '../services/calibration.js';
import { toJson } from '../db.js';

export const opsRouter = Router();

/** 健康检查：不需要登录，用于运维与冒烟脚本 */
opsRouter.get(
  '/health',
  ah(async (_req, res) => {
    const db = getDb();
    let dbOk = true;
    try {
      db.prepare('SELECT 1 AS x').get();
    } catch {
      dbOk = false;
    }
    const dirs = Object.fromEntries(
      Object.entries({
        uploads: config.uploadDir,
        thumbs: config.thumbDir,
        share: config.shareDir,
        backups: config.backupDir,
      }).map(([k, dir]) => {
        try {
          fs.accessSync(dir, fs.constants.W_OK);
          return [k, 'ok'];
        } catch {
          return [k, 'unwritable'];
        }
      }),
    );

    ok(res, {
      ok: dbOk && Object.values(dirs).every((v) => v === 'ok'),
      db: dbOk ? 'ok' : 'error',
      dirs,
      weatherProvider: config.weatherProvider,
      weatherDegraded: config.weatherProvider === 'off',
      shareEnabled: config.enableShare,
      version: '1.0.0',
      time: nowIso(),
    });
  }),
);

/**
 * 注意：Router.use() 对「所有经过该 router 的请求」生效，
 * 所以这里必须显式放过公开路径，否则后面的公开分享路由永远收不到请求。
 */
opsRouter.use((req, res, next) => {
  if (req.path.startsWith('/share/')) return next();
  return authenticate()(req, res, next);
});

/** 图片与数据库一致性巡检：找出缺失文件与孤儿记录 */
opsRouter.get(
  '/health/verify-assets',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const rows = getDb().prepare('SELECT id, file_path, thumb_path FROM asset WHERE library_id = ?').all(
      ctx.libraryId,
    ) as { id: string; file_path: string; thumb_path: string | null }[];
    const missing = rows.filter((r) => !fs.existsSync(r.file_path)).map((r) => r.id);
    const missingThumbs = rows.filter((r) => r.thumb_path && !fs.existsSync(r.thumb_path)).map((r) => r.id);
    ok(res, { total: rows.length, missing, missingThumbs });
  }),
);

opsRouter.post(
  '/backup',
  ah(async (_req, res) => {
    const info = await createBackup();
    ok(res, info, 201);
  }),
);

opsRouter.get(
  '/backup/list',
  ah(async (_req, res) => {
    ok(res, { items: listBackups() });
  }),
);

opsRouter.post(
  '/backup/restore',
  ah(async (req, res) => {
    requireOwner(req);
    const input = z.object({ name: z.string().min(1), confirm: z.boolean() }).parse(req.body);
    const result = await restoreBackup(input.name, input.confirm);
    ok(res, { ...result, note: '还原前已自动备份当前状态，可回滚到该安全备份。' });
  }),
);

opsRouter.get(
  '/export/inspirations.json',
  ah(async (req, res) => {
    requireOwner(req);
    const ctx = ctxOf(req);
    const data = exportAll(ctx.libraryId);
    res.setHeader('content-disposition', 'attachment; filename="inspirations-export.json"');
    res.setHeader('content-type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  }),
);

/**
 * 离线补录：client_op_id 唯一约束保证幂等。
 * 重复提交返回 200 与原结果（OFFLINE_OP_DUPLICATE 属于幂等成功，不是错误）。
 */
opsRouter.post(
  '/offline/apply',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = offlineOpSchema.parse(req.body);
    const db = getDb();

    const existing = db
      .prepare('SELECT * FROM offline_op WHERE client_op_id = ?')
      .get(input.clientOpId) as Record<string, unknown> | undefined;
    if (existing) {
      return ok(res, {
        duplicate: true,
        code: 'OFFLINE_OP_DUPLICATE',
        result: existing.result ? JSON.parse(existing.result as string) : null,
      });
    }

    let result: Record<string, unknown> = {};
    if (input.opType === 'create_inspiration') {
      const payload = z.object({ title: z.string().min(1).max(200), note: z.string().max(5000).nullable().optional() }).parse(
        input.payload,
      );
      const id = createInspiration({
        libraryId: ctx.libraryId,
        title: payload.title,
        note: payload.note ?? null,
      });
      result = { inspirationId: id };
    } else if (input.opType === 'tag') {
      const payload = z
        .object({ inspirationId: z.string().min(1), addTagIds: z.array(z.string()).default([]) })
        .parse(input.payload);
      requireInspiration(payload.inspirationId, ctx.libraryId);
      const added = addTags(payload.inspirationId, payload.addTagIds, 'bulk');
      result = { inspirationId: payload.inspirationId, added };
    } else if (input.opType === 'fill_result') {
      const payload = z
        .object({
          planId: z.string().min(1),
          hitLevel: z.enum(['hit', 'partial', 'miss']),
          missReasons: z.array(z.string()).default([]),
        })
        .parse(input.payload);
      const plan = db
        .prepare('SELECT * FROM shoot_plan WHERE id = ? AND library_id = ?')
        .get(payload.planId, ctx.libraryId) as Record<string, unknown> | undefined;
      if (!plan) throw errors.notFound('计划');
      const exists = db.prepare('SELECT id FROM shoot_result WHERE plan_id = ?').get(payload.planId);
      if (!exists) {
        db.prepare(
          `INSERT INTO shoot_result (id, library_id, plan_id, inspiration_id, hit_level, miss_reasons, filled_at, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          newId(),
          ctx.libraryId,
          payload.planId,
          plan.inspiration_id as string,
          payload.hitLevel,
          toJson(payload.missReasons),
          nowIso(),
          nowIso(),
        );
        db.prepare("UPDATE shoot_plan SET status = 'done', updated_at = ? WHERE id = ?").run(nowIso(), payload.planId);
        recomputeHitRate(plan.inspiration_id as string);
      }
      result = { planId: payload.planId, applied: true };
    } else {
      const payload = z.object({ inspirationId: z.string().min(1), note: z.string().max(5000) }).parse(input.payload);
      requireInspiration(payload.inspirationId, ctx.libraryId);
      db.prepare('UPDATE inspiration SET note = ?, updated_at = ? WHERE id = ?').run(
        payload.note,
        nowIso(),
        payload.inspirationId,
      );
      result = { inspirationId: payload.inspirationId, updated: true };
    }

    db.prepare(
      'INSERT INTO offline_op (id, library_id, client_op_id, op_type, payload, result, applied_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      newId(),
      ctx.libraryId,
      input.clientOpId,
      input.opType,
      toJson(input.payload),
      toJson(result),
      nowIso(),
      nowIso(),
    );

    ok(res, { duplicate: false, result }, 201);
  }),
);

/**
 * SSE 多端事件同步：素材处理 / 窗口变化 / 提醒更新。
 *
 * - 按资料库隔离：只回放/推送本 library_id 的事件；
 * - 断线补漏：优先用 Last-Event-ID（浏览器自动带上），其次 ?afterId / 已保存游标；
 * - 同一事件不得重复消费：每条事件带单调递增 id，replay 与 live 在同一序号边界上衔接，
 *   端上按 id 去重，确认消费后用 /events/ack 固化游标，乱序 ack 也不会回拨。
 *
 * EventSource 无法带鉴权头，故允许 ?token= 与 ?clientId=。
 */
/** 合法的端标识：白名单字符，避免它成为注入通道 */
const clientIdSchema = z.string().min(3).max(64).regex(/^[A-Za-z0-9._:-]+$/);

opsRouter.get('/events/stream', (req, res) => {
  const ctx = ctxOf(req);
  const query = req.query as Record<string, string | undefined>;

  let clientId: string | null = null;
  if (query.clientId) {
    const parsed = clientIdSchema.safeParse(query.clientId);
    if (parsed.success) clientId = parsed.data;
  }

  const headerLastId = req.header('last-event-id');
  const explicitAfter =
    query.afterId !== undefined && Number.isInteger(Number(query.afterId)) && Number(query.afterId) >= 0;
  const savedCursor = clientId ? (getCursor(ctx.libraryId, clientId) ?? 0) : 0;
  const headerId = headerLastId ? Number(headerLastId) : 0;
  // 显式 afterId（含 0 = 从头回放）、Last-Event-ID、已存游标任一存在 → 断线重连补漏；都没有才是新端只看实时。
  const reconnecting = explicitAfter || headerId > 0 || savedCursor > 0;
  // 从所有已知位置中最早的一个之后补漏，宁可短暂重复（端上按 id 去重），绝不漏事件。
  const positions = [
    explicitAfter ? Number(query.afterId) : null,
    headerId > 0 ? headerId : null,
    savedCursor > 0 ? savedCursor : null,
  ].filter((n): n is number => n !== null);
  const afterId = reconnecting && positions.length ? Math.min(...positions) : 0;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // 明确禁止任何代理缓冲事件流
    'x-accel-buffering': 'no',
  });
  // 先登记订阅再回放：回放期间到达的新事件不会丢；live 滤掉 id <= 回放边界的事件，
  // replay 与 live 按 id 无重叠——同一事件不会被投递两次。
  let replayBoundary = reconnecting ? afterId : latestEventId(ctx.libraryId);
  const unsubscribe = subscribe(ctx.libraryId, res, (id) => id <= replayBoundary);

  if (reconnecting) {
    const replay = eventsAfter(ctx.libraryId, afterId, MAX_REPLAY);
    if (replay.resync) {
      // 缺口已超出保留窗口，补不回来：要求端上丢弃本地状态全量重拉
      res.write(
        `event: resync\ndata: ${JSON.stringify({ reason: 'cursor_expired', latestId: replay.latestId })}\n\n`,
      );
      replayBoundary = replay.latestId;
    } else {
      for (const ev of replay.events) {
        res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
        replayBoundary = ev.id;
      }
    }
  }

  res.write(
    `event: hello\ndata: ${JSON.stringify({ libraryId: ctx.libraryId, lastEventId: replayBoundary, reconnecting })}\n\n`,
  );

  if (clientId) {
    // 新端把基线落在"连接前最新一条"，重连只补连接之后产生的事件；旧端保持既有游标不变
    touchCursor(ctx.libraryId, clientId, req.header('user-agent') ?? null, reconnecting ? 0 : replayBoundary);
  }

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

/**
 * 断线补漏（非 SSE 兜底，弱网/长轮询也能用）：取 afterId 之后的事件。
 * 游标过旧返回 resync=true，端上必须全量重拉，而不是半新半旧地合并。
 */
opsRouter.get(
  '/events',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const query = req.query as Record<string, string | undefined>;
    const afterId = Math.max(0, Number(query.afterId ?? 0));
    const limit = Math.min(MAX_REPLAY, Math.max(1, Number(query.limit ?? MAX_REPLAY)));
    const result = eventsAfter(ctx.libraryId, afterId, limit);
    ok(res, {
      items: result.events.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      lastEventId: result.events.length ? result.events[result.events.length - 1].id : result.latestId,
      latestId: result.latestId,
      resync: result.resync,
      hasMore: result.events.length >= limit,
    });
  }),
);

/**
 * 确认消费到某条事件：单调推进该端游标。
 * 持久化后即使再断线重连，已确认的事件也不会被再次补拉——同一事件不重复消费。
 */
opsRouter.post(
  '/events/ack',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = z
      .object({ clientId: clientIdSchema, lastEventId: z.number().int().nonnegative() })
      .parse(req.body);
    const cursor = advanceCursor(ctx.libraryId, input.clientId, input.lastEventId);
    ok(res, { clientId: input.clientId, cursor });
  }),
);
