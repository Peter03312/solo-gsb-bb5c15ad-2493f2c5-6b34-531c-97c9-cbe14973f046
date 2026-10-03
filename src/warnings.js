'use strict';

/**
 * 展品年度用光分级预警（规则 21）
 *
 * 阈值由保管员按“展品 + 自然年”设置：低、高两档，均为“年度上限占比”百分数，
 * 0 < 低 < 高 <= 100。未登记年度上限的年份显示“无上限”且不触发。
 *
 * 口径要点：
 *  - 首次设置或修改阈值：以设置当时的统一口径占用重建基线（annual_warning_states），不补发事件；
 *  - 此后计划审批/取消/调整、上限变更、实测确认/纠错、停灯、事故、展厅共享照明入账时，
 *    在相应展品锁事务内调用 recomputeWarnings 重算：仅当占用“向上跨过”某档时各写一条
 *    annual_warning_events；回落后再次向上跨越可重触发；
 *  - 跨年独立：状态与事件均按 (exhibitId, year) 判定，互不影响；
 *  - 超过 100% 仍显示真实占用与最高级别（high）；
 *  - 全部写操作都在调用方已持有的展品锁事务内完成，多展品操作回滚时事件随之回滚；
 *  - 事件可由保管员标记已读，已读不改变预警级别。
 */

const { ValidationError } = require('./validation');
const { recordAudit } = require('./audit');
const { computeOccupancy } = require('./service');
const { round3 } = require('./dosing');

const LEVEL_RANK = { none: -1, normal: 0, low: 1, high: 2 };

/** 结果兼容：真实 pg 返回 {rows}，个别内存驱动（pg-mem）直接返回数组。 */
function rowsOf(result) {
  return Array.isArray(result) ? result : result.rows;
}

/** 写操作影响行数：真实 pg 为 result.rowCount，pg-mem 返回受影响行数组时取其长度。 */
function affectedCount(result) {
  if (result && typeof result.rowCount === 'number') return result.rowCount;
  if (Array.isArray(result)) return result.length;
  return 0;
}

/** 按“上限占比百分数”判定级别。无上限（limit 为 null）为 none。 */
function levelForUsed(used, limit, lowPct, highPct) {
  if (limit === null || limit === undefined) return 'none';
  if (lowPct === null || lowPct === undefined) return 'none';
  const ratio = (Number(used) / Number(limit)) * 100;
  if (ratio + 1e-9 >= Number(highPct)) return 'high';
  if (ratio + 1e-9 >= Number(lowPct)) return 'low';
  return 'normal';
}

/** 读取某展品全部预警阈值：{ year: { lowPct, highPct, updatedAt, ... } }。 */
async function getThresholds(client, exhibitId) {
  const rows = rowsOf(await client.query(
    `SELECT * FROM annual_warning_thresholds WHERE exhibit_id = $1 ORDER BY year`,
    [exhibitId]
  ));
  const out = {};
  for (const r of rows) {
    out[String(r.year)] = {
      year: Number(r.year),
      lowPct: Number(r.low_pct),
      highPct: Number(r.high_pct),
      createdBy: r.created_by != null ? Number(r.created_by) : null,
      updatedBy: r.updated_by != null ? Number(r.updated_by) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  return out;
}

/** 读取某展品全部预警基线状态：{ year: stateRow }。 */
async function getStates(client, exhibitId) {
  const rows = rowsOf(await client.query(
    `SELECT * FROM annual_warning_states WHERE exhibit_id = $1 ORDER BY year`,
    [exhibitId]
  ));
  const out = {};
  for (const r of rows) out[String(r.year)] = r;
  return out;
}

/**
 * 构造展品详情中的预警视图（仅附加字段，不改动既有 years/sources 等）：
 *   warnings: { years: { "<year>": { year, configured, level, label, used, limit, ratioPct,
 *                                    lowPct, highPct, baselineAt, updatedAt, unreadEventCount } },
 *               events: [最近事件（默认 20 条）], unreadCount, configuredCount }
 * 未设置阈值的年份不出现；阈值年份未登记上限时 level='none'、label='无上限'。
 */
async function loadWarningView(client, exhibitId, { recentLimit = 20 } = {}) {
  const [thresholds, states, occ] = await Promise.all([
    getThresholds(client, exhibitId),
    getStates(client, exhibitId),
    computeOccupancy(client, exhibitId),
  ]);
  const evRows = rowsOf(await client.query(
    `SELECT * FROM annual_warning_events
      WHERE exhibit_id = $1 ORDER BY id DESC LIMIT $2`,
    [exhibitId, recentLimit]
  ));
  // 未读数独立聚合（不随“最近 N 条”截断），保证年份未读数与总数准确
  const unreadAgg = rowsOf(await client.query(
    `SELECT year, COUNT(*)::int AS n FROM annual_warning_events
      WHERE exhibit_id = $1 AND read_at IS NULL GROUP BY year`,
    [exhibitId]
  ));
  const unreadByYear = {};
  let unreadCount = 0;
  for (const r of unreadAgg) {
    unreadByYear[String(r.year)] = Number(r.n);
    unreadCount += Number(r.n);
  }

  const years = {};
  for (const [yearStr, t] of Object.entries(thresholds)) {
    const info = occ.years[yearStr];
    const used = info ? info.used : 0;
    const limit = info ? info.limit : null;
    const currentLevel = levelForUsed(used, limit, t.lowPct, t.highPct);
    const state = states[yearStr] || null;
    years[yearStr] = {
      year: Number(yearStr),
      configured: true,
      level: currentLevel,
      label: currentLevel === 'none' ? '无上限' : LEVEL_LABEL[currentLevel],
      used: round3(used),
      limit: limit === null ? null : round3(limit),
      ratioPct: limit === null ? null : round3((used / limit) * 100),
      lowPct: t.lowPct,
      highPct: t.highPct,
      baselineAt: state ? state.baseline_at : null,
      stateUpdatedAt: state ? state.updated_at : null,
      unreadEventCount: unreadByYear[yearStr] || 0,
    };
  }

  return {
    years,
    events: evRows.map(serializeEvent),
    unreadCount,
    configuredCount: Object.keys(thresholds).length,
  };
}

const LEVEL_LABEL = { normal: '正常', low: '低档预警', high: '高档预警' };

function serializeEvent(r) {
  return {
    id: Number(r.id),
    exhibitId: Number(r.exhibit_id),
    year: Number(r.year),
    level: r.level,
    thresholdPct: Number(r.threshold_pct),
    used: Number(r.used_lxh),
    limit: Number(r.limit_lxh),
    ratioPct: Number(r.ratio_pct),
    triggerType: r.trigger_type,
    triggerRefId: r.trigger_ref_id != null ? Number(r.trigger_ref_id) : null,
    previousLevel: r.previous_level,
    read: !!r.read_at,
    readAt: r.read_at || null,
    readBy: r.read_by != null ? Number(r.read_by) : null,
    createdAt: r.created_at,
  };
}

/**
 * 在展品锁事务内按当前统一口径占用重算全部已配置阈值年份的预警状态。
 * 仅当级别“向上跨过”某档（normal->low/high、low->high）时插入事件：
 *   - 一次跳两级（normal -> high）时低、高各写一条，且都记录触发来源；
 *   - 回落不写事件；回落后再次向上跨越可再次触发（状态行记录的级别随之下降）；
 *   - 无上限（none）基线不补发事件；登记上限后从后续真实向上跨越开始记录；
 *   - 没有基线行（阈值从未设置，理论上不会出现：设置阈值时已建基线）时静默 upsert，不补发；
 *   - occupancy 可由调用方传入复用（避免重复计算）；否则内部按统一口径重算。
 * 返回本次新写入的事件（序列化对象数组）。
 */
async function recomputeWarnings(client, exhibitId, {
  occupancy = null,
  triggerType = 'unknown',
  triggerRefId = null,
  now = new Date(),
} = {}) {
  const thresholds = await getThresholds(client, exhibitId);
  if (Object.keys(thresholds).length === 0) return [];

  const occ = occupancy || (await computeOccupancy(client, exhibitId));
  const states = await getStates(client, exhibitId);
  const triggered = [];

  for (const [yearStr, t] of Object.entries(thresholds)) {
    const info = occ.years[yearStr];
    const used = info ? info.used : 0;
    const limit = info ? info.limit : null;
    const newLevel = levelForUsed(used, limit, t.lowPct, t.highPct);
    const prev = states[yearStr];
    const prevLevel = prev ? prev.level : null;

    // 向上跨档判定（none 表示无上限——该状态下不补发事件）：
    // 只在“有基线行、此前为可预警级别（normal/low/high）、且级别序上升”时，
    // 对每个被向上跨过的档（low/high）各写一条事件；一次跳两级（normal -> high）写两条。
    // 回落不写事件；回落后再次向上跨越，因 prevLevel 已随状态下降而可再次触发。
    if (prev && prevLevel !== 'none' && LEVEL_RANK[newLevel] > LEVEL_RANK[prevLevel]) {
      const ratioPct = round3((used / limit) * 100);
      for (const tier of ['low', 'high']) {
        const tierRank = LEVEL_RANK[tier];
        if (LEVEL_RANK[prevLevel] < tierRank && LEVEL_RANK[newLevel] >= tierRank) {
          const thresholdPct = tier === 'low' ? t.lowPct : t.highPct;
          const ins = await client.query(
            `INSERT INTO annual_warning_events
               (exhibit_id, year, level, threshold_pct, used_lxh, limit_lxh, ratio_pct,
                trigger_type, trigger_ref_id, previous_level, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [exhibitId, Number(yearStr), tier, thresholdPct, round3(used),
             round3(limit), ratioPct, triggerType, triggerRefId, prevLevel, now]
          );
          triggered.push(serializeEvent(rowsOf(ins)[0]));
        }
      }
    }

    // 更新（或缺失时补建）状态行；无上限时 used/limit/ratio 如实记录，级别 none。
    const ratioPct = limit === null ? null : round3((used / limit) * 100);
    await client.query(
      `INSERT INTO annual_warning_states
         (exhibit_id, year, level, used_lxh, limit_lxh, ratio_pct, baseline, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)
       ON CONFLICT (exhibit_id, year) DO UPDATE
         SET level = EXCLUDED.level,
             used_lxh = EXCLUDED.used_lxh,
             limit_lxh = EXCLUDED.limit_lxh,
             ratio_pct = EXCLUDED.ratio_pct,
             updated_at = EXCLUDED.updated_at`,
      [exhibitId, Number(yearStr), newLevel,
       limit === null ? null : round3(used), limit === null ? null : round3(limit),
       ratioPct, now]
    );
  }

  return triggered;
}

/**
 * 首次设置或修改某展品某年的低/高阈值（保管员）：
 *  - 校验展品存在、年份合法、0 < lowPct < highPct <= 100；
 *  - 在展品锁事务内 upsert 阈值，并以“当时统一口径占用”重建基线状态，不补发任何事件；
 *  - 写审计 warning_threshold.set。
 * 必须在调用方已取得展品锁的事务内调用。
 */
async function setWarningThreshold(client, exhibitId, year, lowPct, highPct, actor) {
  const existRows = rowsOf(await client.query('SELECT id FROM exhibits WHERE id = $1', [exhibitId]));
  if (existRows.length === 0) throw new ValidationError('展品不存在');

  const low = parseThresholdPct(lowPct, '低档阈值');
  const high = parseThresholdPct(highPct, '高档阈值');
  if (!(low < high)) {
    throw new ValidationError(`低档阈值（${low}%）必须小于高档阈值（${high}%）`);
  }

  const previous = rowsOf(await client.query(
    'SELECT low_pct, high_pct FROM annual_warning_thresholds WHERE exhibit_id = $1 AND year = $2',
    [exhibitId, year]
  ))[0] || null;

  const now = new Date();
  if (previous) {
    await client.query(
      `UPDATE annual_warning_thresholds
          SET low_pct = $3, high_pct = $4, updated_by = $5, updated_at = $6
        WHERE exhibit_id = $1 AND year = $2`,
      [exhibitId, year, low, high, actor.userId, now]
    );
  } else {
    await client.query(
      `INSERT INTO annual_warning_thresholds
         (exhibit_id, year, low_pct, high_pct, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $6)`,
      [exhibitId, year, low, high, actor.userId, now]
    );
  }

  // 以当时占用重建基线：不补发事件。直接把状态行重置为当前级别（baseline=TRUE）。
  const occ = await computeOccupancy(client, exhibitId);
  const info = occ.years[String(year)];
  const used = info ? info.used : 0;
  const limit = info ? info.limit : null;
  const level = levelForUsed(used, limit, low, high);
  const ratioPct = limit === null ? null : round3((used / limit) * 100);
  await client.query(
    `INSERT INTO annual_warning_states
       (exhibit_id, year, level, used_lxh, limit_lxh, ratio_pct, baseline, baseline_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $7)
     ON CONFLICT (exhibit_id, year) DO UPDATE
       SET level = EXCLUDED.level,
           used_lxh = EXCLUDED.used_lxh,
           limit_lxh = EXCLUDED.limit_lxh,
           ratio_pct = EXCLUDED.ratio_pct,
           baseline = TRUE,
           baseline_at = EXCLUDED.baseline_at,
           updated_at = EXCLUDED.updated_at`,
    [exhibitId, year, level,
     limit === null ? null : round3(used), limit === null ? null : round3(limit),
     ratioPct, now]
  );

  await recordAudit(client, actor, 'warning_threshold.set', 'exhibit', exhibitId, {
    year,
    lowPct: low,
    highPct: high,
    previous: previous
      ? { lowPct: Number(previous.low_pct), highPct: Number(previous.high_pct) }
      : null,
    baseline: { level, used: round3(used), limit: limit === null ? null : round3(limit), ratioPct },
  });

  const thresholds = await getThresholds(client, exhibitId);
  return { threshold: thresholds[String(year)], baselineLevel: level };
}

/** 阈值百分数校验：数字、(0,100]，保留两位小数。 */
function parseThresholdPct(value, field) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) {
    throw new ValidationError(`${field}必须是数字（年度上限占比百分数）`);
  }
  if (!(n > 0) || n > 100) {
    throw new ValidationError(`${field}必须满足 0 < 阈值 ≤ 100（百分比）`);
  }
  return Math.round(n * 100) / 100;
}

/**
 * 查询预警事件历史（登录可读）。
 * 过滤：exhibitId / year / level(low|high) / unread=true / triggerType；limit 默认 200、上限 1000。
 * 返回 { events, total, unreadCount, unreadCountByExhibit(仅未加 exhibitId 过滤时返回全部展品) }。
 */
async function listWarningEvents(client, {
  exhibitId = null,
  year = null,
  level = null,
  unreadOnly = false,
  triggerType = null,
  limit = 200,
} = {}) {
  const conds = [];
  const params = [];
  const push = (sql, v) => {
    params.push(v);
    conds.push(sql.replace('$N', `$${params.length}`));
  };
  if (exhibitId !== null) push('exhibit_id = $N', exhibitId);
  if (year !== null) push('year = $N', year);
  if (level !== null) {
    if (!['low', 'high'].includes(level)) {
      throw new ValidationError('级别只能是 low 或 high');
    }
    push('level = $N', level);
  }
  if (unreadOnly) conds.push('read_at IS NULL');
  if (triggerType) push('trigger_type = $N', String(triggerType));
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  const rows = rowsOf(await client.query(
    `SELECT * FROM annual_warning_events ${where} ORDER BY id DESC LIMIT ${lim}`,
    params
  ));

  // 未读总数（沿用同样过滤，但不受 read 过滤影响之外：未读数统计始终限定“未读”）
  const unreadParams = params.slice();
  const unreadConds = conds.filter((c) => c !== 'read_at IS NULL');
  unreadConds.push('read_at IS NULL');
  const unreadWhere = `WHERE ${unreadConds.join(' AND ')}`;
  const totalRows = rowsOf(await client.query(
    `SELECT COUNT(*)::int AS n FROM annual_warning_events ${unreadWhere}`,
    unreadParams
  ));

  // 展品名称（拆简单查询，规避内存驱动 JOIN 缺陷）
  const ids = [...new Set(rows.map((r) => Number(r.exhibit_id)))];
  const nameById = new Map();
  if (ids.length > 0) {
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const exRows = rowsOf(await client.query(
      `SELECT id, name FROM exhibits WHERE id IN (${ph})`, ids
    ));
    for (const e of exRows) nameById.set(Number(e.id), e.name);
  }

  const events = rows.map((r) => ({
    ...serializeEvent(r),
    exhibitName: nameById.get(Number(r.exhibit_id)) || null,
  }));

  return {
    events,
    count: events.length,
    unreadCount: Number(totalRows[0] ? totalRows[0].n : 0),
  };
}

/**
 * 保管员把一条预警事件标记已读（不改变预警级别）。
 * 不存在返回 404 语义的 ValidationError；重复标记幂等。
 */
async function markWarningEventRead(client, eventId, actor) {
  let rows = rowsOf(await client.query(
    'SELECT * FROM annual_warning_events WHERE id = $1', [eventId]
  ));
  if (rows.length === 0) throw new ValidationError('预警事件不存在');
  if (!rows[0].read_at) {
    await client.query(
      'UPDATE annual_warning_events SET read_at = now(), read_by = $2 WHERE id = $1',
      [eventId, actor.userId]
    );
    rows = rowsOf(await client.query(
      'SELECT * FROM annual_warning_events WHERE id = $1', [eventId]
    ));
  }
  return serializeEvent(rows[0]);
}

/**
 * 保管员把某展品某年（或该展品全部年份、或全局）的未读预警事件批量标记已读。
 * 返回更新条数。
 */
async function markWarningEventsRead(client, actor, { exhibitId = null, year = null } = {}) {
  const conds = ['read_at IS NULL'];
  const params = [];
  if (exhibitId !== null) {
    params.push(exhibitId);
    conds.push(`exhibit_id = $${params.length}`);
  }
  if (year !== null) {
    params.push(year);
    conds.push(`year = $${params.length}`);
  }
  params.push(actor.userId);
  const upd = await client.query(
    `UPDATE annual_warning_events
        SET read_at = now(), read_by = $${params.length}
      WHERE ${conds.join(' AND ')}`,
    params
  );
  return affectedCount(upd);
}

module.exports = {
  LEVEL_LABEL,
  levelForUsed,
  getThresholds,
  getStates,
  loadWarningView,
  recomputeWarnings,
  setWarningThreshold,
  listWarningEvents,
  markWarningEventRead,
  markWarningEventsRead,
  serializeEvent,
};
