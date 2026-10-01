import { Router } from 'express';
import { z } from 'zod';
import { createPlanSchema, fillResultSchema, type PlanDto } from '@flil/shared';
import { getDb, newId, nowIso, toJson } from '../db.js';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import { requireInspiration, syncStatus, touch } from '../services/inspirations.js';
import {
  dispatchReminders,
  dismiss,
  evaluateRules,
  listReminders,
  markDone,
  recordRemindersDoneForPlanTx,
  snooze,
} from '../services/reminders.js';
import { fanoutPending } from '../services/events.js';
import { toPlanDto, toReminderDto } from '../services/serialization.js';
import { applyCalibration, recomputeHitRate, undoCalibration } from '../services/calibration.js';

export const workflowRouter = Router();
workflowRouter.use(authenticate());

// ------------------------------------------------------------- reminders

workflowRouter.get(
  '/reminders',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const rows = listReminders(ctx.libraryId, {
      status: req.query.status as string | undefined,
      dueBefore: req.query.dueBefore as string | undefined,
    });
    ok(res, { items: rows.map(toReminderDto) });
  }),
);

workflowRouter.post(
  '/reminders/:id/done',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    markDone(req.params.id, ctx.libraryId);
    ok(res, { status: 'done' });
  }),
);

workflowRouter.post(
  '/reminders/:id/snooze',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const { until } = z.object({ until: z.string().datetime() }).parse(req.body);
    snooze(req.params.id, ctx.libraryId, new Date(until));
    ok(res, { status: 'snoozed', until });
  }),
);

workflowRouter.post(
  '/reminders/:id/dismiss',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const { reason } = z.object({ reason: z.string().min(1).max(300) }).parse(req.body);
    dismiss(req.params.id, ctx.libraryId, reason);
    ok(res, { status: 'dismissed' });
  }),
);

/** 手动触发扫描：先求值规则，再派发（也是研发与运维的调试入口） */
workflowRouter.post(
  '/reminders/scan',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const evaluated = evaluateRules(ctx.libraryId);
    const dispatched = await dispatchReminders(ctx.libraryId);
    ok(res, { ...evaluated, ...dispatched });
  }),
);

// ----------------------------------------------------------------- plans

workflowRouter.get(
  '/plans',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const where = ['p.library_id = ?'];
    const args: string[] = [ctx.libraryId];
    if (req.query.status) {
      const list = String(req.query.status).split(',').filter(Boolean);
      where.push(`p.status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (req.query.filter === 'pending_result') {
      where.push("p.status = 'planned' AND NOT EXISTS (SELECT 1 FROM shoot_result r WHERE r.plan_id = p.id)");
    }
    const rows = getDb()
      .prepare(
        `SELECT p.*, i.title AS inspiration_title FROM shoot_plan p
         JOIN inspiration i ON i.id = p.inspiration_id
         WHERE ${where.join(' AND ')} ORDER BY p.planned_at DESC LIMIT 200`,
      )
      .all(...args) as Record<string, unknown>[];
    ok(res, { items: rows.map(toPlanDto) });
  }),
);

/** 接单：把一条 good 窗口变成出行计划（出发时间 = 窗口开始 − 通勤分钟） */
workflowRouter.post(
  '/plans',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = createPlanSchema.parse(req.body);
    const db = getDb();
    const win = db
      .prepare('SELECT * FROM repro_window WHERE id = ? AND library_id = ?')
      .get(input.windowId, ctx.libraryId) as
      | { id: string; inspiration_id: string; start_at: string; verdict: string }
      | undefined;
    if (!win) throw errors.notFound('窗口');
    const inspiration = requireInspiration(win.inspiration_id, ctx.libraryId);

    const start = new Date(win.start_at);
    const leaveAt = new Date(start.getTime() - input.commuteMin * 60000);
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO shoot_plan (id, library_id, inspiration_id, window_id, planned_at, leave_at, commute_min,
         companions, gear_note, window_verdict_at_plan, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'planned', ?, ?)`,
    ).run(
      id,
      ctx.libraryId,
      inspiration.id,
      win.id,
      win.start_at,
      leaveAt.toISOString(),
      input.commuteMin,
      input.companions ?? null,
      input.gearNote ?? null,
      win.verdict,
      ts,
      ts,
    );
    // 关掉对应的 R2 提醒（已经接单了）
    db.prepare(
      "UPDATE reminder SET status = 'done', updated_at = ? WHERE subject_id = ? AND rule_code = 'R2' AND status IN ('pending','notified')",
    ).run(ts, inspiration.id);
    syncStatus(inspiration.id);
    ok(res, { id, plannedAt: win.start_at, leaveAt: leaveAt.toISOString() }, 201);
  }),
);

workflowRouter.patch(
  '/plans/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = z
      .object({
        commuteMin: z.number().int().min(0).max(600).optional(),
        companions: z.string().max(200).nullable().optional(),
        gearNote: z.string().max(1000).nullable().optional(),
        cancelReason: z.string().min(1).max(500).optional(),
        status: z.enum(['planned', 'cancelled']).optional(),
      })
      .parse(req.body);
    const db = getDb();
    const plan = db.prepare('SELECT * FROM shoot_plan WHERE id = ? AND library_id = ?').get(req.params.id, ctx.libraryId) as
      | Record<string, unknown>
      | undefined;
    if (!plan) throw errors.notFound('计划');

    if (input.commuteMin !== undefined) {
      const leaveAt = new Date(new Date(plan.planned_at as string).getTime() - input.commuteMin * 60000);
      db.prepare('UPDATE shoot_plan SET commute_min = ?, leave_at = ?, updated_at = ? WHERE id = ?').run(
        input.commuteMin,
        leaveAt.toISOString(),
        nowIso(),
        req.params.id,
      );
    }
    if (input.companions !== undefined) {
      db.prepare('UPDATE shoot_plan SET companions = ?, updated_at = ? WHERE id = ?').run(
        input.companions,
        nowIso(),
        req.params.id,
      );
    }
    if (input.gearNote !== undefined) {
      db.prepare('UPDATE shoot_plan SET gear_note = ?, updated_at = ? WHERE id = ?').run(
        input.gearNote,
        nowIso(),
        req.params.id,
      );
    }
    if (input.status === 'cancelled') {
      if (!input.cancelReason) throw errors.badRequest('取消计划必须填写原因');
      db.prepare("UPDATE shoot_plan SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(
        input.cancelReason,
        nowIso(),
        req.params.id,
      );
    }
    syncStatus(plan.inspiration_id as string);
    ok(res, { updated: true });
  }),
);

/**
 * 实拍回填 —— 闭环的最后一厘米（文档 6.3）。
 * 写入后立即触发校准：命中率更新 + 收紧判断 + 给出建议（绝不自动改状态）。
 */
workflowRouter.post(
  '/plans/:id/result',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = fillResultSchema.parse(req.body);
    const db = getDb();
    const plan = db.prepare('SELECT * FROM shoot_plan WHERE id = ? AND library_id = ?').get(req.params.id, ctx.libraryId) as
      | Record<string, unknown>
      | undefined;
    if (!plan) throw errors.notFound('计划');
    const existing = db.prepare('SELECT id FROM shoot_result WHERE plan_id = ?').get(req.params.id);
    if (existing) throw errors.resultAlreadyFilled();

    if (input.hitLevel !== 'hit' && input.missReasons.length === 0) {
      throw errors.badRequest('未完全命中时至少要选择一个偏差原因');
    }

    const id = newId();
    const ts = nowIso();
    let pendingEvents: ReturnType<typeof recordRemindersDoneForPlanTx> = [];
    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO shoot_result (id, library_id, plan_id, inspiration_id, hit_level, miss_reasons,
           actual_shot_at, actual_weather, note, filled_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        ctx.libraryId,
        req.params.id,
        plan.inspiration_id as string,
        input.hitLevel,
        toJson(input.missReasons),
        input.actualShotAt ?? null,
        input.actualWeather ? toJson(input.actualWeather) : null,
        input.note ?? null,
        ts,
        ts,
      );
      db.prepare("UPDATE shoot_plan SET status = 'done', updated_at = ? WHERE id = ?").run(ts, req.params.id);
      pendingEvents = recordRemindersDoneForPlanTx(req.params.id, ctx.libraryId);
    });
    run();
    fanoutPending(pendingEvents);

    const calibration = applyCalibration(ctx.libraryId, plan.inspiration_id as string, id);
    syncStatus(plan.inspiration_id as string);
    ok(res, { resultId: id, ...calibration }, 201);
  }),
);

workflowRouter.post(
  '/results/:id/amend',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = fillResultSchema.parse(req.body);
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM shoot_result WHERE id = ? AND library_id = ?')
      .get(req.params.id, ctx.libraryId) as Record<string, unknown> | undefined;
    if (!row) throw errors.notFound('回填记录');
    db.prepare(
      'UPDATE shoot_result SET hit_level = ?, miss_reasons = ?, note = ?, actual_shot_at = ? WHERE id = ?',
    ).run(
      input.hitLevel,
      toJson(input.missReasons),
      input.note ?? null,
      input.actualShotAt ?? null,
      req.params.id,
    );
    const stats = recomputeHitRate(row.inspiration_id as string);
    ok(res, stats);
  }),
);

workflowRouter.post(
  '/inspirations/:id/calibration/:calibrationId/undo',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    requireInspiration(req.params.id, ctx.libraryId);
    undoCalibration(req.params.calibrationId, ctx.libraryId, req.params.id);
    ok(res, { undone: true });
  }),
);

workflowRouter.get(
  '/plans/:id',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const row = getDb()
      .prepare(
        `SELECT p.*, i.title AS inspiration_title FROM shoot_plan p JOIN inspiration i ON i.id = p.inspiration_id
         WHERE p.id = ? AND p.library_id = ?`,
      )
      .get(req.params.id, ctx.libraryId) as Record<string, unknown> | undefined;
    if (!row) throw errors.notFound('计划');
    ok(res, { item: toPlanDto(row) as PlanDto });
  }),
);

export { touch };
