'use strict';

/**
 * 展品年度用光分级预警（规则 21）HTTP 接口（挂载于 /api）：
 *   GET  /api/warning-events                  登录用户：触发历史（可按展品/年/级别/未读过滤）
 *   POST /api/warning-events/:id/read         保管员：标记单条已读（不改变预警级别）
 *   POST /api/warning-events/read             保管员：批量标记已读（exhibitId 可空 = 全部）
 *   GET  /api/exhibits/:id/warnings           登录用户：某展品各年当前占用/级别/阈值 + 最近事件
 *   PUT  /api/exhibits/:id/warning-threshold  保管员：首次设置/修改低、高阈值（以当时占用重建基线）
 */

const express = require('express');
const { query, withTransaction, withExhibitTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { ValidationError } = require('../validation');
const { lockExhibit } = require('../service');
const {
  loadWarningView,
  setWarningThreshold,
  listWarningEvents,
  markWarningEventRead,
  markWarningEventsRead,
} = require('../warnings');

const router = express.Router();

router.use(requireAuth);

function parseYear(value, field = '年份') {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new ValidationError(`${field}必须是 1900-2999 之间的整数`);
  }
  return year;
}

// 预警触发历史（登录可读）。注意必须注册在 '/warning-events/:id/read' 等具体路径之外，
// '/warning-events/read' 为 POST，与 GET 不冲突；为避免 ':id' 匹配 'read'，POST 单独声明。
router.get('/warning-events', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId !== undefined && req.query.exhibitId !== ''
      ? Number(req.query.exhibitId) : null;
    if (exhibitId !== null && !Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }
    const year = req.query.year !== undefined && req.query.year !== ''
      ? parseYear(req.query.year) : null;
    const level = req.query.level || null;
    const triggerType = req.query.triggerType || null;
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const result = await listWarningEvents({ query }, {
      exhibitId, year, level, unreadOnly, triggerType,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 批量标记已读：{ exhibitId?, year? }（保管员；幂等）。必须注册在 '/:id/read' 之前，
// 否则 'read' 会被当作 :id。
router.post('/warning-events/read', requireRole('conservator'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const exhibitId = body.exhibitId !== undefined && body.exhibitId !== null
      ? Number(body.exhibitId) : null;
    if (exhibitId !== null && !Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }
    const year = body.year !== undefined && body.year !== null ? parseYear(body.year) : null;

    let updated;
    if (exhibitId !== null) {
      updated = await withExhibitTransaction(exhibitId, (client) =>
        markWarningEventsRead(client, req.sessionUser, { exhibitId, year }));
    } else {
      // 全局已读：仅改 read 标记，不改动级别状态
      updated = await withTransaction((client) =>
        markWarningEventsRead(client, req.sessionUser, { exhibitId: null, year }));
    }
    res.json({ updated });
  } catch (err) {
    next(err);
  }
});

// 单条标记已读（保管员；幂等；不改变预警级别）
router.post('/warning-events/:id/read', requireRole('conservator'), async (req, res, next) => {
  try {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      throw new ValidationError('预警事件 ID 无效');
    }
    const pre = await query('SELECT exhibit_id FROM annual_warning_events WHERE id = $1', [eventId]);
    const preRows = Array.isArray(pre) ? pre : pre.rows;
    if (preRows.length === 0) throw new ValidationError('预警事件不存在');
    const exhibitId = preRows[0].exhibit_id;
    const event = await withExhibitTransaction(exhibitId, (client) =>
      markWarningEventRead(client, eventId, req.sessionUser));
    res.json({ event });
  } catch (err) {
    next(err);
  }
});

// 某展品的预警视图：各年阈值/当前占用/级别 + 最近触发事件（登录可读）
router.get('/exhibits/:id/warnings', async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    if (!Number.isInteger(exhibitId)) throw new ValidationError('展品 ID 无效');
    const warnings = await loadWarningView({ query }, exhibitId);
    res.json({ exhibitId, warnings });
  } catch (err) {
    next(err);
  }
});

// 首次设置 / 修改低、高阈值（保管员）：以当时占用重建基线，不补发事件
router.put('/exhibits/:id/warning-threshold', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    if (!Number.isInteger(exhibitId)) throw new ValidationError('展品 ID 无效');
    const body = req.body || {};
    const year = parseYear(body.year);
    const lowPct = body.lowPct;
    const highPct = body.highPct;

    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const out = await setWarningThreshold(
        client, exhibitId, year, lowPct, highPct, req.sessionUser
      );
      const warnings = await loadWarningView(client, exhibitId);
      return { ...out, warnings };
    });
    res.json({
      exhibitId,
      year,
      threshold: result.threshold,
      baselineLevel: result.baselineLevel,
      warnings: result.warnings,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
