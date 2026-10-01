import fs from 'node:fs';
import { ReminderActionKind, inQuietHours, localDateKey, type ReminderStatus } from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { config } from '../config.js';
import { errors } from '../http/errors.js';
import { logger } from '../logger.js';
import { emitEvent } from './events.js';

const DAY = 86400000;

export interface CreateReminderParams {
  libraryId: string;
  userId: string;
  subjectType: 'inspiration' | 'plan' | 'album' | 'weather_change' | 'share' | 'system';
  subjectId: string;
  ruleCode: string | null;
  occurrenceKey: string;
  title: string;
  body?: string | null;
  actionKind?: ReminderActionKind;
  actionPayload?: Record<string, unknown> | null;
  dueAt: Date;
  expireAt?: Date | null;
  status?: ReminderStatus;
}

/**
 * 幂等写入提醒：唯一键 (subject_type, subject_id, occurrence_key)。
 * 唯一键**不含 rule_code**——事件驱动型提醒 rule_code 为空，
 * 而 SQLite 唯一索引允许多个 NULL，含空列会拦不住重复（文档 8.5）。
 */
export function upsertReminder(params: CreateReminderParams): { id: string; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM reminder WHERE subject_type = ? AND subject_id = ? AND occurrence_key = ?')
    .get(params.subjectType, params.subjectId, params.occurrenceKey) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };

  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO reminder (id, library_id, user_id, subject_type, subject_id, rule_code, occurrence_key,
       title, body, action_kind, action_payload, status, due_at, expire_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    params.libraryId,
    params.userId,
    params.subjectType,
    params.subjectId,
    params.ruleCode,
    params.occurrenceKey,
    params.title,
    params.body ?? null,
    params.actionKind ?? 'none',
    params.actionPayload ? toJson(params.actionPayload) : null,
    params.status ?? 'pending',
    params.dueAt.toISOString(),
    params.expireAt ? params.expireAt.toISOString() : null,
    ts,
    ts,
  );
  emitEvent(
    {
      type: 'reminder_created',
      libraryId: params.libraryId,
      payload: { reminderId: id, ruleCode: params.ruleCode, title: params.title },
    },
    `reminder:${id}:created`,
  );
  return { id, created: true };
}

export function ownerUserId(libraryId: string): string | null {
  const row = getDb().prepare('SELECT owner_id FROM library WHERE id = ?').get(libraryId) as
    | { owner_id: string }
    | undefined;
  return row?.owner_id ?? null;
}

/** 规则求值（文档 12.7）：内置 R1–R9。每条提醒都带 expire_at，保证终态必达。 */
export function evaluateRules(
  libraryId: string,
  now = new Date(),
): { created: number; rules: Record<string, number> } {
  const db = getDb();
  const userId = ownerUserId(libraryId);
  if (!userId) return { created: 0, rules: {} };
  const library = db.prepare('SELECT tz FROM library WHERE id = ?').get(libraryId) as { tz: string } | undefined;
  const tz = library?.tz ?? config.tz;
  const nowStr = now.toISOString();
  const counts: Record<string, number> = {};
  let created = 0;
  const bump = (rule: string) => {
    counts[rule] = (counts[rule] ?? 0) + 1;
    created += 1;
  };

  // R1 条件待补：timing_missing 超过 7 天
  const r1 = db
    .prepare(
      `SELECT id, title FROM inspiration
       WHERE library_id = ? AND status = 'timing_missing' AND deleted_at IS NULL
         AND julianday(?) - julianday(updated_at) >= 7`,
    )
    .all(libraryId, nowStr) as { id: string; title: string }[];
  for (const row of r1) {
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'inspiration',
      subjectId: row.id,
      ruleCode: 'R1',
      occurrenceKey: `R1:${row.id}`,
      title: `「${row.title}」还没有拍摄条件`,
      body: '条件缺失的卡片无法计算可拍窗口。补上时间锚与天气画像，或直接放弃这张卡。',
      actionKind: ReminderActionKind.fillTiming,
      actionPayload: { inspirationId: row.id },
      dueAt: now,
      expireAt: new Date(now.getTime() + 14 * DAY),
    });
    if (res.created) bump('R1');
  }

  // R2 窗口临近：未来 36 小时内的 good 窗口
  const horizon = new Date(now.getTime() + 36 * 3600000).toISOString();
  const r2 = db
    .prepare(
      `SELECT w.id, w.inspiration_id, w.start_at, w.end_at, i.title
       FROM repro_window w JOIN inspiration i ON i.id = w.inspiration_id
       WHERE w.library_id = ? AND w.verdict = 'good' AND w.start_at <= ? AND w.end_at >= ?
         AND NOT EXISTS (SELECT 1 FROM shoot_plan p WHERE p.window_id = w.id AND p.status = 'planned')`,
    )
    .all(libraryId, horizon, nowStr) as {
    id: string;
    inspiration_id: string;
    start_at: string;
    end_at: string;
    title: string;
  }[];
  for (const row of r2) {
    const start = new Date(row.start_at);
    const dueAt = new Date(Math.max(now.getTime(), start.getTime() - 24 * 3600000));
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'inspiration',
      subjectId: row.inspiration_id,
      ruleCode: 'R2',
      occurrenceKey: `R2:${row.id}:${row.start_at}`,
      title: `「${row.title}」的可拍窗口快到了`,
      body: `窗口开始于 ${row.start_at}。可以一键接单成出行计划。`,
      actionKind: ReminderActionKind.openPlan,
      actionPayload: { inspirationId: row.inspiration_id, windowId: row.id },
      dueAt,
      expireAt: new Date(new Date(row.end_at).getTime() + 3 * 3600000),
    });
    if (res.created) bump('R2');
  }

  // R3 天气突变：已接单计划的判定下降
  const r3 = db
    .prepare(
      `SELECT p.id, p.inspiration_id, p.planned_at, p.window_verdict_at_plan, i.title, w.verdict
       FROM shoot_plan p
       JOIN inspiration i ON i.id = p.inspiration_id
       LEFT JOIN repro_window w ON w.id = p.window_id
       WHERE p.library_id = ? AND p.status = 'planned' AND p.planned_at >= ? AND p.planned_at <= ?`,
    )
    .all(libraryId, nowStr, new Date(now.getTime() + 6 * 3600000).toISOString()) as {
    id: string;
    inspiration_id: string;
    planned_at: string;
    window_verdict_at_plan: string | null;
    title: string;
    verdict: string | null;
  }[];
  for (const row of r3) {
    const current = row.verdict ?? 'bad';
    if (current === 'good') continue;
    if (row.window_verdict_at_plan === current) continue;
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'plan',
      subjectId: row.id,
      ruleCode: 'R3',
      occurrenceKey: `R3:${row.id}:${current}`,
      title: `天气变了：「${row.title}」的判定降为「${current}」`,
      body: '出发前请重新确认。可以坚持前往、改期或取消（取消需填原因）。',
      actionKind: ReminderActionKind.resolveWeatherChange,
      actionPayload: { planId: row.id, inspirationId: row.inspiration_id, verdict: current },
      dueAt: now,
      expireAt: new Date(new Date(row.planned_at).getTime() + DAY),
    });
    if (res.created) bump('R3');
  }

  // R4 计划待回填：3 天 / 7 天
  const r4 = db
    .prepare(
      `SELECT p.id, p.inspiration_id, p.planned_at, i.title
       FROM shoot_plan p JOIN inspiration i ON i.id = p.inspiration_id
       WHERE p.library_id = ? AND p.status = 'planned'
         AND NOT EXISTS (SELECT 1 FROM shoot_result r WHERE r.plan_id = p.id)
         AND p.planned_at < ?`,
    )
    .all(libraryId, new Date(now.getTime() - 3 * DAY).toISOString()) as {
    id: string;
    inspiration_id: string;
    planned_at: string;
    title: string;
  }[];
  for (const row of r4) {
    const days = Math.floor((now.getTime() - new Date(row.planned_at).getTime()) / DAY);
    const bucket = days >= 7 ? 'd7' : 'd3';
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'plan',
      subjectId: row.id,
      ruleCode: 'R4',
      occurrenceKey: `R4:${row.id}:${bucket}`,
      title: bucket === 'd7' ? `「${row.title}」仍未回填（已超 7 天）` : `「${row.title}」去拍了吗？`,
      body:
        bucket === 'd7'
          ? '这条计划将计入「未回填」。补一次回填，命中率统计才完整。'
          : '花 10 秒回填结果，系统才能越用越准。',
      actionKind: ReminderActionKind.fillResult,
      actionPayload: { planId: row.id, inspirationId: row.inspiration_id },
      dueAt: now,
      expireAt: new Date(now.getTime() + 14 * DAY),
    });
    if (res.created) bump('R4');
  }

  // R5 画册缺口：存在必需缺口且 14 天无进展
  const r5 = db
    .prepare(
      `SELECT a.id, a.title, a.updated_at FROM album a
       WHERE a.library_id = ? AND a.deleted_at IS NULL AND a.status = 'collecting'
         AND EXISTS (SELECT 1 FROM album_gap g WHERE g.album_id = a.id AND g.is_required = 1 AND g.status = 'open')`,
    )
    .all(libraryId) as { id: string; title: string; updated_at: string }[];
  for (const row of r5) {
    const days = Math.floor((now.getTime() - new Date(row.updated_at).getTime()) / DAY);
    if (days < 14) continue;
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'album',
      subjectId: row.id,
      ruleCode: 'R5',
      occurrenceKey: `R5:${row.id}:${Math.floor(days / 14)}`,
      title: `画册「${row.title}」还有必需缺口`,
      body: '补卡或放宽规则，缺口不闭合就无法发布。',
      actionKind: ReminderActionKind.fillAlbumGap,
      actionPayload: { albumId: row.id },
      dueAt: now,
      expireAt: new Date(now.getTime() + 14 * DAY),
    });
    if (res.created) bump('R5');
  }

  // R6 分享将过期
  const r6 = db
    .prepare(
      `SELECT id, expires_at FROM share_link
       WHERE library_id = ? AND revoked_at IS NULL AND expires_at >= ? AND expires_at <= ?`,
    )
    .all(libraryId, nowStr, new Date(now.getTime() + 3 * DAY).toISOString()) as {
    id: string;
    expires_at: string;
  }[];
  for (const row of r6) {
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'share',
      subjectId: row.id,
      ruleCode: 'R6',
      occurrenceKey: `R6:${row.id}`,
      title: '有一份分享链接即将过期',
      body: `过期时间 ${row.expires_at}。需要续期可重新创建链接。`,
      actionKind: ReminderActionKind.renewShare,
      actionPayload: { shareLinkId: row.id },
      dueAt: now,
      expireAt: new Date(row.expires_at),
    });
    if (res.created) bump('R6');
  }

  // R7 分享已过期清理：创建即为 expired（自动终态）
  const r7 = db
    .prepare('SELECT id FROM share_link WHERE library_id = ? AND revoked_at IS NULL AND expires_at < ?')
    .all(libraryId, new Date(now.getTime() - 7 * DAY).toISOString()) as { id: string }[];
  for (const row of r7) {
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'share',
      subjectId: row.id,
      ruleCode: 'R7',
      occurrenceKey: `R7:${row.id}`,
      title: '有一份分享链接已过期 7 天',
      body: '链路已自动失效，图片令牌同样不再可用。',
      actionKind: ReminderActionKind.none,
      dueAt: now,
      expireAt: new Date(now.getTime() + 30 * DAY),
      status: 'expired',
    });
    if (res.created) bump('R7');
  }

  // R8 健康检查（仅在异常时产生提醒）
  const healthIssues: string[] = [];
  for (const [name, dir] of Object.entries({
    uploads: config.uploadDir,
    thumbs: config.thumbDir,
    share: config.shareDir,
    backups: config.backupDir,
  })) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      healthIssues.push(`${name} 目录不可写`);
    }
  }
  if (healthIssues.length) {
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'system',
      subjectId: 'health',
      ruleCode: 'R8',
      occurrenceKey: `R8:${localDateKey(now, tz)}`,
      title: '系统健康检查发现问题',
      body: healthIssues.join('；'),
      actionKind: ReminderActionKind.none,
      dueAt: now,
      expireAt: new Date(now.getTime() + 3 * DAY),
    });
    if (res.created) bump('R8');
  }

  // R9 年度回顾（每年 1 月 1 日）
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  if (local.getMonth() === 0 && local.getDate() === 1) {
    const year = local.getFullYear() - 1;
    const res = upsertReminder({
      libraryId,
      userId,
      subjectType: 'system',
      subjectId: `year-${year}`,
      ruleCode: 'R9',
      occurrenceKey: `R9:${year}`,
      title: `${year} 年度取景回顾已就绪`,
      body: '看看去年收了多少卡、实拍多少次、命中率如何、最常用的光位是什么。',
      actionKind: ReminderActionKind.reviewYear,
      actionPayload: { year },
      dueAt: now,
      expireAt: new Date(now.getTime() + 60 * DAY),
    });
    if (res.created) bump('R9');
  }

  return { created, rules: counts };
}

/** 终态兜底：超期未处理的提醒自动 expired，绝不长期挂 pending（验收标准 S4） */
export function expireStaleReminders(libraryId: string, now = new Date()): number {
  const res = getDb()
    .prepare(
      `UPDATE reminder SET status = 'expired', updated_at = ?
       WHERE library_id = ? AND status IN ('pending','notified','snoozed')
         AND expire_at IS NOT NULL AND expire_at < ?`,
    )
    .run(nowIso(), libraryId, now.toISOString());
  return res.changes;
}

async function pushWebhook(libraryId: string, title: string, body: string | null): Promise<void> {
  const channels = getDb()
    .prepare("SELECT target FROM notification_channel WHERE library_id = ? AND kind = 'webhook' AND enabled = 1")
    .all(libraryId) as { target: string | null }[];
  for (const c of channels) {
    if (!c.target) continue;
    try {
      await fetch(c.target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
    } catch (err) {
      logger.warn('Webhook 推送失败', { error: String(err) });
    }
  }
}

/** 派发：pending → notified（安静时段内跳过），并推送 SSE 与 Webhook */
export async function dispatchReminders(
  libraryId: string,
  now = new Date(),
): Promise<{ notified: number; deferred: number; expired: number }> {
  const db = getDb();
  const expired = expireStaleReminders(libraryId, now);

  const library = db.prepare('SELECT tz FROM library WHERE id = ?').get(libraryId) as { tz: string } | undefined;
  const tz = library?.tz ?? config.tz;
  const quiet = inQuietHours(now, tz, config.reminderQuietHours);

  const due = db
    .prepare("SELECT * FROM reminder WHERE library_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at ASC")
    .all(libraryId, now.toISOString()) as Record<string, unknown>[];

  if (quiet) return { notified: 0, deferred: due.length, expired };

  let notified = 0;
  for (const row of due) {
    const res = db
      .prepare(
        "UPDATE reminder SET status = 'notified', notified_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(nowIso(), nowIso(), row.id as string);
    if (res.changes === 0) continue;
    notified += 1;
    emitEvent(
      {
        type: 'reminder_updated',
        libraryId,
        payload: { reminderId: row.id, status: 'notified', title: row.title },
      },
      // 同一条提醒的同一次状态迁移只通知一次，派发重试/多端在线也不会重复。
      `reminder:${row.id as string}:notified`,
    );
    await pushWebhook(libraryId, row.title as string, (row.body as string | null) ?? null);
  }

  return { notified, deferred: 0, expired };
}

export function markDone(reminderId: string, libraryId: string): void {
  const res = getDb()
    .prepare("UPDATE reminder SET status = 'done', updated_at = ? WHERE id = ? AND library_id = ?")
    .run(nowIso(), reminderId, libraryId);
  if (res.changes === 0) throw errors.notFound('提醒');
}

/** 顺延：不得晚于关联窗口结束时间（否则提示改为"记录未去"） */
export function snooze(reminderId: string, libraryId: string, until: Date): void {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM reminder WHERE id = ? AND library_id = ?')
    .get(reminderId, libraryId) as Record<string, unknown> | undefined;
  if (!row) throw errors.notFound('提醒');

  const payload = row.action_payload ? parseJson<Record<string, unknown>>(row.action_payload, {}) : {};
  const windowId = payload.windowId as string | undefined;
  if (windowId) {
    const w = db.prepare('SELECT end_at FROM repro_window WHERE id = ?').get(windowId) as
      | { end_at: string }
      | undefined;
    if (w && until.getTime() > new Date(w.end_at).getTime()) {
      throw errors.badRequest('该窗口已结束，无法顺延到窗口之后。可以改为记录为「未去」。');
    }
  }
  db.prepare(
    "UPDATE reminder SET status = 'snoozed', snooze_until = ?, due_at = ?, updated_at = ? WHERE id = ?",
  ).run(until.toISOString(), until.toISOString(), nowIso(), reminderId);
}

/** 忽略必须填原因（不允许静默消失） */
export function dismiss(reminderId: string, libraryId: string, reason: string): void {
  if (!reason || !reason.trim()) throw errors.badRequest('忽略提醒必须填写原因');
  const res = getDb()
    .prepare(
      "UPDATE reminder SET status = 'dismissed', dismiss_reason = ?, updated_at = ? WHERE id = ? AND library_id = ?",
    )
    .run(reason, nowIso(), reminderId, libraryId);
  if (res.changes === 0) throw errors.notFound('提醒');
}

export function listReminders(
  libraryId: string,
  filter: { status?: string; dueBefore?: string } = {},
): Record<string, unknown>[] {
  const where = ['library_id = ?'];
  const args: string[] = [libraryId];
  if (filter.status) {
    const statuses = filter.status.split(',').filter(Boolean);
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  if (filter.dueBefore) {
    where.push('due_at <= ?');
    args.push(filter.dueBefore);
  }
  return getDb()
    .prepare(`SELECT * FROM reminder WHERE ${where.join(' AND ')} ORDER BY due_at DESC LIMIT 200`)
    .all(...args) as Record<string, unknown>[];
}
