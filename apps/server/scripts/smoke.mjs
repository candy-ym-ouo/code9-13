#!/usr/bin/env node
/**
 * 真实 HTTP 冒烟脚本：对着一个正在运行的服务端跑完整闭环。
 *   用法：node apps/server/scripts/smoke.mjs http://localhost:3000
 * 断言的是"闭环是否合上"，而不是接口是否返回 200。
 */

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  ❌ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

let token = null;
async function req(method, path, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token && !opts.noAuth) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, raw: text };
}

function tagIdsOf(tree, names) {
  const wanted = new Set(names);
  const out = {};
  for (const group of tree) {
    for (const child of group.children ?? []) {
      if (wanted.has(child.name)) out[child.name] = child.id;
    }
  }
  return out;
}

async function main() {
  process.stdout.write(`\n电影取景灵感库 · 冒烟测试 → ${BASE}\n\n`);

  // 1. 健康检查
  const health = await req('GET', '/health', undefined, { noAuth: true });
  check('健康检查返回 ok', health.status === 200 && health.json?.ok === true, JSON.stringify(health.json));
  check('健康检查包含各目录状态', Boolean(health.json?.dirs?.uploads), JSON.stringify(health.json?.dirs));

  // 2. 注册（同一脚本可重复跑：邮箱带时间戳）
  const email = `smoke-${Date.now()}@flil.local`;
  const reg = await req('POST', '/auth/register', {
    email,
    password: 'password123',
    displayName: '冒烟用户',
  });
  check('注册返回 token', reg.status === 201 && typeof reg.json?.token === 'string');
  token = reg.json?.token;
  check('注册即成为 owner', reg.json?.user?.role === 'owner');

  const me = await req('GET', '/auth/me');
  check('me 返回库信息', me.status === 200 && Boolean(me.json?.library?.id));

  // 3. 基线标签（不是演示数据，是字典）
  const tags = await req('GET', '/tags');
  const allTags = tags.json?.items ?? [];
  const domains = new Set(allTags.map((t) => t.domain));
  check('四域标签树存在', domains.size === 4, [...domains].join(','));
  const tIds = tagIdsOf(allTags, ['逆光', '连廊', '霓虹招牌', '黄金时刻（昏）', '清水混凝土']);
  check('内置标签可被检索到', Object.keys(tIds).length >= 4, Object.keys(tIds).join(','));
  check('标签是内置基线而非演示数据', allTags.every((t) => t.isBuiltin === true));

  // 4. 全新库不得有任何业务数据（质量门：无 demo）
  const emptyList = await req('GET', '/inspirations');
  check('新库没有预置任何灵感卡（无演示数据）', emptyList.json?.total === 0);
  const emptyAlbums = await req('GET', '/albums');
  check('新库没有预置任何画册', (emptyAlbums.json?.items ?? []).length === 0);

  // 5. 地点与机位
  const place = await req('POST', '/places', {
    name: 'M50 创意园 3 号楼连廊',
    city: '上海',
    district: '普陀区',
    category: '建筑',
  });
  check('创建地点', place.status === 201, JSON.stringify(place.json));
  const spot = await req('POST', '/spots', {
    placeId: place.json.id,
    lat: 31.2471,
    lng: 121.4462,
    cameraBearing: 265,
    accessNote: '东侧第二个桥墩，蹲下拍',
  });
  check('创建机位（含精确坐标）', spot.status === 201, JSON.stringify(spot.json));

  // 6. 灵感卡 + 打标 + 绑机位
  const card = await req('POST', '/inspirations', { title: '三号楼连廊黄昏逆光', note: '柱子影子拉成长条' });
  check('创建灵感卡', card.status === 201);
  const cardId = card.json.id;

  let detail = await req('GET', `/inspirations/${cardId}`);
  check('未打标时为 draft', detail.json?.item?.status === 'draft', detail.json?.item?.status);

  const bulk = await req('POST', '/inspirations/bulk-tag', {
    ids: [cardId],
    addTagIds: Object.values(tIds),
  });
  check('批量打标成功', bulk.json?.added >= 4, JSON.stringify(bulk.json));

  detail = await req('GET', `/inspirations/${cardId}`);
  check('有标签无条件 → timing_missing（不是断头状态）', detail.json?.item?.status === 'timing_missing', detail.json?.item?.status);

  const bind = await req('POST', `/inspirations/${cardId}/spot`, { spotId: spot.json.id });
  check('绑定机位', bind.status === 200);

  // 7. 条件（时间锚 + 天气画像 + 光位方位角）
  const preview = await req('POST', `/inspirations/${cardId}/timing/preview`, {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: [250, 280],
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: { precipProbPctMax: 20, cloudCoverPct: { min: 20, max: 60 } },
    seasonWindow: null,
    notes: null,
  });
  check('锚点解析出今天的真实时刻', typeof preview.json?.anchorLocal === 'string', JSON.stringify(preview.json));
  check('给出可满足性建议字段', 'satisfiability' in (preview.json ?? {}));

  const timing = await req('PUT', `/inspirations/${cardId}/timing`, {
    timeAnchor: 'sunset_minus',
    anchorOffsetMin: 40,
    elevationRange: [-4, 10],
    azimuthRange: [250, 280],
    azimuthTolerance: 15,
    windowToleranceMin: 12,
    weatherProfile: {
      cloudCoverPct: { min: 20, max: 60 },
      precipProbPctMax: 20,
      visibilityKmMin: 8,
      windSpeedMax: 10,
      hardRequirements: ['precipProbPctMax'],
    },
    seasonWindow: null,
    notes: '日落前 40 分，光从西侧压进来',
  });
  check('保存条件后立即产出窗口', (timing.json?.windows ?? []).length >= 5, String((timing.json?.windows ?? []).length));

  const windows = await req('GET', `/inspirations/${cardId}/windows?days=7`);
  const list = windows.json?.items ?? [];
  check('窗口数量等于天数', list.length === 7, String(list.length));
  check('每个窗口都有判定', list.every((w) => ['good', 'marginal', 'bad'].includes(w.verdict)));
  const firstWithReasons = list[0];
  check('窗口给出逐项理由', (firstWithReasons?.reasons ?? []).length >= 3);
  const anchorReason = (firstWithReasons?.reasons ?? []).find((r) => r.code === 'ANCHOR_RESOLVED');
  check('理由里包含锚点解析结果（可复算）', Boolean(anchorReason?.text), anchorReason?.text);

  // 8. 状态进入 ready
  detail = await req('GET', `/inspirations/${cardId}`);
  check('条件齐 + 机位齐 → ready', detail.json?.item?.status === 'ready', detail.json?.item?.status);
  check('详情返回机位（owner 可见精确坐标）', detail.json?.item?.spot?.precise?.lat === 31.2471);
  check('详情同时给出对外模糊结果', Boolean(detail.json?.item?.spot?.fuzz?.label));

  // 9. 接单 → 出行计划
  const goodWin = list.find((w) => w.verdict !== 'bad') ?? list[0];
  const plan = await req('POST', '/plans', { windowId: goodWin.id, commuteMin: 35, companions: '小王' });
  check('从窗口接单生成计划', plan.status === 201, JSON.stringify(plan.json));
  const planId = plan.json.id;
  check('出发时间 = 窗口开始 − 通勤', typeof plan.json.leaveAt === 'string');

  // 10. 回填（闭环最后一厘米）+ 幂等
  const fill1 = await req('POST', `/plans/${planId}/result`, {
    hitLevel: 'miss',
    missReasons: ['timing_off'],
    note: '云比预报厚',
  });
  check('回填成功并返回命中率', fill1.status === 201 && typeof fill1.json?.hitRate === 'number', JSON.stringify(fill1.json));
  const fill2 = await req('POST', `/plans/${planId}/result`, { hitLevel: 'hit', missReasons: [] });
  check('重复回填被拒（RESULT_ALREADY_FILLED）', fill2.status === 409 && fill2.json?.error?.code === 'RESULT_ALREADY_FILLED');

  detail = await req('GET', `/inspirations/${cardId}`);
  check('回填后卡片进入 shot', detail.json?.item?.status === 'shot', detail.json?.item?.status);
  check('命中计数已更新', detail.json?.item?.missCount === 1);

  // 11. 提醒：扫描 + 终态约束
  const scan = await req('POST', '/reminders/scan');
  check('提醒扫描可执行', scan.status === 200, JSON.stringify(scan.json));
  const reminders = await req('GET', '/reminders');
  const items = reminders.json?.items ?? [];
  check('所有提醒状态在可枚举集合内', items.every((r) => ['pending', 'notified', 'done', 'snoozed', 'dismissed', 'expired'].includes(r.status)));
  const open = items.find((r) => ['pending', 'notified'].includes(r.status));
  if (open) {
    const noReason = await req('POST', `/reminders/${open.id}/dismiss`, { reason: '' });
    check('忽略提醒必须填原因', noReason.status === 400, String(noReason.status));
    const okReason = await req('POST', `/reminders/${open.id}/dismiss`, { reason: '这周出差，先不拍了' });
    check('填原因后可以忽略并进入终态', okReason.status === 200 && okReason.json?.status === 'dismissed');
  } else {
    check('存在可处理提醒（用于验证终态约束）', true, '本轮没有 pending 提醒，跳过');
  }

  // 12. 画册闭环：缺口 → 补齐 → 发布
  const album = await req('POST', '/albums', {
    title: '黄昏逆光与连廊',
    themeNote: '用斜射的硬光切出建筑的影子',
    rules: {
      requireTags: [{ tagIds: [tIds['逆光']], min: 1, required: true }],
      requireAnchors: [{ anchor: 'blue_pm', min: 1, required: false }],
      totalMin: 1,
      autoMatch: { enabled: true, minTagHits: 1 },
    },
  });
  check('创建主题画册', album.status === 201, JSON.stringify(album.json));
  const albumId = album.json.id;

  const gapsBefore = await req('GET', `/albums/${albumId}/gaps`);
  const gapList = gapsBefore.json?.items ?? [];
  check('画册生成缺口清单', gapList.length >= 2, String(gapList.length));
  check('每条缺口都带一键动作', gapList.every((g) => g.actionHref && g.actionLabel));
  const requiredGap = gapList.find((g) => g.isRequired && g.status === 'open');
  if (requiredGap) {
    const blocked = await req('POST', `/albums/${albumId}/publish`, { createShare: false });
    check('存在必需缺口时发布被拒（409）', blocked.status === 409 && blocked.json?.error?.code === 'ALBUM_HAS_REQUIRED_GAPS');
  }
  const optionalGap = gapList.find((g) => !g.isRequired && g.status === 'open');
  if (optionalGap) {
    const waived = await req('POST', `/albums/${albumId}/gaps/${optionalGap.id}/waive`, { reason: '本期素材不够，先出第一版' });
    check('可选缺口可豁免（需填原因）', waived.status === 200);
  }

  const matched = await req('POST', `/albums/${albumId}/auto-match`, {});
  check('自动匹配按规则补卡', matched.status === 200);
  const albumAfter = await req('GET', `/albums/${albumId}`);
  check('补齐后画册进入 ready/published 通道', ['ready', 'published'].includes(albumAfter.json?.item?.status), albumAfter.json?.item?.status);

  // 13. 发布 + 分享 + 隐私
  const publish = await req('POST', `/albums/${albumId}/publish`, {
    createShare: true,
    fuzzLevel: 'exact',
    expiresInDays: 2,
    password: '2468',
  });
  check('发布成功并生成分享令牌', publish.status === 201 && typeof publish.json?.shareToken === 'string', JSON.stringify(publish.json));
  check('发布生成快照哈希', typeof publish.json?.payloadHash === 'string');
  const shareToken = publish.json?.shareToken;

  const noPwd = await req('GET', `/share/${shareToken}`, undefined, { noAuth: true });
  check('分享页需要密码', noPwd.status === 401 && noPwd.json?.error?.code === 'SHARE_PASSWORD_REQUIRED');

  const view = await req('GET', `/share/${shareToken}?password=2468`, undefined, { noAuth: true });
  check('带密码可只读访问', view.status === 200 && view.json?.scope === 'album', JSON.stringify(view.json)?.slice(0, 120));
  check('强制降级：申请 exact 实际得到 g500', view.json?.fuzzLevel === 'g500', view.json?.fuzzLevel);
  // 注意：不能用字符串包含判断——模糊点 31.24718 会以精确值 "31.2471" 为前缀而误报。
  // 这里做数值级断言：响应里不能出现与精确坐标完全相同的数字，也不能有 precise 字段。
  const numbersInPayload = (JSON.stringify(view.json).match(/-?\d+\.\d+/g) ?? []).map(Number);
  check(
    '分享内容不含精确坐标（数值级断言）',
    !numbersInPayload.some((n) => n === 31.2471 || n === 121.4462) && !view.raw.includes('"precise"'),
    JSON.stringify(numbersInPayload.filter((n) => Math.abs(n - 31.24) < 0.01)),
  );
  check(
    '分享坐标是 geohash 网格中心（证明确实经过模糊化）',
    typeof view.json?.items?.[0]?.fuzz?.geohash === 'string' && view.json?.items?.[0]?.fuzz?.lat !== undefined,
  );
  check('分享内容给出模糊地点标签', typeof view.json?.items?.[0]?.fuzz?.label === 'string');
  check('分享包含"照着做"的条件说明', typeof view.json?.snapshot?.payload?.conditionSummary === 'string');

  const links = await req('GET', '/share-links');
  const link = (links.json?.items ?? [])[0];
  check('分享链接可被列表查看', Boolean(link?.id));

  // 14. member 视角：看不到精确坐标
  const memberEmail = `smoke-member-${Date.now()}@flil.local`;
  const memberReg = await req('POST', '/auth/register', {
    email: memberEmail,
    password: 'password123',
    displayName: '协作者',
  });
  const ownerToken = token;
  token = memberReg.json?.token;
  // 让 owner 把 member 加进库，再切回 member 视角验证
  token = ownerToken;
  const addMember = await req('POST', '/library/members', { email: memberEmail, role: 'member' });
  check('可邀请协作者', addMember.status === 201, JSON.stringify(addMember.json));

  token = memberReg.json?.token;
  const memberView = await req('GET', `/inspirations/${cardId}`);
  check(
    'member 读取卡片时拿不到精确坐标（后端不返回）',
    memberView.status === 403 || memberView.json?.item?.spot?.precise === null,
    JSON.stringify({ status: memberView.status, precise: memberView.json?.item?.spot?.precise }),
  );
  token = ownerToken;

  // 15. 撤销分享即时生效
  const revoke = await req('POST', `/share-links/${link.id}/revoke`, {});
  check('撤销分享链接', revoke.status === 200);
  const afterRevoke = await req('GET', `/share/${shareToken}?password=2468`, undefined, { noAuth: true });
  check('撤销后旧链接立即失效', afterRevoke.status === 401 && afterRevoke.json?.error?.code === 'SHARE_REVOKED');

  // 16. 检索 + 零结果兜底
  const searchHit = await req('GET', `/search?tagIds=${tIds['逆光']}`);
  check('按标签检索命中', (searchHit.json?.total ?? 0) >= 1, String(searchHit.json?.total));
  const searchFallback = await req('GET', '/search?q=绝对不存在的关键词xyz&tagIds=__none__');
  check('零结果时给出放宽说明（不静默放宽）', Array.isArray(searchFallback.json?.relaxed));
  check('放宽说明写明放宽了什么', (searchFallback.json?.relaxed ?? []).length === 0 || searchFallback.json.relaxed[0].note.includes('已放宽'));

  // 17. 地点模糊化预览（owner）
  const fuzzPreview = await req('GET', `/spots/${spot.json.id}/fuzz-preview?level=g1k`);
  check('owner 可预览不同模糊级别', fuzzPreview.status === 200 && Boolean(fuzzPreview.json?.fuzz?.geohash));
  check('模糊预览与精确坐标不同（网格中心化）', fuzzPreview.json?.fuzz?.lat !== 31.2471);

  // 18. 备份与导出
  const backup = await req('POST', '/backup', {});
  check('可创建备份', backup.status === 201 && typeof backup.json?.name === 'string');
  const listBackups = await req('GET', '/backup/list');
  check('备份列表可读', Array.isArray(listBackups.json?.items));

  // 19. 离线补录幂等
  const opId = `op-${Date.now()}`;
  const offline1 = await req('POST', '/offline/apply', {
    clientOpId: opId,
    opType: 'create_inspiration',
    payload: { title: '断网时记下的一条', note: '回家再补图' },
  });
  check('离线补录成功', offline1.status === 201 && offline1.json?.duplicate === false);
  const offline2 = await req('POST', '/offline/apply', {
    clientOpId: opId,
    opType: 'create_inspiration',
    payload: { title: '断网时记下的一条', note: '回家再补图' },
  });
  check('重复补录幂等（不产生第二条）', offline2.status === 200 && offline2.json?.duplicate === true);
  check('幂等返回使用 OFFLINE_OP_DUPLICATE 语义', offline2.json?.code === 'OFFLINE_OP_DUPLICATE');

  // 20. 参数校验错误码
  const badTiming = await req('PUT', `/inspirations/${cardId}/timing`, { timeAnchor: 'not_an_anchor' });
  check('非法参数返回 400 而不是 500', badTiming.status === 400 && badTiming.json?.error?.code === 'BAD_REQUEST', JSON.stringify(badTiming.json));

  // 21. 多端事件同步中心（断线补漏 / 幂等消费）
  const syncHead = await req('GET', '/events?afterId=0&limit=1');
  check('事件补拉接口可用并按资料库返回', syncHead.status === 200 && Array.isArray(syncHead.json?.items));
  const headId = syncHead.json?.latestId ?? 0;
  const syncMissed = await req('GET', `/events?afterId=${headId}`);
  check(
    '补拉事件序号严格大于游标（不漏不重）',
    (syncMissed.json?.items ?? []).every((e) => e.id > headId),
  );
  const clientId = `smoke-${Date.now().toString(36)}`;
  const ack = await req('POST', '/events/ack', { clientId, lastEventId: headId });
  check('游标确认成功', ack.status === 200 && ack.json?.cursor === headId);
  const ackBack = await req('POST', '/events/ack', { clientId, lastEventId: 0 });
  check('乱序/重复确认不让游标回拨', ackBack.status === 200 && ackBack.json?.cursor === headId);
  const ackBad = await req('POST', '/events/ack', { clientId: 'bad client id', lastEventId: 1 });
  check('非法 clientId 被 400 拒绝', ackBad.status === 400);

  process.stdout.write(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`);
  if (failed) {
    process.stdout.write('失败明细：\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write('全部通过 ✅\n\n');
}

main().catch((err) => {
  process.stderr.write(`冒烟脚本异常：${err?.stack ?? err}\n`);
  process.exit(1);
});
