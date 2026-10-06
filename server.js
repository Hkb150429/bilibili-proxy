const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 配置 ==========
const REFRESH_MIN = 12 * 60 * 1000;
const REFRESH_MAX = 18 * 60 * 1000;
const MAX_HISTORY_PER_BV = 200;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const VALID_METRICS = ['view', 'like', 'coin', 'favorite', 'reply', 'danmaku'];
const VALID_MODES = ['absolute', 'delta', 'percent'];
const TIMELINE_TOLERANCE = 120 * 1000;  // 手动查询的时间合并容差：2 分钟
const ROUND_BUDGET = 110000;            // 整轮刷新预算：110 秒
const MAX_COMPARE = 15;                 // 对比上限

// ========== 中间件 ==========
app.use(cors({ origin: '*', methods: ['GET', 'DELETE', 'OPTIONS'] }));
app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ========== 数据存储 ==========
const watched = new Map();

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      Object.entries(parsed).forEach(([bvid, record]) => {
        watched.set(bvid, record);
      });
      console.log(`📂 已加载 ${watched.size} 个 BV 号的历史记录`);
    }
  } catch (err) {
    console.error('加载历史文件失败:', err.message);
  }
}

function saveHistory() {
  try {
    const obj = Object.fromEntries(watched);
    const tmpFile = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmpFile, HISTORY_FILE);
  } catch (err) {
    console.error('保存历史文件失败:', err.message);
  }
}

// ========== 请求 B 站 ==========
const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

async function fetchFromBili(bvid) {
  const response = await axios.get(
    'https://api.bilibili.com/x/web-interface/view',
    {
      params: { bvid },
      headers: {
        ...BILI_HEADERS,
        'Referer': `https://www.bilibili.com/video/${bvid}`,
      },
      timeout: 10000,
    }
  );
  const { data } = response;
  if (data.code !== 0) {
    throw new Error(data.message || `B 站接口返回 code=${data.code}`);
  }
  return data.data;
}

async function fetchAndRecord(bvid, reason = 'manual', roundId = null) {
  const raw = await fetchFromBili(bvid);

  const snapshot = {
    bvid: raw.bvid,
    title: raw.title,
    pic: raw.pic,
    desc: raw.desc,
    duration: raw.duration,
    pubdate: raw.pubdate,
    owner: {
      mid: raw.owner?.mid,
      name: raw.owner?.name,
      face: raw.owner?.face,
    },
    stat: {
      view: raw.stat?.view ?? 0,
      danmaku: raw.stat?.danmaku ?? 0,
      reply: raw.stat?.reply ?? 0,
      favorite: raw.stat?.favorite ?? 0,
      coin: raw.stat?.coin ?? 0,
      like: raw.stat?.like ?? 0,
      share: raw.stat?.share ?? 0,
    },
  };

  const entry = {
    fetchedAt: Date.now(),
    roundId: roundId,
    reason,
    data: snapshot,
  };

  let record = watched.get(bvid);
  if (!record) {
    record = { bvid, lastFetch: 0, history: [] };
    watched.set(bvid, record);
  }
  record.lastFetch = entry.fetchedAt;
  record.history.push(entry);

  if (record.history.length > MAX_HISTORY_PER_BV) {
    record.history = record.history.slice(-MAX_HISTORY_PER_BV);
  }

  saveHistory();
  return entry;
}

// ========== 定时任务 ==========
let refreshTimer = null;

function nextDelay() {
  return REFRESH_MIN + Math.random() * (REFRESH_MAX - REFRESH_MIN);
}

async function refreshAll() {
  const bvids = Array.from(watched.keys());
  if (bvids.length === 0) {
    console.log('⏰ 定时刷新：暂无监控中的 BV 号');
    return;
  }
  console.log(`⏰ 定时刷新开始，共 ${bvids.length} 个 BV 号`);

  const roundId = Date.now();
  console.log(`   本轮 roundId: ${new Date(roundId).toISOString()}`);

  const maxGap = 15000;
  const minGap = 800;
  let gap = Math.floor(ROUND_BUDGET / bvids.length);
  gap = Math.max(minGap, Math.min(maxGap, gap));
  console.log(`   请求间隔约 ${gap}ms，整轮预计 ${(gap * bvids.length / 1000).toFixed(1)} 秒`);

  for (let i = 0; i < bvids.length; i++) {
    const bvid = bvids[i];
    try {
      const entry = await fetchAndRecord(bvid, 'auto', roundId);
      console.log(`  ✔ ${bvid} 已更新 (播放 ${entry.data.stat.view})`);
    } catch (err) {
      console.error(`  ✘ ${bvid} 刷新失败: ${err.message}`);
    }
    if (i < bvids.length - 1) {
      const jitter = gap * 0.2;
      const actualGap = gap - jitter + Math.random() * jitter * 2;
      await new Promise((r) => setTimeout(r, actualGap));
    }
  }
  console.log('⏰ 定时刷新完成');
}

function scheduleNext() {
  const delay = nextDelay();
  const minutes = (delay / 60000).toFixed(1);
  console.log(`⏱️  下一次自动刷新将在 ${minutes} 分钟后`);
  refreshTimer = setTimeout(async () => {
    await refreshAll();
    scheduleNext();
  }, delay);
}

function startScheduler() {
  if (refreshTimer) clearTimeout(refreshTimer);
  console.log(`⏱️  随机刷新已启用：间隔 ${REFRESH_MIN / 60000}~${REFRESH_MAX / 60000} 分钟`);
  scheduleNext();
}

// ==================================================================
// ========== 路由 ==================================================
// ==================================================================

// ---- 图片代理 ----
app.get('/api/image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('缺少 url 参数');

  let target;
  try {
    target = decodeURIComponent(url);
  } catch {
    return res.status(400).send('url 格式错误');
  }

  const allowedHosts = ['i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'];
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return res.status(400).send('url 格式错误');
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    return res.status(403).send('不允许的图片域名');
  }

  try {
    const response = await axios.get(target, {
      responseType: 'stream',
      headers: {
        'User-Agent': BILI_HEADERS['User-Agent'],
        'Referer': 'https://www.bilibili.com/',
      },
      timeout: 10000,
    });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    response.data.pipe(res);
  } catch (err) {
    console.error('图片代理失败:', err.message);
    res.status(500).send('图片加载失败');
  }
});

// ---- 健康检查 ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    watchedCount: watched.size,
    refreshRangeMin: [REFRESH_MIN / 60000, REFRESH_MAX / 60000],
    timelineToleranceMin: TIMELINE_TOLERANCE / 60000,
    roundBudgetSec: ROUND_BUDGET / 1000,
    maxCompare: MAX_COMPARE,
  });
});

// ---- 查询并监控 ----
app.get('/api/video', async (req, res) => {
  const { bvid } = req.query;
  if (!bvid) return res.status(400).json({ code: 400, message: '缺少参数 bvid' });
  if (!BV_PATTERN.test(bvid)) return res.status(400).json({ code: 400, message: 'BV 号格式不正确' });

  try {
    const entry = await fetchAndRecord(bvid, 'manual', null);
    return res.json({ code: 0, message: 'ok', data: entry.data, fetchedAt: entry.fetchedAt });
  } catch (error) {
    console.error('请求 B 站失败:', error.message);
    if (error.response) {
      return res.status(error.response.status).json({
        code: error.response.status,
        message: `B 站接口返回 ${error.response.status}，可能被风控拦截`,
      });
    }
    return res.status(500).json({ code: 500, message: error.message });
  }
});

// ---- 监控列表 / 单个历史 ----
app.get('/api/history', (req, res) => {
  const { bvid, limit } = req.query;

  if (!bvid) {
    const list = Array.from(watched.values()).map((r) => ({
      bvid: r.bvid,
      lastFetch: r.lastFetch,
      count: r.history.length,
      latest: r.history[r.history.length - 1]?.data ?? null,
    }));
    return res.json({ code: 0, data: list });
  }

  const record = watched.get(bvid);
  if (!record) {
    return res.status(404).json({ code: 404, message: '该 BV 号暂无历史记录' });
  }

  let history = record.history;
  if (limit) {
    const n = parseInt(limit, 10);
    if (!isNaN(n) && n > 0) history = history.slice(-n);
  }

  return res.json({
    code: 0,
    data: { bvid: record.bvid, lastFetch: record.lastFetch, total: record.history.length, history },
  });
});

// ---- 单视频趋势 ----
app.get('/api/trend', (req, res) => {
  const { bvid } = req.query;
  if (!bvid) return res.status(400).json({ code: 400, message: '缺少参数 bvid' });
  const record = watched.get(bvid);
  if (!record) return res.status(404).json({ code: 404, message: '该 BV 号暂无历史记录' });

  const trend = record.history.map((h) => ({
    time: h.fetchedAt,
    view: h.data.stat.view,
    like: h.data.stat.like,
    coin: h.data.stat.coin,
    favorite: h.data.stat.favorite,
    reply: h.data.stat.reply,
    danmaku: h.data.stat.danmaku,
  }));
  return res.json({ code: 0, data: trend });
});

// ---- 单/多视频对比（按 roundId 分组） ----
app.get('/api/compare', (req, res) => {
  const { bvids, metric = 'view', mode = 'absolute' } = req.query;

  if (!bvids) return res.status(400).json({ code: 400, message: '缺少参数 bvids' });
  if (!VALID_METRICS.includes(metric)) {
    return res.status(400).json({ code: 400, message: `metric 必须是 ${VALID_METRICS.join('/')} 之一` });
  }
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ code: 400, message: `mode 必须是 ${VALID_MODES.join('/')} 之一` });
  }

  const bvidList = bvids.split(',').map((s) => s.trim()).filter(Boolean);
  if (bvidList.length === 0) return res.status(400).json({ code: 400, message: 'bvids 为空' });
  if (bvidList.length > MAX_COMPARE) {
    return res.status(400).json({ code: 400, message: `最多同时对比 ${MAX_COMPARE} 个视频` });
  }

  const rawSeries = [];

  for (const bvid of bvidList) {
    const record = watched.get(bvid);
    if (!record) {
      rawSeries.push({ bvid, title: null, owner: null, error: '未监控该视频', rawPoints: [] });
      continue;
    }
    const latest = record.history[record.history.length - 1];
    const title = latest?.data?.title || bvid;
    const owner = latest?.data?.owner?.name || '';

    const rawPoints = record.history.map((h) => {
      const t = h.roundId || h.fetchedAt;
      return {
        time: t,
        value: h.data.stat?.[metric] ?? 0,
        roundId: h.roundId || null,
      };
    });

    rawSeries.push({ bvid, title, owner, rawPoints });
  }

  const timeIdSet = new Set();
  for (const item of rawSeries) {
    if (item.error) continue;
    for (const p of item.rawPoints) {
      timeIdSet.add(p.time);
    }
  }

  let timeline = Array.from(timeIdSet).sort((a, b) => a - b);

  // 手动查询的点做容差合并
  const mergedTimeline = [];
  for (const t of timeline) {
    if (mergedTimeline.length === 0) {
      mergedTimeline.push(t);
      continue;
    }
    const last = mergedTimeline[mergedTimeline.length - 1];
    const lastHasRound = rawSeries.some(s => !s.error && s.rawPoints.some(p => p.time === last && p.roundId !== null));
    const curHasRound = rawSeries.some(s => !s.error && s.rawPoints.some(p => p.time === t && p.roundId !== null));
    if (!lastHasRound && !curHasRound && t - last <= TIMELINE_TOLERANCE) {
      continue;
    }
    mergedTimeline.push(t);
  }
  timeline = mergedTimeline;

  const result = rawSeries.map((item) => {
    if (item.error) {
      return {
        bvid: item.bvid,
        title: item.title,
        owner: item.owner,
        error: item.error,
        points: timeline.map((t) => ({ time: t, value: null })),
      };
    }

    const alignedRaw = timeline.map((t) => {
      const p = item.rawPoints.find((rp) => rp.time === t);
      if (p) return { time: t, value: p.value };
      let best = null;
      let bestDiff = Infinity;
      for (const rp of item.rawPoints) {
        if (rp.roundId !== null) continue;
        const diff = Math.abs(rp.time - t);
        if (diff < bestDiff && diff <= TIMELINE_TOLERANCE) {
          bestDiff = diff;
          best = rp;
        }
      }
      return { time: t, value: best ? best.value : null };
    });

    let points;
    if (mode === 'delta') {
      let lastValid = null;
      points = alignedRaw.map((p) => {
        if (p.value === null) return { time: p.time, value: null };
        if (lastValid === null) {
          lastValid = p.value;
          return { time: p.time, value: 0 };
        }
        const diff = Math.max(0, p.value - lastValid);
        lastValid = p.value;
        return { time: p.time, value: diff };
      });
    } else if (mode === 'percent') {
      const base = alignedRaw.find((p) => p.value !== null)?.value || 1;
      points = alignedRaw.map((p) => {
        if (p.value === null) return { time: p.time, value: null };
        return {
          time: p.time,
          value: base > 0 ? Number(((p.value / base) * 100).toFixed(2)) : 0,
        };
      });
    } else {
      points = alignedRaw;
    }

    return {
      bvid: item.bvid,
      title: item.title,
      owner: item.owner,
      points,
    };
  });

  return res.json({ code: 0, data: { metric, mode, timeline, series: result } });
});

// ---- 停止监控 ----
app.delete('/api/watch', (req, res) => {
  const { bvid } = req.query;
  if (!bvid) return res.status(400).json({ code: 400, message: '缺少参数 bvid' });
  if (watched.delete(bvid)) {
    saveHistory();
    return res.json({ code: 0, message: '已停止监控并删除历史' });
  }
  return res.status(404).json({ code: 404, message: '该 BV 号不在监控列表' });
});

// ---- 兼容旧接口名 ----
app.delete('/api/data', (req, res) => {
  const { bvid } = req.query;
  if (!bvid) return res.status(400).json({ code: 400, message: '缺少参数 bvid' });
  if (watched.delete(bvid)) {
    saveHistory();
    return res.json({ code: 0, message: '已停止监控并删除历史' });
  }
  return res.status(404).json({ code: 404, message: '该 BV 号不在监控列表' });
});

// ==================================================================
// ========== 404 兜底 ==============================================
// ==================================================================
app.use((req, res) => {
  console.log(`❌ 404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    code: 404,
    message: `接口不存在: ${req.method} ${req.path}`,
    hint: '可用接口: /api/video, /api/history, /api/trend, /api/compare, DELETE /api/watch, /api/image, /health',
  });
});

// ========== 启动 ==========
loadHistory();
startScheduler();

app.listen(PORT, () => {
  console.log('========================================');
  console.log(`✅ B 站代理服务已启动: http://localhost:${PORT}`);
  console.log('----------------------------------------');
  console.log('可用接口:');
  console.log('  GET    /health');
  console.log('  GET    /api/video?bvid=BV1xx411c7mD');
  console.log('  GET    /api/history');
  console.log('  GET    /api/history?bvid=BV1xx411c7mD&limit=50');
  console.log('  GET    /api/trend?bvid=BV1xx411c7mD');
  console.log('  GET    /api/compare?bvids=BV1xx[,BV2xx]&metric=view&mode=absolute|delta|percent');
  console.log('  DELETE /api/watch?bvid=BV1xx411c7mD');
  console.log('  GET    /api/image?url=<encoded>');
  console.log('----------------------------------------');
  console.log(`  时间轴合并容差: ${TIMELINE_TOLERANCE / 60000} 分钟`);
  console.log(`  整轮刷新预算: ${ROUND_BUDGET / 1000} 秒`);
  console.log(`  对比上限: ${MAX_COMPARE} 个视频`);
  console.log(`  前端页面: http://localhost:${PORT}`);
  console.log('========================================');
});

function gracefulShutdown(signal) {
  console.log(`\n🛑 收到 ${signal} 信号，正在保存历史...`);
  saveHistory();
  if (refreshTimer) clearTimeout(refreshTimer);
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));