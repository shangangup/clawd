#!/usr/bin/env node
/**
 * Antigravity 交易系统 v3.1 (自进化版)
 * 
 * 完整流程：
 * Discord 多频道监控 → 信号解析(文字+视觉AI) → Gemini 风控 → OKX 下单(强制止损+仓位管理) → Telegram 通知
 * 
 * v3.1 进化修复：
 * - 重复信号去重（同一消息ID或同一币种同方向5分钟内防重复下单）
 * - Vision SL=0 直接过滤，不进入风控
 * - 舒琴BTC价格"万"格式修复（6.5万→65000，支持不带万单位的万元BTC价格）
 * - 总持仓风险检查（超过账户10%总风险拒绝新开仓）
 * - OKX GET签名修复（查询字符串纳入签名）
 * - 交易员权重进化（Evolution Engine集成）
 */

const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ============== OKX IP直连修复 ==============
// Termux 环境 www.okx.com DNS 被污染 → 198.18.0.13（私有地址），TLS必败
// 方案：IP直连 + Host header 欺骗 + servername=SNI，完全绕过 DNS
const OKX_IPS = ['104.18.43.174', '172.64.144.82'];
let _okxIpIdx = 0;
function getOkxIp() { return OKX_IPS[_okxIpIdx++ % OKX_IPS.length]; }

// 创建支持 SNI 的 httpsAgent（让证书验证 www.okx.com 而非 IP）
const okxAgent = new https.Agent({ servername: 'www.okx.com', keepAlive: true, maxSockets: 5 });

// 封装 OKX 专用 axios 请求（替换 baseUrl 域名为 IP）
function makeOkxAxios(baseUrl) {
  return (config) => {
    const url = (config.url || '').replace('https://www.okx.com', `https://${getOkxIp()}`);
    return axios({ ...config, url, httpsAgent: okxAgent, headers: { ...config.headers, 'Host': 'www.okx.com' } });
  };
}
const okxAxios = makeOkxAxios('https://www.okx.com');

// 加载环境变量（密钥不硬编码在源码中）
require('dotenv').config({ path: path.join(__dirname, '.env') });

// 启动时验证关键密钥
const REQUIRED_ENVS = ['DISCORD_TOKEN', 'OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_PASSPHRASE', 'TG_BOT_TOKEN', 'TG_CHAT_ID'];
const missingEnvs = REQUIRED_ENVS.filter(k => !process.env[k]);
if (missingEnvs.length > 0) {
  console.error(`❌ 缺少必要环境变量: ${missingEnvs.join(', ')}`);
  console.error(`请检查 /home/botdrop/.env 文件`);
  process.exit(1);
}

// ============== 跨源去重：canonical_trader_id 映射 ==============
// 同一真实交易员在不同频道的别名统一归一，防止重复下单
const CANONICAL_TRADER_MAP = {
  '舒琴':       'canonical:舒琴',
  '舒琴实盘':   'canonical:舒琴',   // 舒琴的实盘频道 = 同一来源
  '开仓策略':   'canonical:华尔街汇总',
  '合约持仓':   'canonical:华尔街汇总',
  '开仓策略-bot': 'canonical:华尔街汇总',
  '合约持仓-bot': 'canonical:华尔街汇总',
  'eliz':       'canonical:eliz',
  'eliz挑战':   'canonical:eliz',   // eliz 的挑战频道 = 同一来源
  'astekz':     'canonical:astekz',
  'astekz挑战': 'canonical:astekz', // astekz 的挑战频道 = 同一来源
};

// 跨源去重表：canonical_id + pair + direction → 首发时间
function getCanonicalTrader(traderName) {
  return CANONICAL_TRADER_MAP[traderName] || traderName;
}

const crossSourceDedup = new Map();

// ============== 模块 ==============
const riskControl = require('./risk-control-agent.js');
const visionParser = require('./vision-signal-parser.js');
const evolution = require('./evolution.js');
const { parseSignalStrict } = require('./.openclaw/skills/strict-parser/index.js');

// ============== Tech Confirm 旁路（rho-signals Skill，enforce=false）==============
// 全局开关：RHO_TECHCONFIRM_ENABLED=false 可一键回退到旧逻辑
const { execFile } = require('child_process');
const TECH_CONFIRM_SCRIPT = '/home/botdrop/.openclaw/skills/crypto-market-data/scripts/get_crypto_price.js';
const TECH_CONFIRM_LOG = '/home/botdrop/data/tech-confirm.jsonl';

async function techConfirmBypass(signal) {
  // 旁路模式：只记录，不拦截下单（enforce=false）
  const pair = signal.pair || '';
  const rawCoin = (pair.split('/')[0] || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!rawCoin) return { tech_trend: 'unknown', tech_score: 0, tech_confirm_pass: null };

  const symbolMap = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT',
    PEPE: 'PEPEUSDT'
  };
  const symbol = symbolMap[rawCoin] || `${rawCoin}USDT`;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=50`;

  const calcEMA = (values, period) => {
    if (!Array.isArray(values) || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  };

  const calcRSI = (values, period = 14) => {
    if (!Array.isArray(values) || values.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  };

  const timeoutFallback = { tech_trend: 'timeout', tech_score: 0, tech_confirm_pass: null };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      return timeoutFallback;
    }

    const klines = await resp.json();
    if (!Array.isArray(klines) || klines.length < 50) {
      return { tech_trend: 'no_data', tech_score: 0, tech_confirm_pass: null };
    }

    const closes = klines.map(k => Number(k[4])).filter(n => Number.isFinite(n));
    if (closes.length < 50) {
      return { tech_trend: 'no_data', tech_score: 0, tech_confirm_pass: null };
    }

    const rsi = calcRSI(closes, 14);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);

    let tech_ema_signal = 'neutral';
    let emaScore = 0;
    if (ema20 != null && ema50 != null) {
      if (ema20 > ema50) {
        tech_ema_signal = 'bullish';
        emaScore = 3;
      } else if (ema20 < ema50) {
        tech_ema_signal = 'bearish';
        emaScore = -3;
      }
    }

    let rsiScore = 0;
    if (typeof rsi === 'number') {
      if (rsi >= 65) rsiScore = 2;
      else if (rsi >= 55) rsiScore = 1;
      else if (rsi <= 35) rsiScore = -2;
      else if (rsi <= 45) rsiScore = -1;
    }

    const tech_score = Math.max(-5, Math.min(5, emaScore + rsiScore));
    let tech_trend = 'neutral';
    if (tech_score >= 2) tech_trend = 'bullish';
    else if (tech_score <= -2) tech_trend = 'bearish';

    const signalDir = signal.direction;
    let tech_confirm_pass = null;
    if (signalDir === 'buy') tech_confirm_pass = tech_score >= 0;
    else if (signalDir === 'sell') tech_confirm_pass = tech_score <= 0;

    const result = {
      tech_trend,
      tech_score,
      tech_rsi: rsi != null ? Number(rsi.toFixed(2)) : null,
      tech_ema_signal,
      tech_confirm_pass
    };

    const logEntry = JSON.stringify({
      ts: new Date().toISOString(),
      pair,
      direction: signalDir,
      ...result,
      enforce: false
    }) + '\n';
    require('fs').appendFileSync(TECH_CONFIRM_LOG, logEntry);

    console.log(`📊 [TechConfirm] ${pair} ${signalDir}: trend=${result.tech_trend} score=${result.tech_score} rsi=${result.tech_rsi} ema=${result.tech_ema_signal} confirm=${result.tech_confirm_pass}`);

    return result;
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted|timeout/i.test(String(e.message || '')))) {
      return timeoutFallback;
    }
    return { tech_trend: 'error', tech_score: 0, tech_confirm_pass: null };
  }
}

const PositionLedger = require('./position-ledger.js');

// ============== 配置 ==============
const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN,
  
  channels: {
    // === 华尔街聚合 - 中文交易员 ===
    '1353374726063525999': { name: '舒琴',             group: '华尔街-中文',  priority: 1, weight: 1.5 }, // A级，完整中文结构化
    '1459524335692808356': { name: '舒琴实盘',         group: '华尔街-中文',  priority: 1, weight: 1.5 }, // 舒琴实盘频道
    '1360963389500817500': { name: '三木',             group: '华尔街-中文',  priority: 1, weight: 1.2 }, // 信号质量高，有完整SL
    '1360963413454360747': { name: '比特币军长',        group: '华尔街-中文',  priority: 3, weight: 0.1 }, // 刷屏bot，静默跳过
    '1360963304155254805': { name: '大镖客',            group: '华尔街-中文',  priority: 2, weight: 1.0 },
    '1373408084487311581': { name: '币圈所长',          group: '华尔街-中文',  priority: 2, weight: 1.3 }, // 有止损，历史胜率高
    // === 华尔街聚合 - WWG集团 ===
    '1367913657475928287': { name: 'eliz',             group: '华尔街-WWG',   priority: 3, weight: 0.2 }, // 严重依赖图片
    '1373313418735517817': { name: 'eliz挑战',         group: '华尔街-WWG',   priority: 3, weight: 0.2 }, // 同上
    '1436923818793762946': { name: 'astekz挑战',       group: '华尔街-WWG',   priority: 3, weight: 0.5 },
    '1367915046427951124': { name: 'astekz',           group: '华尔街-WWG',   priority: 3, weight: 0.5 },
    '1367915076774002860': { name: 'tareeq',           group: '华尔街-WWG',   priority: 2, weight: 1.0 },
    '1361043391944724749': { name: '开仓策略',          group: '华尔街-汇总',  priority: 1, weight: 1.2 }, // 对标开仓策略-bot
    '1361043511763403088': { name: '合约持仓',          group: '华尔街-汇总',  priority: 1, weight: 1.2 }, // 对标合约持仓-bot
    // === 华尔街聚合 - Unity Academy ===
    '1417521346229047440': { name: 'sveezy',           group: '华尔街-Unity', priority: 2, weight: 0.5 }, // 信号不完整，降权
    '1417521609471688888': { name: 'soul',             group: '华尔街-Unity', priority: 2, weight: 0.2 }, // 依赖图片，最低权重
    '1441069986905981033': { name: 'prestige',         group: '华尔街-Unity', priority: 2, weight: 0.2 }, // 依赖图片，最低权重
    '1458692776299598050': { name: 'ajmal',            group: '华尔街-Unity', priority: 1, weight: 1.5 }, // 82%真实胜率，最规范
    // === 华尔街聚合 - 国外交易 ===
    '1371907070021992539': { name: 'wallstreet-queen', group: '华尔街-英文',  priority: 1, weight: 1.5 }, // 连续止盈，多TP
    '1371900523774742538': { name: 'binance-killers',  group: '华尔街-英文',  priority: 2, weight: 1.2 }, // 结构化信号
    '1361033949744463922': { name: 'trader-titan',     group: '华尔街-斗兽场', priority: 3, weight: 0.25 }, // 冷启动，无历史样本
    '1361034031189463323': { name: 'trader-gauls',     group: '华尔街-斗兽场', priority: 3, weight: 0.35 }, // 冷启动
    '1361034060041949355': { name: 'trader-cash',      group: '华尔街-斗兽场', priority: 3, weight: 0.30 }, // 冷启动
    '1361033995403399198': { name: 'trader-bamp',      group: '华尔街-斗兽场', priority: 3, weight: 0.30 }, // 冷启动
    // === 华尔街聚合 - 活跃动态汇总 ===
    '1422235932651814932': { name: '活跃交易动态',      group: '华尔街-汇总',  priority: 3, weight: 0.7 }, // The lab活跃交易
  },
  
  okx: {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: 'https://www.okx.com',
    useDemo: process.env.OKX_USE_DEMO !== 'false'  // 默认模拟盘，明确设置false才切实盘
  },
  
  telegram: {
    botToken: process.env.TG_BOT_TOKEN,
    chatId: process.env.TG_CHAT_ID
  },
  
  trading: {
    // 实盘66U本金 → 每笔最大风险2%（≈1.32U），杠杆5x
    maxRiskPercent: 2,        // 2%风险/单（三刃辩论后定稿）
    // maxRiskPerTradeUSDT 已移除：66U账户下该参数是伪参数（2%×66=1.32U永远小于任何设定值）
    defaultLeverage: '5',     // 5x杠杆
    maxPositions: 3,          // 允许最多3个仓位（小账户多品种分散）
    maxDailyLossPercent: 3,   // 日亏损超过3%自动停止
    maxConsecutiveLoss: 3,    // 连续亏损3笔暂停交易6h
    consecutiveLossCooldownH: 6,
    minRR: 2.0,               // 最低风险回报比2:1
    minSizeUSDT: 5,
    // 可交易宇宙白名单：主流合约，按账户规模动态可执行
    // 66U账户 riskCap≈1.32U，可执行条件：|entry-sl|×ctVal ≤ 1.32U
    // 例：ETH ctVal=0.01，SL距离≤132U时可执行（约6.8%）
    coinWhitelist: [
      'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT',
      'DOGE/USDT', 'XRP/USDT', 'ADA/USDT', 'AVAX/USDT',
      'LINK/USDT', 'DOT/USDT', 'MATIC/USDT', 'ARB/USDT',
      'OP/USDT', 'SUI/USDT', 'APT/USDT', 'HYPE/USDT',
    ],
  },
  
  logging: {
    dir: '/home/botdrop/data',
    historyPath: '/home/botdrop/data/trading-history.json',
    positionsPath: '/home/botdrop/data/active-positions.json',
    signalsPath: '/home/botdrop/data/signals-log.json'
  }
};

// 后续信号追踪（影子模式）
let FOLLOWUP_SHADOW = process.env.FOLLOWUP_SHADOW !== 'false'; // 默认true，可运行时回滚
let FOLLOWUP_ERR_COUNT = 0;
let FOLLOWUP_RECOVER_TIMER = null;
let FOLLOWUP_HEALTH_COUNT = 0; // 断路器健康探测计数
const FOLLOWUP_EXEC_DEDUP = new Map(); // message_id+action → timestamp
const FOLLOWUP_LOG = '/home/botdrop/data/followup-shadow.jsonl';

// 确保数据目录存在
if (!fs.existsSync(CONFIG.logging.dir)) fs.mkdirSync(CONFIG.logging.dir, { recursive: true });

// ============== 拒单聚合通知（三刃辩论定稿：节流防刷屏）==============
const _rejectedSignals = [];
let _rejectFlushTimer = null;
function queueRejection(pair, trader, reason) {
  _rejectedSignals.push({ pair, trader, reason, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
  if (!_rejectFlushTimer) {
    _rejectFlushTimer = setTimeout(flushRejections, 15 * 60 * 1000); // 15分钟汇总
  }
  // 如果积累超过10条，提前发送
  if (_rejectedSignals.length >= 10) flushRejections();
}
async function flushRejections() {
  if (_rejectFlushTimer) { clearTimeout(_rejectFlushTimer); _rejectFlushTimer = null; }
  if (_rejectedSignals.length === 0) return;
  const items = _rejectedSignals.splice(0);
  const lines = items.map(r => `• ${r.time} ${r.trader}｜${r.pair}: ${r.reason}`);
  const msg = `⛔ <b>拒单汇总 (共${items.length}笔)</b>\n\n${lines.join('\n')}\n\n💡 小账户正常现象，止损距离过大的信号自动过滤`;
  await sendTG(msg);
}



// ============== 重复信号防护 ==============
// 记录最近处理过的信号，防止同一信号重复下单
const recentSignals = new Map(); // key: "pair-direction", value: { time, messageId }

// 内容哈希去重：针对bot多次转发相同内容
const recentContentHashes = new Map();

// 去重状态持久化文件
const DEDUP_STATE_FILE = path.join(CONFIG.logging.dir, 'dedup-state.json');

// 启动时恢复去重状态
function loadDedupState() {
  try {
    if (fs.existsSync(DEDUP_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEDUP_STATE_FILE, 'utf8'));
      const now = Date.now();
      // 恢复未过期的记录
      if (data.signals) {
        for (const [k, v] of Object.entries(data.signals)) {
          if (now - v.time < 30 * 60 * 1000) recentSignals.set(k, v);
        }
      }
      if (data.hashes) {
        for (const [k, v] of Object.entries(data.hashes)) {
          if (now - v.time < 30 * 60 * 1000) recentContentHashes.set(k, v);
        }
      }
      console.log(`📋 去重状态恢复: ${recentSignals.size} 信号 + ${recentContentHashes.size} 哈希`);
    }
  } catch (e) {
    console.log(`⚠️ 去重状态恢复失败: ${e.message}`);
  }
}
loadDedupState();

// 定期持久化去重状态（每2分钟）
setInterval(() => {
  try {
    const signals = {};
    for (const [k, v] of recentSignals.entries()) signals[k] = v;
    const hashes = {};
    for (const [k, v] of recentContentHashes.entries()) hashes[k] = v;
    fs.writeFileSync(DEDUP_STATE_FILE, JSON.stringify({ signals, hashes, savedAt: Date.now() }));
  } catch (e) {}
}, 2 * 60 * 1000);

function contentHash(text, pair, direction, entry) {
  // 用币种+方向+入场价+文字前50字符做指纹
  const raw = `${pair}-${direction}-${Math.round(entry||0)}-${(text||'').substring(0,50)}`;
  return crypto.createHash('md5').update(raw).digest('hex').substring(0,12);
}

function isDuplicateSignal(messageId, pair, direction, entry, rawText, traderName) {
  const now = Date.now();
  
  // 同一消息ID：直接拒绝
  if (recentSignals.has('msg-' + messageId)) return true;
  
  // 内容哈希去重（针对比特币军长等bot多次转发同一内容）
  const hash = contentHash(rawText, pair, direction, entry);
  const hashKey = 'hash-' + hash;
  const hashPrev = recentContentHashes.get(hashKey);
  // bot类交易员用20分钟窗口，其他用10分钟
  const isBotTrader = ['比特币军长', '活跃交易动态', '合约持仓-bot', '开仓策略-bot'].includes(traderName);
  const dedupeWindow = isBotTrader ? 20 * 60 * 1000 : 10 * 60 * 1000;
  if (hashPrev && now - hashPrev.time < dedupeWindow) {
    console.log(`🔁 [${traderName}] 内容重复跳过: ${pair} ${direction} (距上次 ${Math.round((now-hashPrev.time)/1000)}秒)`);
    return true;
  }
  
  // === 跨源同源去重：canonical_trader + pair + direction，5分钟窗口 ===
  // 防止同一交易员在多个频道/bot转发重复信号各执行一次
  const canonicalTrader = getCanonicalTrader(traderName);
  const timeBucket5m = Math.floor(now / (5 * 60 * 1000)); // 5分钟时间桶
  const canonicalKey = `canonical:${canonicalTrader}:${pair}:${direction}:${timeBucket5m}`;
  const canonicalPrev = recentSignals.get(canonicalKey);
  if (canonicalPrev) {
    console.log(`🔁 [${traderName}→${canonicalTrader}] 跨源同源重复跳过: ${pair} ${direction} (dedup_reason=cross_source_duplicate)`);
    return true;
  }
  // 聚合bot：若5分钟内已有真人源同向单，直接跳过
  if (canonicalTrader === '_aggregator_') {
    const anyRealKey = `real:${pair}:${direction}:${timeBucket5m}`;
    if (recentSignals.get(anyRealKey)) {
      console.log(`🔁 [${traderName}] 聚合bot重复转发跳过: ${pair} ${direction} (real_source已存在, dedup_reason=aggregator_duplicate)`);
      return true;
    }
  }

  // 同一币种+方向+入场价（自适应精度桶化）：30分钟内去重
  // BTC 67650和67651.3都归到67650桶，防止微小偏差绕过去重
  const entryBucket = entry ? (
    entry >= 1000 ? Math.round(entry / 10) * 10 :
    entry >= 100 ? Math.round(entry) :
    entry >= 10 ? Math.round(entry * 10) / 10 :
    Math.round(entry * 100) / 100
  ) : 'noentry';
  const key = `${pair}-${direction}-${entryBucket}`;
  const prev = recentSignals.get(key);
  if (prev && now - prev.time < 30 * 60 * 1000) {
    console.log(`🔁 重复信号跳过: ${pair} ${direction} @${entry} (距上次 ${Math.round((now-prev.time)/1000)}秒)`);
    return true;
  }
  
  // 同一币种+方向（不管入场价）：
  // 汇总bot（小鱼-汇总组）24小时内同向只下一单（防止多个汇总bot转发同一信号重复下单）
  // bot类15分钟内同向只下一单，其他交易员5分钟
  const isAggBot = ['合约持仓-bot', '开仓策略-bot'].includes(traderName);
  const broadKey = `${pair}-${direction}`;
  const broadPrev = recentSignals.get(broadKey);
  const broadWindow = isAggBot ? 24 * 60 * 60 * 1000  // 汇总bot: 24小时
                    : isBotTrader ? 15 * 60 * 1000     // 普通bot: 15分钟
                    : 5 * 60 * 1000;                   // 普通交易员: 5分钟
  if (broadPrev && now - broadPrev.time < broadWindow) {
    console.log(`🔁 [${traderName}] ${Math.round(broadWindow/60000)}分钟内同向重复跳过: ${pair} ${direction} (距上次 ${Math.round((now-broadPrev.time)/1000)}秒)`);
    return true;
  }
  
  // 跨源去重：同一 canonical_trader_id + pair + direction 5分钟内只执行一次
  const canonicalId = CANONICAL_TRADER_MAP[traderName] || null;
  if (canonicalId && pair && direction) {
    const crossKey = `cross-${canonicalId}-${pair}-${direction}`;
    const crossPrev = crossSourceDedup.get(crossKey);
    if (crossPrev && now - crossPrev.time < 5 * 60 * 1000) {
      console.log(`🔁 [${traderName}→${canonicalId}] 跨源重复跳过: ${pair} ${direction} (距上次 ${Math.round((now-crossPrev.time)/1000)}秒, 首发频道: ${crossPrev.source})`);
      return true;
    }
    crossSourceDedup.set(crossKey, { time: now, source: traderName });
    // 清理过期跨源记录
    for (const [k, v] of crossSourceDedup.entries()) {
      if (now - v.time > 10 * 60 * 1000) crossSourceDedup.delete(k);
    }
  }

  // 检查通过，记录去重标记
  recentSignals.set('msg-' + messageId, { time: now });
  // 记录canonical去重key
  recentSignals.set(canonicalKey, { time: now, trader: traderName });
  // 若非聚合bot，记录真人源标记（防聚合bot后续重复）
  if (canonicalTrader !== '_aggregator_') {
    const realKey = `real:${pair}:${direction}:${timeBucket5m}`;
    recentSignals.set(realKey, { time: now, trader: traderName });
  }
  
  // 清理过期记录
  for (const [k, v] of recentSignals.entries()) {
    if (now - v.time > 30 * 60 * 1000) recentSignals.delete(k);
  }
  for (const [k, v] of recentContentHashes.entries()) {
    if (now - v.time > 30 * 60 * 1000) recentContentHashes.delete(k);
  }
  return false;
}

// 下单成功后才写入完整去重记录
function commitDedupRecord(messageId, pair, direction, entry, rawText, traderName) {
  const now = Date.now();
  const entryBucket = entry ? (
    entry >= 1000 ? Math.round(entry / 10) * 10 :
    entry >= 100 ? Math.round(entry) :
    entry >= 10 ? Math.round(entry * 10) / 10 :
    Math.round(entry * 100) / 100
  ) : 'noentry';
  const key = `${pair}-${direction}-${entryBucket}`;
  const broadKey = `${pair}-${direction}`;
  const hash = contentHash(rawText, pair, direction, entry);
  const hashKey = 'hash-' + hash;
  recentSignals.set(key, { time: now, messageId });
  recentSignals.set(broadKey, { time: now, messageId });
  recentContentHashes.set(hashKey, { time: now });
}

// ============== OKX API ==============
function okxSig(ts, m, p, b) {
  return crypto.createHmac('sha256', CONFIG.okx.secretKey).update(ts + m + p + b).digest('base64');
}

async function okxReq(method, endpoint, body = null, params = {}, _retry = 0) {
  const ts = new Date().toISOString();
  const M = method.toUpperCase();
  // GET 签名必须包含查询字符串！
  const qs = (M === 'GET' && Object.keys(params).length) ? '?' + new URLSearchParams(params).toString() : '';
  const bs = (M !== 'GET' && body) ? JSON.stringify(body) : '';
  const sig = okxSig(ts, M, endpoint + qs, bs);
  const headers = {
    'OK-ACCESS-KEY': CONFIG.okx.apiKey,
    'OK-ACCESS-SIGN': sig,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': CONFIG.okx.passphrase,
    'Content-Type': 'application/json'
  };
  if (CONFIG.okx.useDemo) headers['x-simulated-trading'] = '1';
  const url = CONFIG.okx.baseUrl + endpoint + qs;
  try {
    return (await okxAxios({ method: M, url, headers, data: M !== 'GET' ? body : undefined, timeout: 12000 })).data;
  } catch (e) {
    const isNetErr = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED' || e.code === 'ENOSYS' ||
                    (e.message || '').includes('socket') || (e.message || '').includes('network') || (e.message || '').includes('TLS');
    if (isNetErr && _retry < 3) {
      const delay = [200, 800, 2000][_retry];
      console.log(`⚠️ OKX 网络抖动 (${_retry+1}/3)，${delay}ms 后重试: ${endpoint}`);
      await new Promise(r => setTimeout(r, delay));
      return okxReq(method, endpoint, body, params, _retry + 1);
    }
    throw e;
  }
}

// ============== Telegram ==============
async function sendTG(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
      { chat_id: CONFIG.telegram.chatId, text: message, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
  } catch (e) {
    console.error('⚠️ TG通知失败:', e.message);
  }
}

function classifyOrderErrorCategory(msg = '') {
  const lower = String(msg || '').toLowerCase();
  if (lower.includes('timeout') || lower.includes('network')) return 'network_timeout';
  if (lower.includes('insufficient')) return 'insufficient_margin';
  return 'order_rejected';
}

function buildOrderErrorTG(demoTag, trader, pair, msg, category, recovered = false) {
  if (category === 'network_timeout') {
    if (recovered) {
      return `⚠️ <b>[网络抖动] 下单超时，已回查确认</b>\n\n${trader}\n${pair}: ${msg}`;
    }
    return `⚠️ <b>[网络抖动] 下单超时，回查未确认</b>\n\n${trader}\n${pair}: ${msg}`;
  }
  if (category === 'insufficient_margin') {
    return `❌ <b>[保证金不足] ${demoTag} 下单失败</b>\n\n${trader}\n${pair}: ${msg}`;
  }
  return `❌ <b>${demoTag} 下单失败</b>\n\n${trader}\n${pair}: ${msg}`;
}

// ============== 余额 ==============
async function getBalance() {
  const data = await okxReq('GET', '/api/v5/account/balance');
  if (data.code === '0' && data.data?.[0]) {
    // 用 totalEq（总权益）而非 availBal（可用余额）
    // 避免持仓占用保证金后 availBal 接近0导致仓位计算失败
    const totalEq = parseFloat(data.data[0].totalEq || 0);
    if (totalEq > 0) return totalEq;
    // fallback: 用 USDT details
    const usdt = data.data[0].details?.find(d => d.ccy === 'USDT');
    return usdt ? parseFloat(usdt.cashBal || usdt.availBal || 0) : 0;
  }
  return 0;
}

// 快速获取账户详情（totalEq + usedMargin 一次调用）
async function getAccountSummary() {
  try {
    const data = await okxReq('GET', '/api/v5/account/balance');
    if (data.code === '0' && data.data?.[0]) {
      return {
        totalEq: parseFloat(data.data[0].totalEq || 0),
        availEq: parseFloat(data.data[0].adjEq || data.data[0].totalEq || 0),
        usedMargin: parseFloat(data.data[0].imr || 0),  // OKX直接返回已用保证金
        mgnRatio: parseFloat(data.data[0].mgnRatio || 0),
      };
    }
  } catch (e) {
    console.log(`⚠️ getAccountSummary 失败: ${e.message}`);
  }
  return null;
}

// ============== 合约信息 ==============
async function getContractInfo(instId) {
  const data = await okxReq('GET', `/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  if (data.code === '0' && data.data?.[0]) {
    return {
      ctVal: parseFloat(data.data[0].ctVal),
      minSz: data.data[0].minSz,
      lotSz: data.data[0].lotSz,
    };
  }
  return null;
}

// ============== 仓位计算 ==============
async function calculatePosition(signal, balance, traderWeight = 1.0) {
  const instId = `${signal.pair.replace('/', '-')}-SWAP`;
  const contract = await getContractInfo(instId);
  if (!contract) throw new Error(`合约 ${instId} 不存在`);

  const leverage = parseInt((signal.leverage || CONFIG.trading.defaultLeverage + 'x').replace('x', ''));

  if (!signal.sl) throw new Error('sl缺失，无法计算仓位');

  // 市价单没有 entry，用当前市价代替
  let effectiveEntry = signal.entry;
  if (!effectiveEntry) {
    try {
      const tickerData = await okxReq('GET', `/api/v5/market/ticker?instId=${instId}`);
      effectiveEntry = parseFloat(tickerData.data?.[0]?.last || 0);
    } catch (e) { /* ignore, will fail below */ }
  }
  if (!effectiveEntry || effectiveEntry <= 0) throw new Error('无法获取有效入场价，拒绝开单');
  if (effectiveEntry === signal.sl) throw new Error('entry与sl相同，无法计算仓位');

  // 按交易员权重调整风险比例（A级 2.5%，D级 0.5%，默认 2%）
  const baseRisk = CONFIG.trading.maxRiskPercent / 100;
  const adjustedRisk = Math.min(baseRisk * traderWeight, 0.03); // 最高不超过3%
  const maxRisk = balance * adjustedRisk;

  const riskPerContract = Math.abs(effectiveEntry - signal.sl) * contract.ctVal;
  if (riskPerContract <= 0) throw new Error('风险距离为0，拒绝计算');

  // ===== 三刃辩论定稿：风险先行，不允许任何兜底绕风控 =====
  const minSz = parseInt(contract.minSz);
  const riskCap = maxRisk; // maxRisk = balance × adjustedRisk，无伪参数

  // 1张(minSz张)的止损风险是否超过riskCap？超了就拒单，给出明确原因
  const minRisk = riskPerContract * minSz;
  if (minRisk > riskCap) {
    const minAccountNeeded = Math.ceil(minRisk / adjustedRisk); // 向上取整
    const slPct = (Math.abs(effectiveEntry - signal.sl) / effectiveEntry * 100).toFixed(1);
    throw new Error(
      `止损距离过大(${slPct}%，单张风险${riskPerContract.toFixed(2)}U > 上限${riskCap.toFixed(2)}U)` +
      `，需账户≥${minAccountNeeded}U才可执行`
    );
  }

  let contracts = Math.floor(maxRisk / riskPerContract);
  if (contracts < minSz) contracts = minSz; // 理论上不会到这里，但保险

  // ===== P0 FIX: 双重上限保护（防ctVal极小时张数暴增）=====
  const lotSz = parseInt(contract.lotSz) || 1;
  const notionalUsd = contracts * contract.ctVal * effectiveEntry;
  const MAX_NOTIONAL_USD = totalEq * 0.25;  // 单笔名义本金不超过25%权益
  const MAX_CONTRACTS = 10000;               // 单笔最大10000张硬顶
  const rawContracts = contracts; // 审计用

  // 小ctVal保守模式
  if (contract.ctVal <= 0.01) {
    const conservativeCap = Math.floor(MAX_NOTIONAL_USD / (contract.ctVal * effectiveEntry));
    contracts = Math.min(contracts, conservativeCap, MAX_CONTRACTS);
    console.log(`🛡️ 小ctVal保守模式(ctVal=${contract.ctVal}): ${rawContracts}→${contracts}张`);
  }

  // 名义本金上限
  if (notionalUsd > MAX_NOTIONAL_USD) {
    contracts = Math.floor(MAX_NOTIONAL_USD / (contract.ctVal * effectiveEntry));
    console.log(`⚠️ POSITION_CAP_EXCEEDED: 名义本金${notionalUsd.toFixed(0)}U>${MAX_NOTIONAL_USD.toFixed(0)}U, 压缩${rawContracts}→${contracts}张`);
  }

  // 张数硬顶
  if (contracts > MAX_CONTRACTS) {
    console.log(`⚠️ POSITION_CAP_EXCEEDED: 张数${contracts}>${MAX_CONTRACTS}, 压缩至${MAX_CONTRACTS}张`);
    contracts = MAX_CONTRACTS;
  }

  // 步长规范化（lotSz对齐）
  contracts = Math.floor(contracts / lotSz) * lotSz;
  if (contracts < minSz) {
    throw new Error(`仓位压缩后不足最小${minSz}张(raw=${rawContracts},ctVal=${contract.ctVal}), POSITION_CAP_EXCEEDED`);
  }

  // 审计日志
  console.log(`📋 [仓位审计] raw_size=${rawContracts} normalized_size=${contracts} ctVal=${contract.ctVal} notional_usd=${(contracts*contract.ctVal*effectiveEntry).toFixed(0)} cap_rule_hit=${rawContracts!==contracts?'YES':'NO'}`);

  // BUG FIX #3 v2: 全局保证金检查
  // 用 OKX 账户接口直接返回的 imr（已用初始保证金），不自己累加持仓
  const acctSummary = await getAccountSummary();
  const totalEq = acctSummary?.totalEq || balance;
  const usedMargin = acctSummary?.usedMargin || 0;
  const newMargin = (contracts * contract.ctVal * effectiveEntry) / leverage;
  const totalMarginAfter = usedMargin + newMargin;

  if (totalMarginAfter > totalEq * 0.6) {
    const availableMargin = totalEq * 0.6 - usedMargin;
    if (availableMargin <= 0) throw new Error(`全局保证金已满(${((usedMargin/totalEq)*100).toFixed(0)}%)，拒绝开单`);
    contracts = Math.floor((availableMargin * leverage) / (contract.ctVal * effectiveEntry));
    if (contracts < minSz) throw new Error(`保证金空间不足以开最小${minSz}张，拒绝开单`);
    console.log(`⚠️ 保证金压缩至 ${contracts}张（全局上限60%保护）`);
  }

  // 单笔保证金不超过余额 20%（单笔硬顶）
  const finalMargin = (contracts * contract.ctVal * effectiveEntry) / leverage;
  if (finalMargin > totalEq * 0.2) {
    contracts = Math.floor((totalEq * 0.2 * leverage) / (contract.ctVal * effectiveEntry));
    if (contracts < minSz) throw new Error(`单笔20%保证金上限下不足最小${minSz}张，拒绝开单`);
    console.log(`⚠️ 单笔保证金压缩至 ${contracts}张（单笔上限20%保护）`);
  }

  if (contracts <= 0) {
    const slPct = (Math.abs(effectiveEntry - signal.sl) / effectiveEntry * 100).toFixed(1);
    const minAcct = Math.ceil(riskPerContract * minSz / adjustedRisk);
    const errMsg = `止损距离过大(${slPct}%，单张风险${riskPerContract.toFixed(2)}U > 上限${riskCap.toFixed(2)}U)，需账户≥${minAcct}U才可执行`;
    throw new Error(errMsg);
  }

  const actualMargin = (contracts * contract.ctVal * effectiveEntry) / leverage;
  return {
    contracts: contracts.toString(),
    totalRisk: riskPerContract * contracts,
    riskPercent: ((riskPerContract * contracts) / totalEq * 100).toFixed(2),
    margin: actualMargin.toFixed(2),
    leverage,
    effectiveEntry,  // 附带有效入场价，给后续逻辑用
  };
}

// ============== 交易执行（强制止损 + 正确时机） ==============
async function executeTrade(signal, trader) {
  // ===== KILL_SWITCH: 文件锁紧急停止 =====
  const KILL_FILE = '/tmp/kill_trading';
  if (fs.existsSync(KILL_FILE)) {
    console.log(`🛑 KILL_SWITCH激活（${KILL_FILE}存在），拒绝所有新单`);
    return { success: false, error: 'KILL_SWITCH active' };
  }

  const demoTag = CONFIG.okx.useDemo ? '🟢模拟' : '🔴真实';
  const instId = `${signal.pair.replace('/', '-')}-SWAP`;
  const isLimit = signal.orderType === 'MARKET' ? false : (signal.orderType === 'LIMIT' ? true : (!!signal.entry && signal.signal_type !== 'market')); // 显式orderType优先级最高
  const closeSide = signal.direction === 'buy' ? 'sell' : 'buy';

  // 1. 强制止损检查
  if (!signal.sl) {
    await sendTG(`🛑 <b>下单拒绝</b>\n\n交易员: ${trader}\n${signal.pair}: 无止损，拒绝`);
    return { success: false, error: '无止损' };
  }

  // 2. BUG FIX #2: 单币种方向互斥检查（禁止同币种反向持仓）
  const positions = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
  const existingPos = (positions.data || []).find(p =>
    p.instId === instId && parseFloat(p.pos) !== 0
  );
  if (existingPos) {
    const existDir = parseFloat(existingPos.pos) > 0 ? 'buy' : 'sell';
    if (existDir !== signal.direction) {
      console.log(`🛑 [${trader}] ${instId} 已有${existDir}仓，拒绝反向开单`);
      await sendTG(`🛑 <b>反向持仓保护</b>\n\n${signal.pair} 已有${existDir === 'buy' ? '多' : '空'}仓\n拒绝反向${signal.direction === 'buy' ? '多' : '空'}单`);
      return { success: false, error: '单币种反向持仓保护' };
    }
    // 汇总bot（合约持仓-bot/开仓策略-bot）已有同向仓位直接拒绝——它们是转发bot，重复信号很常见
    const isAggBot = ['合约持仓-bot', '开仓策略-bot'].includes(trader);
    if (isAggBot) {
      console.log(`🛑 [${trader}] ${instId} 汇总bot且已有同向仓位，跳过（防重复）`);
      return { success: false, error: '汇总bot重复信号保护' };
    }
    // 同向：限制追仓（最多追仓1次 = 总共2笔同币种，且单币种保证金不超30%）
    const existMargin = parseFloat(existingPos.imr || existingPos.notionalUsd || 0); // imr=初始保证金
    const acct = await getAccountSummary();
    const totalEqCheck = acct?.totalEq || 0;
    if (totalEqCheck <= 0) {
      console.log(`🛑 [${trader}] 无法获取账户权益，拒绝追仓`);
      return { success: false, error: '无法获取账户权益' };
    }
    if (existMargin / totalEqCheck > 0.30) {
      console.log(`🛑 [${trader}] ${instId} 单币种保证金已超30%，拒绝追仓`);
      await sendTG(`🛑 <b>追仓保护</b>\n\n${signal.pair} 单币种保证金已达 ${(existMargin/totalEqCheck*100).toFixed(0)}%\n拒绝继续追仓`);
      return { success: false, error: '单币种保证金超30%' };
    }
    console.log(`⚠️ [${trader}] ${instId} 追加同向仓位（保证金占比${(existMargin/totalEqCheck*100).toFixed(0)}%）`);
  }

  // 3. 余额检查
  const balance = await getBalance();
  if (balance < CONFIG.trading.minSizeUSDT) {
    return { success: false, error: `余额不足: ${balance}` };
  }

  // 3.5 AI幻觉熔断：限价/市价分场景风控（检查失败不阻断）
  try {
    const tickerData = await okxReq('GET', `/api/v5/market/ticker?instId=${instId}`);
    const markPx = parseFloat(tickerData.data?.[0]?.last || 0);
    const entryPx = parseFloat(signal.entry || 0);
    const hasEntry = entryPx > 0;

    if (markPx > 0) {
      if (isLimit && hasEntry) {
        // 1) 限价单方向防呆（1%容错）
        if (signal.direction === 'buy' && entryPx > markPx * 1.01) {
          const reject_reason = 'LIMIT_DIRECTION_MISMATCH';
          console.log(`🛑 ${reject_reason}: buy限价不应高于市价过多 entry=${entryPx} markPx=${markPx}`);
          return { success: false, error: `${reject_reason}: buy限价${entryPx}高于允许上限${(markPx * 1.01).toFixed(6)}` };
        }
        if (signal.direction === 'sell' && entryPx < markPx * 0.99) {
          const reject_reason = 'LIMIT_DIRECTION_MISMATCH';
          console.log(`🛑 ${reject_reason}: sell限价不应低于市价过多 entry=${entryPx} markPx=${markPx}`);
          return { success: false, error: `${reject_reason}: sell限价${entryPx}低于允许下限${(markPx * 0.99).toFixed(6)}` };
        }

        // 2) 限价单极端幻觉检查（30%）
        const limitDeviation = Math.abs(entryPx - markPx) / markPx;
        if (limitDeviation > 0.30) {
          const reject_reason = 'LIMIT_EXTREME_DEVIATION';
          console.log(`🛑 ${reject_reason}: entry=${entryPx} vs 市价=${markPx}, 偏差${(limitDeviation * 100).toFixed(1)}% > 30%`);
          return { success: false, error: `${reject_reason}: entry偏离市价${(limitDeviation * 100).toFixed(1)}%` };
        }

        // 3) 限价单SL锚点基于entry
        if (signal.sl) {
          const slDeviationFromEntry = Math.abs(signal.sl - entryPx) / entryPx;
          if (slDeviationFromEntry > 0.15) {
            const reject_reason = 'SL_EXTREME_DEVIATION';
            console.log(`🛑 ${reject_reason}: sl=${signal.sl} vs entry=${entryPx}, 偏差${(slDeviationFromEntry * 100).toFixed(1)}% > 15%`);
            return { success: false, error: `${reject_reason}: SL偏离entry${(slDeviationFromEntry * 100).toFixed(1)}%` };
          }
        }
      } else {
        // 市价单：entry若存在仅作参考，保持5%偏差检查
        if (hasEntry) {
          const marketEntryDeviation = Math.abs(entryPx - markPx) / markPx;
          if (marketEntryDeviation > 0.05) {
            const reject_reason = 'MARKET_ENTRY_DEVIATION';
            console.log(`🛑 ${reject_reason}: entry=${entryPx} vs 市价=${markPx}, 偏差${(marketEntryDeviation * 100).toFixed(1)}% > 5%`);
            return { success: false, error: `${reject_reason}: entry偏离市价${(marketEntryDeviation * 100).toFixed(1)}%` };
          }
        }

        // 市价单SL锚点基于markPx
        if (signal.sl) {
          const slDeviationFromMark = Math.abs(signal.sl - markPx) / markPx;
          if (slDeviationFromMark > 0.15) {
            const reject_reason = 'SL_EXTREME_DEVIATION';
            console.log(`🛑 ${reject_reason}: sl=${signal.sl} vs 市价=${markPx}, 偏差${(slDeviationFromMark * 100).toFixed(1)}% > 15%`);
            return { success: false, error: `${reject_reason}: SL偏离市价${(slDeviationFromMark * 100).toFixed(1)}%` };
          }
        }
      }
    }
  } catch (e) {
    const reject_reason = 'HALLUCINATION_CHECK_FAILED';
    console.log(`🛑 ${reject_reason}: ${e.message}，拒绝下单`);
    return { success: false, error: `${reject_reason}: ${e.message}` };
  }

  // 4. BUG FIX #6: 仓位计算失败 → 拒绝，不 fallback
  let pos;
  try {
    pos = await calculatePosition(signal, balance, signal._traderWeight || 1.0);
    console.log(`📊 仓位: ${pos.contracts}张 | 风险: ${pos.riskPercent}% (${pos.totalRisk.toFixed(2)} USDT) | 保证金: ${pos.margin} USDT`);
  } catch (e) {
    console.log(`🛑 仓位计算失败(${e.message})，拒绝下单`);
    // 止损距离过大 → 聚合通知（不刷屏）；其他错误 → 即时通知
    if (e.message.includes('止损距离过大')) {
      queueRejection(signal.pair, trader, e.message.split('，')[0]);
    } else {
      await sendTG(`🛑 <b>仓位计算失败</b>\n\n${trader}｜${signal.pair}: ${e.message}`);
    }
    return { success: false, error: `仓位计算失败: ${e.message}` };
  }

  // 5. 设置杠杆
  const leverage = pos.leverage || parseInt((signal.leverage || CONFIG.trading.defaultLeverage + 'x').replace('x', ''));
  try {
    await okxReq('POST', '/api/v5/account/set-leverage', { instId, lever: leverage.toString(), mgnMode: 'cross' });
  } catch (e) {
    // P0修复: 实盘模式下杠杆设置失败=拒单（不能按未知杠杆下单）
    if (!CONFIG.okx.useDemo) {
      console.log(`🛑 set-leverage失败(${e.message})，实盘模式拒绝下单`);
      await sendTG(`🛑 <b>杠杆设置失败</b>\n\n${signal.pair} 无法设置${leverage}x杠杆\n${e.message}\n已拒绝下单`);
      return { success: false, error: `杠杆设置失败: ${e.message}` };
    }
    console.log(`⚠️ set-leverage失败(${e.message})，模拟盘继续`);
  }

  // 6. 下主单（原子化 attachAlgoOrds：止损与主单同生共死）
  //    OKX V5 API: POST /api/v5/trade/order 支持 attachAlgoOrds 参数
  //    市价单/限价单统一处理，不再需要异步轮询挂止损
  let orderId;
  let slAlgoId = null;
  try {
    // 构建 attachAlgoOrds：原子化止损（+ 可选止盈）
    const attachAlgoOrds = [{
      // 注意：不传 attachAlgoClOrdId，OKX模拟盘会报51000错误
      slTriggerPx: signal.sl.toString(),
      slOrdPx: '-1',  // 市价止损
      slTriggerPxType: 'mark'  // 标记价格，防插针
    }];

    // 多TP时不在attachAlgoOrds挂TP（它跟随主单全量，无法分批）
    // 所有TP都通过步骤7独立挂algo order，实现真正分批止盈
    // 单TP时仍通过attachAlgoOrds挂（原子化）
    if (signal.tp?.length === 1) {
      attachAlgoOrds[0].tpTriggerPx = signal.tp[0].toString();
      attachAlgoOrds[0].tpOrdPx = '-1';
      attachAlgoOrds[0].tpTriggerPxType = 'mark';
    }
    // 多TP的分批止盈在步骤7处理

    const clientOrderId = `ag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const orderParams = {
      instId, tdMode: 'cross', side: signal.direction,
      ordType: isLimit ? 'limit' : 'market',
      sz: pos.contracts,
      clOrdId: clientOrderId,
      attachAlgoOrds,
      ...(isLimit && { px: signal.entry.toString() })
    };

    console.log(`📤 下单(attachAlgoOrds): ${instId} ${signal.direction} ${pos.contracts}张 SL=${signal.sl} TP=${signal.tp?.[0] || '无'} clOrdId=${clientOrderId}`);

    const queryByClientId = async () => {
      await sleep(3000);
      const check = await okxReq('GET', '/api/v5/trade/order', null, { instId, clOrdId: clientOrderId });
      const checkedOrder = check.data?.[0];
      if (check.code === '0' && checkedOrder && checkedOrder.state !== 'canceled') {
        orderId = checkedOrder.ordId;
        slAlgoId = checkedOrder.attachAlgoOrds?.[0]?.algoId || 'attached';
        console.log(`⚠️ 下单超时回查: ordId=${orderId} state=${checkedOrder.state}`);
        return checkedOrder;
      }
      console.log('❌ 回查确认失败');
      return null;
    };

    let orderResult = null;
    try {
      orderResult = await okxReq('POST', '/api/v5/trade/order', orderParams);
      logTraceEvent(signal._traceId || signal._messageId || `trade_${Date.now()}`, 'EXECUTED', { trader, coin: signal.coin, side: signal.side, exec_code: orderResult.code, detail: { ordId: orderResult.data?.[0]?.ordId } });
    } catch (e) {
      const errMsg = e.message || 'unknown error';
      const errCategory = classifyOrderErrorCategory(errMsg);
      if (errCategory === 'network_timeout') {
        try {
          const checkedOrder = await queryByClientId();
          if (checkedOrder) {
            await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, errMsg, errCategory, true));
          } else {
            console.log(`error_category: ${errCategory}`);
            await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, errMsg, errCategory, false));
            return { success: false, error: errMsg };
          }
        } catch (qe) {
          console.log(`❌ 回查确认失败: ${qe.message}`);
          console.log(`error_category: ${errCategory}`);
          await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, errMsg, errCategory, false));
          return { success: false, error: errMsg };
        }
      } else {
        console.log(`error_category: ${errCategory}`);
        await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, errMsg, errCategory, false));
        return { success: false, error: errMsg };
      }
    }

    if (!orderId && orderResult?.code !== '0') {
      // attachAlgoOrds 可能不被支持（某些合约），fallback 到分步下单
      if (orderResult.msg?.includes('attachAlgo') || orderResult.msg?.includes('Parameter')) {
        if (isLimit) {
          // 限价单：attachAlgoOrds 失败则直接拒绝（不允许无原子止损的限价单）
          console.log(`🛑 限价单 attachAlgoOrds 不支持，拒绝开仓（不允许异步止损）`);
          await sendTG(`🛑 <b>限价单拒绝</b>\n\n${trader}\n${signal.pair}: 该合约不支持原子化止损，限价单拒绝执行`);
          return { success: false, error: '限价单不支持attachAlgoOrds，拒绝' };
        }
        // 市价单：fallback 到分步下单（有即时平仓保护）
        console.log(`⚠️ attachAlgoOrds 不支持，市价单 fallback 到分步下单`);
        return await executeTradeFallback(signal, trader, instId, isLimit, closeSide, pos, leverage, demoTag);
      }

      const orderMsg = orderResult?.msg || 'unknown error';
      const errCategory = classifyOrderErrorCategory(orderMsg);

      if (errCategory === 'network_timeout') {
        try {
          const checkedOrder = await queryByClientId();
          if (checkedOrder) {
            await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, orderMsg, errCategory, true));
          } else {
            console.log(`error_category: ${errCategory}`);
            await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, orderMsg, errCategory, false));
            return { success: false, error: orderMsg };
          }
        } catch (qe) {
          console.log(`❌ 回查确认失败: ${qe.message}`);
          console.log(`error_category: ${errCategory}`);
          await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, orderMsg, errCategory, false));
          return { success: false, error: orderMsg };
        }
      } else {
        console.log(`error_category: ${errCategory}`);
        await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, orderMsg, errCategory, false));
        return { success: false, error: orderMsg };
      }
    }

    if (!orderId) {
      orderId = orderResult?.data?.[0]?.ordId;
      slAlgoId = orderResult?.data?.[0]?.attachAlgoOrds?.[0]?.algoId || slAlgoId || 'attached';
    }

    if (!orderId) {
      try {
        const checkedOrder = await queryByClientId();
        if (!checkedOrder) {
          console.log(`error_category: network_timeout`);
          await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, '返回缺少ordId且回查失败', 'network_timeout', false));
          return { success: false, error: '返回缺少ordId且回查失败' };
        }
        await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, '返回缺少ordId，已回查确认', 'network_timeout', true));
      } catch (qe) {
        console.log(`❌ 回查确认失败: ${qe.message}`);
        console.log(`error_category: network_timeout`);
        await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, '返回缺少ordId且回查异常', 'network_timeout', false));
        return { success: false, error: '返回缺少ordId且回查异常' };
      }
    }

    console.log(`✅ 主订单+止损原子化: orderId=${orderId} slAlgo=${slAlgoId} (${isLimit ? '限价' : '市价'})`);
  } catch (e) {
    await sendTG(`❌ <b>下单异常</b>\n\n${e.message}`);
    return { success: false, error: e.message };
  }

  // 7. 分批止盈（多TP从index 0开始全部按比例挂独立algo，单TP已由attachAlgoOrds全量处理）
  if (signal.tp?.length > 1) {
    const totalContracts = parseInt(pos.contracts);
    const tpCount = signal.tp.length;
    const ratios = tpCount === 2 ? [0.5, 0.5]
                 : tpCount === 3 ? [0.4, 0.35, 0.25]
                 : [0.35, 0.30, 0.25, 0.10];
    // 多TP：全部TP单独挂独立algo order（按比例分配张数）
    // TP[0]虽已在attachAlgoOrds挂了全量，但通过reduceOnly+分批覆盖
    // 实际上attachAlgoOrds的TP是全量兜底，这里挂的分批单会先触发
    for (let i = 0; i < signal.tp.length; i++) {
      const ratio = ratios[i] || (1 / tpCount);
      const tpSz = Math.max(1, Math.floor(totalContracts * ratio)).toString();
      try {
        await okxReq('POST', '/api/v5/trade/order-algo', {
          instId, tdMode: 'cross', side: closeSide,
          ordType: 'conditional', sz: tpSz,
          tpTriggerPx: signal.tp[i].toString(), tpOrdPx: '-1',
          tpTriggerPxType: 'mark', reduceOnly: 'true'
        });
        console.log(`✅ 止盈${i+1}: ${signal.tp[i]} (${tpSz}张, ${(ratio*100).toFixed(0)}%)`);
      } catch (e) {
        console.log(`⚠️ 止盈${i+1}失败: ${e.message}`);
      }
    }
  }

  // 8. 限价单仍需监控超时撤单（但止损已原子附带，不再需要轮询挂止损）
  if (isLimit) {
    monitorLimitOrder(instId, orderId, trader, signal, demoTag).catch(console.error);
  }

  // 9. 通知
  const tgMsg = isLimit
    ? `📋 <b>${demoTag} 限价单已挂</b>\n\n交易员: ${trader}\n${signal.pair} ${signal.direction.toUpperCase()}\n订单: <code>${orderId}</code>\n入场价: ${signal.entry}\n止损: ${signal.sl} ✅ 原子附带\n止盈: ${signal.tp?.join(', ') || '未设置'}\n杠杆: ${leverage}x | 仓位: ${pos.contracts}张\n保证金: ${pos.margin} USDT`
    : `✅ <b>${demoTag} 交易已执行</b>\n\n交易员: ${trader}\n${signal.pair} ${signal.direction.toUpperCase()}\n订单: <code>${orderId}</code>\n入场: 市价 | 止损: ${signal.sl} ✅ 原子附带\n止盈: ${signal.tp?.join(', ') || '未设置'}\n杠杆: ${leverage}x | 仓位: ${pos.contracts}张`;
  await sendTG(tgMsg);

  // 10. 保存记录
  const tradeRecord = {
    trader, instId, orderId, slAlgoId,
    pair: signal.pair, direction: signal.direction,
    entry: signal.entry, sl: signal.sl, tp: signal.tp,
    contracts: pos.contracts, margin: pos.margin, leverage,
    orderType: isLimit ? 'limit' : 'market',
    outcome: 'open', realizedPnl: null,
    source: signal.source, traderWeight: signal._traderWeight || 1.0,
    mode: CONFIG.okx.useDemo ? 'demo' : 'live',
    riskResult: { approved: true }
  };
  saveTradeLog(tradeRecord);
  // 下单成功后写入完整去重记录
  if (signal._messageId) commitDedupRecord(signal._messageId, signal.pair, signal.direction, signal.entry, signal.raw || '', signal._traderName || '');

  // 写入持仓台账（v2.0 融合版）
  if (global.ledger) {
    global.ledger.recordOrder({
      instId, direction: signal.direction,
      avgPx: signal.entry || pos.avgPx,
      contracts: pos.contracts,
      trader, sl: signal.sl, tp: signal.tp,
      orderId, signalRef: tradeRecord.id || null,
    });
    if (slAlgoId) global.ledger.updateSlOrder(instId, slAlgoId);
  }

  return { success: true, orderId, pos };
}

// ============== 限价单超时监控（止损已原子附带，只需监控撤单） ==============
const LIMIT_ORDER_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4小时超时

async function monitorLimitOrder(instId, orderId, trader, signal, demoTag) {
  const startTime = Date.now();
  console.log(`⏳ [${trader}] 监控限价单超时: ${orderId}`);

  while (Date.now() - startTime < LIMIT_ORDER_TIMEOUT_MS) {
    await sleep(60000); // 每1分钟查一次（止损已附带，不需要30秒高频）

    try {
      const orderInfo = await okxReq('GET', `/api/v5/trade/order?instId=${instId}&ordId=${orderId}`);
      const order = orderInfo.data?.[0];
      if (!order) continue;

      if (order.state === 'filled') {
        console.log(`✅ [${trader}] 限价单已成交: ${orderId}，avgPx=${order.avgPx}`);
        await sendTG(`✅ <b>${demoTag} 限价单成交</b>\n\n${trader}\n${signal.pair} ${signal.direction.toUpperCase()}\n成交价: ${order.avgPx}\n止损: ${signal.sl} ✅ 已原子附带`);
        updateTradeRecord(orderId, { entryFilled: parseFloat(order.avgPx), fillTime: order.fillTime });
        return;
      } else if (order.state === 'canceled' || order.state === 'partially_canceled') {
        console.log(`ℹ️ [${trader}] 限价单已撤销: ${orderId}`);
        updateTradeRecord(orderId, { outcome: 'canceled' });
        return;
      }
    } catch (e) {
      console.error(`⚠️ 查询订单状态失败: ${e.message}`);
    }
  }

  // 超时撤单
  console.log(`⏰ [${trader}] 限价单超时(4h)，自动撤单: ${orderId}`);
  try {
    await okxReq('POST', '/api/v5/trade/cancel-order', { instId, ordId: orderId });
    await sendTG(`⏰ <b>限价单超时撤销</b>\n\n${trader}\n${signal.pair}\n订单 <code>${orderId}</code> 4小时未成交，已自动撤销`);
    updateTradeRecord(orderId, { outcome: 'expired' });
  } catch (e) {
    console.error(`撤单失败: ${e.message}`);
  }
}

// ============== Fallback: 分步下单（attachAlgoOrds 不支持时） ==============
async function executeTradeFallback(signal, trader, instId, isLimit, closeSide, pos, leverage, demoTag) {
  console.log(`⚠️ [${trader}] 使用 fallback 分步下单模式`);
  
  let orderId;
  try {
    const orderResult = await okxReq('POST', '/api/v5/trade/order', {
      instId, tdMode: 'cross', side: signal.direction,
      ordType: isLimit ? 'limit' : 'market',
      sz: pos.contracts,
      ...(isLimit && { px: signal.entry.toString() })
    });
    logTraceEvent(signal._traceId || signal._messageId || `trade_${Date.now()}`, 'EXECUTED', { trader, coin: signal.coin, side: signal.side, exec_code: orderResult.code, detail: { ordId: orderResult.data?.[0]?.ordId } });
    if (orderResult.code !== '0') {
      const errCategory = classifyOrderErrorCategory(orderResult.msg || '');
      console.log(`error_category: ${errCategory}`);
      await sendTG(buildOrderErrorTG(demoTag, trader, signal.pair, orderResult.msg, errCategory, false));
      return { success: false, error: orderResult.msg };
    }
    orderId = orderResult.data[0].ordId;
  } catch (e) {
    return { success: false, error: e.message };
  }

  // 市价单立即挂止损
  let slAlgoId = null;
  if (!isLimit) {
    slAlgoId = await setStopLoss(instId, closeSide, pos.contracts, signal.sl, orderId);
    if (!slAlgoId) {
      console.error(`❌ fallback 止损失败，平仓保护`);
      await emergencyClose(instId, closeSide, pos.contracts, `${signal.pair} 止损设置失败`);
      return { success: false, error: '止损设置失败，已平仓' };
    }
  } else {
    // 限价单：异步等成交后挂止损（老逻辑）
    waitForFillAndSetSLLegacy(instId, orderId, closeSide, pos.contracts, signal, trader, pos, demoTag).catch(console.error);
  }

  const tgMsg = `✅ <b>${demoTag} 交易已执行(fallback)</b>\n\n交易员: ${trader}\n${signal.pair} ${signal.direction.toUpperCase()}\n订单: <code>${orderId}</code>\n止损: ${signal.sl} ${slAlgoId ? '✅' : '⏳'}`;
  await sendTG(tgMsg);

  const tradeRecord = {
    trader, instId, orderId, slAlgoId,
    pair: signal.pair, direction: signal.direction,
    entry: signal.entry, sl: signal.sl, tp: signal.tp,
    contracts: pos.contracts, margin: pos.margin, leverage,
    orderType: isLimit ? 'limit' : 'market',
    outcome: 'open', realizedPnl: null,
    source: signal.source, traderWeight: signal._traderWeight || 1.0,
    mode: CONFIG.okx.useDemo ? 'demo' : 'live',
    riskResult: { approved: true },
    fallback: true
  };
  saveTradeLog(tradeRecord);
  if (signal._messageId) commitDedupRecord(signal._messageId, signal.pair, signal.direction, signal.entry, signal.raw || '', signal._traderName || '');

  // 写入持仓台账（fallback 路径）
  if (global.ledger) {
    global.ledger.recordOrder({
      instId, direction: signal.direction,
      avgPx: signal.entry || pos.avgPx,
      contracts: pos.contracts,
      trader, sl: signal.sl, tp: signal.tp,
      orderId, signalRef: null,
    });
  }

  return { success: true, orderId, pos };
}

// Legacy: 限价单等成交后挂止损（仅 fallback 模式使用）
async function waitForFillAndSetSLLegacy(instId, orderId, closeSide, sz, signal, trader, pos, demoTag) {
  const startTime = Date.now();
  while (Date.now() - startTime < LIMIT_ORDER_TIMEOUT_MS) {
    await sleep(5000); // 5s轮询（原30s太长，极端行情下无止损窗口太大）
    try {
      const orderInfo = await okxReq('GET', `/api/v5/trade/order?instId=${instId}&ordId=${orderId}`);
      const order = orderInfo.data?.[0];
      if (!order) continue;
      if (order.state === 'filled') {
        const slAlgoId = await setStopLoss(instId, closeSide, sz, signal.sl, orderId);
        if (slAlgoId) {
          await sendTG(`✅ <b>${demoTag} 限价单成交(fallback)</b>\n\n${trader}\n${signal.pair}\n止损: ${signal.sl} ✅`);
          updateTradeRecord(orderId, { entryFilled: parseFloat(order.avgPx), slAlgoId, fillTime: order.fillTime });
        } else {
          await emergencyClose(instId, closeSide, sz, `${signal.pair} 成交后止损失败`);
        }
        return;
      } else if (order.state === 'canceled') {
        updateTradeRecord(orderId, { outcome: 'canceled' });
        return;
      }
    } catch (e) { console.error(`⚠️ fallback 查询失败: ${e.message}`); }
  }
  // 超时撤单
  try {
    await okxReq('POST', '/api/v5/trade/cancel-order', { instId, ordId: orderId });
    updateTradeRecord(orderId, { outcome: 'expired' });
  } catch (e) { console.error(`撤单失败: ${e.message}`); }
}

// 设置止损单（统一入口）
async function setStopLoss(instId, closeSide, sz, slPrice, orderId) {
  try {
    const slResult = await okxReq('POST', '/api/v5/trade/order-algo', {
      instId, tdMode: 'cross', side: closeSide,
      ordType: 'conditional', sz,
      slTriggerPx: slPrice.toString(), slOrdPx: '-1',
      slTriggerPxType: 'mark',  // 用标记价格，防插针
      reduceOnly: 'true'
    });
    if (slResult.code === '0') {
      return slResult.data[0].algoId;
    }
    console.error(`止损设置失败: ${slResult.msg}`);
    return null;
  } catch (e) {
    console.error(`止损异常: ${e.message}`);
    return null;
  }
}

// ============== 分层止损守护（三刃辩论融合版）==============
// 待止损池：下单后止损设置失败时入池，持续重试
const pendingSLMap = new Map(); // instId -> { closeSide, sz, slPrice, openTime, retryCount }

// 防自伤检查：当前价是否已穿过止损价（穿过则不设，避免立即触发）
async function isSLSafe(instId, direction, slPrice) {
  try {
    const ticker = await okxReq('GET', `/api/v5/market/ticker?instId=${instId}`);
    const currentPx = parseFloat(ticker.data?.[0]?.last || 0);
    if (!currentPx) return true; // 查不到价格，保守允许
    if (direction === 'buy') return currentPx > slPrice; // 多单：当前价需高于止损价
    if (direction === 'sell') return currentPx < slPrice; // 空单：当前价需低于止损价
  } catch (e) {}
  return true;
}

// 带指数退避的止损设置（Layer1紧急止损）
async function setStopLossWithRetry(instId, direction, closeSide, sz, slPrice, maxRetries = 5) {
  const delays = [1000, 5000, 15000, 30000, 60000];
  for (let i = 0; i < maxRetries; i++) {
    // 防自伤检查
    const safe = await isSLSafe(instId, direction, slPrice);
    if (!safe) {
      console.error(`⚠️ [SL守护] ${instId} 止损价${slPrice}已被穿越，跳过设置，发告警`);
      await sendTG(`🚨 <b>止损设置中止</b>\n\n${instId}\n止损价 ${slPrice} 已被当前价穿越\n⚠️ 仓位无止损保护，请立即手动处理！`);
      return null;
    }
    const algoId = await setStopLoss(instId, closeSide, sz, slPrice, null);
    if (algoId) {
      console.log(`✅ [SL守护] ${instId} 止损设置成功（第${i+1}次尝试）: ${algoId}`);
      pendingSLMap.delete(instId);
      if (global.ledger) {
        global.ledger.updateSl(instId, slPrice);
        global.ledger.updateSlOrder(instId, algoId);
      }
      return algoId;
    }
    if (i < maxRetries - 1) {
      console.log(`⏳ [SL守护] ${instId} 止损失败，${delays[i]/1000}秒后重试...`);
      await sleep(delays[i]);
    }
  }
  // 全部重试失败，加入待止损池
  console.error(`❌ [SL守护] ${instId} ${maxRetries}次重试全部失败，加入待止损池`);
  pendingSLMap.set(instId, { direction, closeSide, sz, slPrice, openTime: Date.now(), retryCount: 0 });
  await sendTG(`⚠️ <b>止损设置失败</b>\n\n${instId} 止损价${slPrice}\n已加入待止损池，将持续重试\n请关注！`);
  return null;
}

// 台账同步成功后，处理待止损池（在 syncWithOKX 成功时调用）
async function flushPendingSL() {
  if (pendingSLMap.size === 0) return;
  console.log(`[SL守护] 处理待止损池: ${pendingSLMap.size} 个`);
  for (const [instId, item] of pendingSLMap.entries()) {
    const algoId = await setStopLossWithRetry(instId, item.direction, item.closeSide, item.sz, item.slPrice, 1);
    if (!algoId) item.retryCount++;
  }
}

// BUG FIX #5: 更新交易记录
function updateTradeRecord(orderId, updates) {
  try {
    const path = CONFIG.logging.historyPath;
    const data = JSON.parse(fs.readFileSync(path, 'utf8') || '{"trades":[]}');
    const idx = data.trades.findIndex(t => t.orderId === orderId);
    if (idx >= 0) {
      data.trades[idx] = { ...data.trades[idx], ...updates };
      fs.writeFileSync(path, JSON.stringify(data, null, 2));
    }
  } catch (e) { console.error('updateTradeRecord失败:', e.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 紧急平仓（指数退避重试，确保仓位关闭）
async function emergencyClose(instId, closeSide, sz, reason, maxRetries = 5) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      // 每次重试前实时查OKX获取真实仓位数量
      let realSz = sz;
      try {
        const livePos = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
        const liveP = (livePos.data || []).find(p => p.instId === instId && parseFloat(p.pos) !== 0);
        if (liveP) {
          realSz = Math.abs(parseFloat(liveP.pos)).toString();
        } else {
          console.log(`ℹ️ 紧急平仓: ${instId} OKX已无仓位，无需平仓`);
          return true;
        }
      } catch (e) { /* 查不到就用传入的sz */ }

      await okxReq('POST', '/api/v5/trade/order', {
        instId, tdMode: 'cross', side: closeSide, ordType: 'market',
        sz: realSz, reduceOnly: 'true'
      });
      console.log(`✅ 紧急平仓成功(第${i+1}次): ${instId}`);
      await sendTG(`🛑 <b>紧急平仓成功</b>\n\n${instId}: ${reason}`);
      return true;
    } catch (e) {
      console.error(`❌ 紧急平仓第${i+1}次失败: ${e.message}`);
      if (i < maxRetries) {
        const delay = 1000 * Math.pow(2, i);
        await sleep(delay);
      }
    }
  }
  console.error(`🔴 紧急平仓彻底失败! ${instId} 需人工介入!`);
  await sendTG(`🔴🔴🔴 <b>紧急平仓失败!</b>\n\n${instId}: ${reason}\n${maxRetries+1}次重试全部失败\n⚠️ 请立即手动平仓!`);
  return false;
}

// ============== 日志 ==============
function saveTradeLog(entry) {
  let history = { trades: [] };
  if (fs.existsSync(CONFIG.logging.historyPath)) {
    try { history = JSON.parse(fs.readFileSync(CONFIG.logging.historyPath, 'utf8')); } catch (e) {}
  }
  history.trades.push({ ...entry, timestamp: new Date().toISOString() });
  if (history.trades.length > 500) history.trades = history.trades.slice(-500);
  fs.writeFileSync(CONFIG.logging.historyPath, JSON.stringify(history, null, 2));
}

// ============== 信号幂等主键（防重复下单） ==============
function buildSignalId(sig) {
  const tsBucket = Math.floor((sig.tsMs || Date.now()) / 90000); // 90秒窗
  const key = [
    String(sig.channelId || sig.source || ''),
    String(sig.author || sig.traderName || ''),
    String(sig.pair || ''),
    String(sig.direction || ''),
    String(Math.round(sig.entry || 0)),
    String(Math.round(sig.sl || 0)),
    String(tsBucket)
  ].join('|').toUpperCase();
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

// 内存去重缓存（补充DB层，防止DB未初始化时重复下单）
const signalIdCache = new Map(); // signalId → timestamp
const SIGNAL_CACHE_TTL = 5 * 60 * 1000; // 5分钟

function isSignalDuplicate(signalId) {
  const now = Date.now();
  // 清理过期缓存
  for (const [id, ts] of signalIdCache) {
    if (now - ts > SIGNAL_CACHE_TTL) signalIdCache.delete(id);
  }
  if (signalIdCache.has(signalId)) return true;
  signalIdCache.set(signalId, now);
  return false;
}

// ============== Signal DB (SQLite持久化) ==============
let signalDb = null;
async function initSignalDb() {
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const dbPath = './data/signal-db.sqlite';
    if (fs.existsSync(dbPath)) {
      signalDb = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      signalDb = new SQL.Database();
    }
    signalDb.run(`CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT,
      timestamp TEXT NOT NULL,
      channel_id TEXT,
      trader_name TEXT,
      raw_text TEXT,
      direction TEXT,
      pair TEXT,
      entry REAL,
      sl REAL,
      tp TEXT,
      source TEXT,
      action TEXT,
      outcome TEXT
    )`);
    signalDb.run(`CREATE INDEX IF NOT EXISTS idx_trader ON signals(trader_name)`);
    signalDb.run(`CREATE INDEX IF NOT EXISTS idx_pair ON signals(pair)`);
    // 幂等唯一索引（signal_id可为NULL，只对非NULL值做唯一约束）
    signalDb.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_signal_id ON signals(signal_id) WHERE signal_id IS NOT NULL`);
    fs.writeFileSync(dbPath, Buffer.from(signalDb.export()));

    // Phase-A: 事件溯源表
    signalDb.run(`CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      timestamp INTEGER,
      trader TEXT,
      channel_id TEXT,
      stage TEXT NOT NULL,
      action TEXT,
      coin TEXT,
      side TEXT,
      entry_px REAL,
      sl_px REAL,
      exec_code TEXT,
      detail TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    signalDb.run(`CREATE INDEX IF NOT EXISTS idx_event_trace ON signal_events(trace_id)`);
    signalDb.run(`CREATE INDEX IF NOT EXISTS idx_event_stage ON signal_events(stage)`);
    signalDb.run(`CREATE INDEX IF NOT EXISTS idx_event_trader ON signal_events(trader)`);
    fs.writeFileSync(dbPath, Buffer.from(signalDb.export()));

    console.log('✅ Signal DB (SQLite) 初始化完成（含幂等索引）');
  } catch (e) {
    console.error('⚠️ Signal DB初始化失败:', e.message);
  }
}

// Phase-A: 事件溯源记录
let _eventWriteCount = 0;
function logTraceEvent(traceId, stage, data = {}) {
  if (!signalDb) return;
  try {
    signalDb.run(
      `INSERT INTO signal_events (trace_id, timestamp, trader, channel_id, stage, action, coin, side, entry_px, sl_px, exec_code, detail, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        traceId,
        Date.now(),
        data.trader || null,
        data.channel_id || null,
        stage,
        data.action || null,
        data.coin || null,
        data.side || null,
        data.entry_px || null,
        data.sl_px || null,
        data.exec_code || null,
        data.detail ? JSON.stringify(data.detail) : null,
        data.error || null
      ]
    );
    _eventWriteCount++;
    // 每50次写入或距上次保存超过5分钟才export（降低IO压力）
    if (_eventWriteCount >= 50) {
      _eventWriteCount = 0;
      try {
        const fs = require('fs');
        fs.writeFileSync('./data/signal-db.sqlite', Buffer.from(signalDb.export()));
      } catch (e) { console.warn('signal_events export失败:', e.message); }
    }
  } catch (e) {
    console.warn(`logTraceEvent失败 [${stage}]: ${e.message}`);
  }
}

function saveToSignalDb(channelId, trader, signal, action) {
  if (!signalDb) return;
  try {
    const sid = signal.signalId || null;
    signalDb.run(
      `INSERT OR IGNORE INTO signals (signal_id, timestamp, channel_id, trader_name, raw_text, direction, pair, entry, sl, tp, source, action)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sid, new Date().toISOString(), channelId, trader,
       (signal.textContent || signal.raw || '').substring(0, 500),
       signal.direction, signal.pair, signal.entry, signal.sl,
       JSON.stringify(signal.tp || []), signal.source, action]
    );
    // 每50条保存一次文件
    const count = signalDb.exec("SELECT COUNT(*) FROM signals")[0]?.values[0][0] || 0;
    if (count % 50 === 0) {
      fs.writeFileSync('./data/signal-db.sqlite', Buffer.from(signalDb.export()));
    }
  } catch (e) { /* 静默，不影响主流程 */ }
}

function saveSignalLog(channelId, trader, signal, action, reject_reason) {
  // SQLite持久化
  saveToSignalDb(channelId, trader, signal, action);
  // JSON持久化（保留兼容）
  let signals = { signals: [] };
  if (fs.existsSync(CONFIG.logging.signalsPath)) {
    try { signals = JSON.parse(fs.readFileSync(CONFIG.logging.signalsPath, 'utf8')); } catch (e) {}
  }
  signals.signals.push({
    timestamp: new Date().toISOString(),
    channelId, trader, 
    text: (signal.textContent || signal.raw || '').substring(0, 300),
    parsedSignal: { direction: signal.direction, pair: signal.pair, entry: signal.entry, sl: signal.sl, tp: signal.tp },
    source: signal.source,
    action,
    reject_reason: reject_reason || null
  });
  if (signals.signals.length > 500) signals.signals = signals.signals.slice(-500);
  fs.writeFileSync(CONFIG.logging.signalsPath, JSON.stringify(signals, null, 2));
}


function getCurrentPositionList() {
  if (!global.ledger || !global.ledger.positions) return [];
  return Array.from(global.ledger.positions.entries())
    .filter(([k, v]) => v && parseFloat(v.contracts) > 0)
    .map(([k, v]) => ({
      instId: k,
      coin: k.replace('-USDT-SWAP', '').replace('-USDT-PERP', '').toUpperCase(),
      direction: v.direction
    }));
}

function classifyFollowupIntent(text, currentPositions = []) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  
  // 前置过滤：开仓信号格式
  const isNewOrderFormat = /trade setup|first entry|second entry|buy setup|sell setup|entry zone/i.test(raw) && /entry/i.test(raw);
  if (isNewOrderFormat) {
    return { action: 'INFO', coin: null, percent: 100, is_be: false, confidence: 0.1, trigger_words: ['new_order_format'], reason: 'NEW_ORDER_FORMAT' };
  }

  const result = { action: 'INFO', coin: null, percent: 100, is_be: false, confidence: 0.3, trigger_words: [] };
  const COINS = ['BTC','ETH','SOL','NEAR','KAITO','BNB','XRP','ADA','DOGE','LINK','AVAX','DOT','MATIC','ARB','OP','SUI','APT','HYPE'];
  const coinRe = new RegExp('(?:\\$)?\\b(' + COINS.join('|') + ')\\b', 'i');
  const cm = raw.match(coinRe);
  if (cm) result.coin = cm[1].toUpperCase();
  const add = (w) => { if (!result.trigger_words.includes(w)) result.trigger_words.push(w); };

  // CANCEL
  if (/cancel|取消上条|ignore previous|撤销/i.test(raw)) { result.action = 'CANCEL'; result.confidence = 0.95; add('cancel'); }

  // UPDATE_SL (breakeven)
  const hasMoveStop = /move sl to breakeven|move stop to|sl to be|止损移保本|移到保本|止损.{0,2}be|sl.{0,2}be|stop loss to entry/i.test(raw);
  const hasBeAndStop = /(breakeven|保本)/i.test(raw) && /(\bsl\b|\bstop\b|止损)/i.test(raw);
  if (hasMoveStop || hasBeAndStop) {
    result.action = 'UPDATE_SL'; result.is_be = true; result.confidence = 0.9;
    add(hasMoveStop ? 'move sl/stop' : 'breakeven+stop');
  }

  // CLOSE — 黑名单先判断（UPDATE_SL优先，不被覆盖）
  const isBlacklisted = /close to|not close|will close|close above|close below|already closed|已达到|已触发|tp\d+ hit|tp hit|tp\d+ on/i.test(raw);
  if (isBlacklisted) {
    result.action = 'INFO'; result.confidence = 0.2; add('close_blacklist');
  } else if (result.action !== 'UPDATE_SL' && (/close all|全部平仓|平仓|exit now|close position/i.test(raw) || /\bclose now\b/i.test(raw) || /\ball positions\b/i.test(raw))) {
    result.action = 'CLOSE'; result.confidence = 0.92; add('close');
  }

  // PARTIAL_TP
  if (/close \d+%|take \d+%|partial close|分批止盈|tp hit|take profit/i.test(raw)) {
    result.action = 'PARTIAL_TP';
    const pm = raw.match(/(\d+)\s*%/);
    if (pm) result.percent = Math.max(1, Math.min(100, parseInt(pm[1])));
    result.confidence = 0.88; add('partial_tp');
  }

  if (result.trigger_words.length === 0) { result.action = 'UNKNOWN'; result.confidence = 0.1; result.reason_code = 'NO_TRIGGER_MATCH'; }

  const pos = Array.isArray(currentPositions) ? currentPositions : [];
  if (result.coin) {
    const matched = pos.find(p => String(p.coin || '').toUpperCase() === result.coin);
    result.matchedPosition = matched ? matched.instId : null;
    if (!matched && ['UPDATE_SL','PARTIAL_TP','CLOSE','CANCEL','REVERSE'].includes(result.action)) {
      result.confidence = Math.max(0.35, result.confidence - 0.35);
      result.reason_code = result.reason_code || 'NO_POSITION_MATCH';
    }
  } else {
    if (pos.length === 1) {
      result.coin = String(pos[0].coin || '').toUpperCase() || null;
      result.matchedPosition = pos[0].instId || null;
      result.confidence = Math.max(0.1, result.confidence - 0.2);
    } else if (pos.length > 1 && ['UPDATE_SL','PARTIAL_TP','CLOSE','CANCEL','REVERSE'].includes(result.action)) {
      const isCloseAll = result.action === 'CLOSE' && (/close all/i.test(raw) || /all positions/i.test(raw) || /全部平仓/.test(raw));
      if (isCloseAll) {
        result.matchedPosition = 'ALL'; result.reason = 'CLOSE_ALL_EXPLICIT';
      } else {
        result.action = 'UNKNOWN'; result.reason = 'AMBIGUOUS_FOLLOWUP';
        result.reason_code = 'AMBIGUOUS_FOLLOWUP'; result.confidence = 0.15; result.matchedPosition = null;
      }
    }
  }
  return result;
}

async function executeUpdateSL(instId, traderName, intent) {
  // 1) 查当前持仓
  const pos = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
  const livePos = (pos.data || []).find(p => p.instId === instId && parseFloat(p.pos) !== 0);
  if (!livePos) return { success: false, error: 'NO_LIVE_POSITION' };

  // 2) 计算保本价（加手续费偏移 0.08%）
  const avgPx = parseFloat(livePos.avgPx || '0');
  if (!avgPx || Number.isNaN(avgPx)) return { success: false, error: 'RETRY_AVG_PX_ZERO', retryable: true };
  const isBuy = parseFloat(livePos.pos) > 0;

  // Patch1: tickSz精度对齐
  let tickSz = 0.1; // 默认值
  try {
    const insData = await okxReq('GET', '/api/v5/public/instruments', null, { instType: 'SWAP', instId });
    tickSz = Number(insData.data?.[0]?.tickSz) || 0.1;
  } catch (e) { console.warn('tickSz查询失败，使用默认0.1:', e.message); }
  const rawBe = isBuy ? avgPx * 1.0008 : avgPx * 0.9992;
  const q = rawBe / tickSz;
  const be = (isBuy ? Math.ceil(q) : Math.floor(q)) * tickSz; // 多单上取整保护，空单下取整保护
  const dp = (String(tickSz).split('.')[1] || '').length;
  const bePx = be.toFixed(dp);

  // 3) 查当前止损算法单
  const algoOrders = await okxReq('GET', '/api/v5/trade/orders-algo-pending', null, { instId, ordType: 'conditional' });
  const slOrder = (algoOrders.data || []).find(o => o.slTriggerPx && o.instId === instId);

  if (slOrder) {
    // 4a) amend 现有止损
    const amendResult = await okxReq('POST', '/api/v5/trade/amend-algo-order', {
      instId, algoId: slOrder.algoId, newSlTriggerPx: bePx, newSlOrdPx: '-1'
    });

    // Patch2: 硬口径 - 只认confirmed=true
    if (amendResult.code !== '0') {
      // 参数类错误（510xx）不重试
      const errCode = String(amendResult.code || '');
      if (errCode.startsWith('51') && errCode.length >= 4) {
        return { success: false, confirmed: false, bePx, algoId: slOrder.algoId, error: `PARAM_ERROR:${amendResult.msg}` };
      }
      // 其他错误交给上层策略处理
      return { success: false, confirmed: false, bePx, algoId: slOrder.algoId, error: amendResult.msg || 'AMEND_FAILED' };
    }

    // 带jitter的3次确认重试
    let confirmed = false;
    const delays = [200, 500, 1200];
    for (let i = 0; i < 3 && !confirmed; i++) {
      const jitter = Math.floor(Math.random() * 100);
      await new Promise(r => setTimeout(r, delays[i] + jitter));
      try {
        const verify = await okxReq('GET', '/api/v5/trade/orders-algo-pending', null, { instId, algoId: slOrder.algoId });
        const updated = verify.data?.[0];
        if (updated) {
          confirmed = Math.abs(Number(updated.slTriggerPx) - Number(bePx)) <= Math.max(Number(tickSz) / 2, 1e-8); // 太尉要求: tickSz/2精度
        }
      } catch (e) {
        console.warn(`amend verify retry ${i+1} failed: ${e.message}`);
      }
    }

    if (!confirmed) {
      return { success: false, confirmed: false, bePx, algoId: slOrder.algoId, error: 'AMEND_NOT_CONFIRMED' };
    }

    return { success: true, confirmed: true, bePx, algoId: slOrder.algoId, error: null };
  }

  // 4b) 无现有止损则新挂
  const sz = Math.abs(parseFloat(livePos.pos)).toString();
  const closeSide = isBuy ? 'sell' : 'buy';
  const newSL = await okxReq('POST', '/api/v5/trade/order-algo', {
    instId,
    tdMode: 'cross',
    side: closeSide,
    ordType: 'conditional',
    sz,
    slTriggerPx: bePx,
    slOrdPx: '-1',
    slTriggerPxType: 'mark',
    reduceOnly: 'true'
  });

  return {
    success: newSL.code === '0',
    bePx,
    confirmed: null,
    algoId: newSL.data?.[0]?.algoId,
    error: newSL.code === '0' ? null : (newSL.msg || 'CREATE_SL_FAILED')
  };
}

async function executeClose(instId, traderName, intent) {
  // instId === 'ALL' 时全平所有（仅在 classifyFollowupIntent 明确 close all 下进入）
  if (intent?.matchedPosition === 'ALL' || instId === 'ALL') {
    const pos = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
    const positions = (pos.data || []).filter(p => parseFloat(p.pos) !== 0);
    if (positions.length === 0) return { success: true, results: [], requested_all: true, closed_count: 0, remaining_count: 0 };

    // Patch3: 并发平仓
    const closeOne = async (p) => {
      const sz = Math.abs(parseFloat(p.pos)).toString();
      const side = parseFloat(p.pos) > 0 ? 'sell' : 'buy';
      try {
        const r = await okxReq('POST', '/api/v5/trade/order', {
          instId: p.instId, tdMode: 'cross', side, ordType: 'market', sz, reduceOnly: 'true'
        });
        return { instId: p.instId, success: r.code === '0', ordId: r.data?.[0]?.ordId, error: r.code === '0' ? null : (r.msg || 'CLOSE_FAILED') };
      } catch (e) {
        return { instId: p.instId, success: false, error: e.message };
      }
    };
    const results = await Promise.all(positions.map(closeOne));

    // 二次核验：检查是否还有剩余仓位
    await new Promise(r => setTimeout(r, 1500));
    const pos2 = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
    let remaining = (pos2.data || []).filter(p => parseFloat(p.pos) !== 0);

    if (remaining.length > 0) {
      // 再尝试一次
      const retryResults = await Promise.all(remaining.map(closeOne));
      results.push(...retryResults);
      await new Promise(r => setTimeout(r, 1000));
      const pos3 = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
      remaining = (pos3.data || []).filter(p => parseFloat(p.pos) !== 0);
    }

    const closedCount = positions.length - remaining.length;
    if (remaining.length > 0) {
      // 区分幻影残仓（结算延迟，pos极小）和真实残仓
      const realRemaining = remaining.filter(p => Math.abs(parseFloat(p.pos)) >= 1);
      if (realRemaining.length > 0) {
        // 真实残仓 → 高优先级告警
        await sendTG(`🚨 <b>全平部分失败（高优先级）</b>\n\n请求平仓: ${positions.length}个\n已平: ${closedCount}个\n❌ 剩余: ${realRemaining.map(p => p.instId).join(', ')}`);
        return { success: false, results, error: 'CLOSE_ALL_PARTIAL', requested_all: true, closed_count: closedCount, remaining_count: realRemaining.length, remaining: realRemaining.map(p => p.instId) };
      } else {
        // 幻影残仓（结算延迟）→ info级别不触发告警风暴
        console.log(`ℹ️ [CLOSE_ALL] 幻影残仓疑似结算延迟: ${remaining.map(p => p.instId + ':' + p.pos).join(', ')}`);
        await sendTG(`ℹ️ <b>全平完成（极小残仓，疑似结算延迟）</b>\n\n${remaining.map(p => p.instId + ':' + p.pos).join(', ')}`);
      }
    }
    return { success: true, results, requested_all: true, closed_count: closedCount, remaining_count: 0 };
  }

  // 单币种平仓
  const pos = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
  const livePos = (pos.data || []).find(p => p.instId === instId && parseFloat(p.pos) !== 0);
  if (!livePos) return { success: false, error: 'NO_LIVE_POSITION' };

  const sz = Math.abs(parseFloat(livePos.pos)).toString();
  const side = parseFloat(livePos.pos) > 0 ? 'sell' : 'buy';
  const r = await okxReq('POST', '/api/v5/trade/order', {
    instId,
    tdMode: 'cross',
    side,
    ordType: 'market',
    sz,
    reduceOnly: 'true'
  });

  return {
    success: r.code === '0',
    ordId: r.data?.[0]?.ordId,
    sz,
    error: r.code === '0' ? null : (r.msg || 'CLOSE_FAILED')
  };
}

async function logFollowupShadow(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    await fs.promises.appendFile(FOLLOWUP_LOG, line, 'utf8');
  } catch (e) {
    console.error(`⚠️ Followup shadow日志写入失败: ${e.message}`);
  }
}

// ============== 处理 Discord 消息 ==============
async function handleDiscordMessage(message) {
  const channelId = message.channel.id;
  const channelConfig = CONFIG.channels[channelId];
  if (!channelConfig) return;
  
  const trader = channelConfig.name;
  const group = channelConfig.group;

  const traceId = message.id; // Discord Snowflake ID = 天然TraceID
  logTraceEvent(traceId, 'RECEIVED', { trader: message.author?.username, channel_id: message.channel?.id });
  
  // 提取文字内容（优先 embed）
  let textPreview = '';
  if (message.embeds?.[0]?.description) {
    textPreview = message.embeds[0].description.split('----------------------')[0].trim();
  }
  if (!textPreview) textPreview = message.content || '';
  
  // 过滤太短的消息
  if (textPreview.length < 3 && !message.embeds?.some(e => e.image) && message.attachments?.size === 0) return;
  
  // 过滤纯链接
  if (/^https?:\/\/\S+$/i.test(textPreview.trim())) return;
  
  console.log(`\n📨 [${group}/${trader}] ${textPreview.substring(0, 80)}${textPreview.length > 80 ? '...' : ''}`);
  
  // WG Bot 特殊处理
  if (message.author.username === 'WG Bot') {
    const wgSignal = visionParser.parseWGBotMessage(textPreview);
    if (wgSignal.type) {
      console.log(`🤖 [WG Bot] ${wgSignal.pair} ${wgSignal.type}`);
      await sendTG(
        `🤖 <b>WG Bot 通知</b>\n\n` +
        `${wgSignal.direction === 'buy' ? '📈' : '📉'} ${wgSignal.pair} — ${wgSignal.type}\n` +
        `原始: ${textPreview}`
      );
      saveSignalLog(channelId, 'WG Bot', { raw: textPreview, source: 'wg_bot' }, wgSignal.type);
    }
    return;
  }
  
  // 完整解析（文字 + 视觉AI）
  // 汇总bot多行信号处理（合约持仓-bot/开仓策略-bot）
  // 消息格式：每行一个信号 "- 做多: **HYPE** | **入场:** 27.62 | **止损:** 25.5"
  // 多行信号只取第一个完整可执行行，避免不同币种entry混搭
  const isAggBotMsg = ['合约持仓-bot', '开仓策略-bot'].includes(trader);
  if (isAggBotMsg && (textPreview.includes('做多') || textPreview.includes('做空'))) {
    const lines = textPreview.split('\n').filter(l => /做多|做空/i.test(l));
    if (lines.length > 1) {
      // 多行信号：逐行解析，找第一个完整可执行信号
      let bestLine = null;
      for (const line of lines) {
        const lineSignal = visionParser.parseTextSignal(line);
        if (lineSignal.pair && lineSignal.direction && lineSignal.entry && lineSignal.sl) {
          bestLine = line;
          break;
        }
      }
      if (bestLine) {
        // 用单行替代整段文本，通过_overrideText传入解析器
        textPreview = bestLine;
        message._overrideText = bestLine;
        console.log(`🔀 [${trader}] 多行信号提取: ${bestLine.substring(0, 60)}`);
      }
    }
  }

  const signal = await visionParser.parseDiscordMessage(message, trader);
  logTraceEvent(traceId, 'PARSED', { trader, coin: signal.coin, side: signal.side, entry_px: signal.entry, sl_px: signal.sl, detail: { tp: signal.tp, leverage: signal.leverage } });
  const textContent = String(message._overrideText || textPreview || message.content || '');

  // 后续信号分类（Phase-1 影子模式）
  const followupIntent = classifyFollowupIntent(textContent, getCurrentPositionList());
  logTraceEvent(traceId, 'FOLLOWUP', { trader, action: followupIntent.action, coin: followupIntent.coin, detail: { confidence: followupIntent.confidence, trigger_words: followupIntent.trigger_words, matched: followupIntent.matchedPosition, reason: followupIntent.reason } });
  if (followupIntent.action !== 'INFO' && followupIntent.action !== 'UNKNOWN') {
    // 有意图信号，记录影子日志
    const matched = followupIntent.coin
      ? `${followupIntent.coin}-USDT-SWAP`
      : (followupIntent.matchedPosition || null);
    const followupEntry = {
      ts: Date.now(),
      trader,
      channelId,
      text_preview: textContent.substring(0, 80),
      intent: followupIntent,
      matched_position: matched,
      would_execute: !FOLLOWUP_SHADOW,
      shadow_reason: FOLLOWUP_SHADOW ? 'FOLLOWUP_SHADOW=true' : 'live',
      reason_code: (
        followupIntent.action === 'UNKNOWN' && followupIntent.matchedPosition === null ? 'AMBIGUOUS_FOLLOWUP' :
        (followupIntent.trigger_words || []).includes('close_blacklist') ? 'BLACKLIST_HIT' :
        !matched ? 'NO_POSITION_MATCH' :
        followupIntent.action === 'UNKNOWN' ? 'UNKNOWN_INTENT' : 'OK'
      )
    };
    await logFollowupShadow(followupEntry);
    console.log(`🔍 [FollowupShadow] ${trader} ${followupIntent.action} coin=${followupIntent.coin || '?'} conf=${followupIntent.confidence} matched=${matched || 'none'}`);

    if (FOLLOWUP_SHADOW) {
      // 影子模式：只记录不执行，不return，保持旧逻辑
    } else if (['UPDATE_SL', 'CLOSE'].includes(followupIntent.action) && matched) {
      // Phase-2 执行层
      // Patch5: 幂等锁 — 同一message_id+action只执行一次
      const dedupKey = `${message.id || ''}:${followupIntent.action}:${matched}`;
      if (FOLLOWUP_EXEC_DEDUP.has(dedupKey)) {
        console.log(`⏭️ [FollowupExec] 幂等拦截: ${dedupKey}`);
        logTraceEvent(traceId, 'DEDUP_HIT', { trader, action: followupIntent.action, detail: { key: dedupKey || bizKey } });
        return;
      }
      FOLLOWUP_EXEC_DEDUP.set(dedupKey, Date.now());

      // 业务级去重：trader+instId+action 10秒窗口（防同内容双发不同message_id）
      const bizKey = `${trader}:${matched}:${followupIntent.action}`;
      const bizTs = FOLLOWUP_EXEC_DEDUP.get('biz:' + bizKey);
      if (bizTs && Date.now() - bizTs < 10000) {
        console.log(`⏭️ [FollowupExec] 业务去重拦截(10s): ${bizKey}`);
        logTraceEvent(traceId, 'DEDUP_HIT', { trader, action: followupIntent.action, detail: { key: dedupKey || bizKey } });
        return;
      }
      FOLLOWUP_EXEC_DEDUP.set('biz:' + bizKey, Date.now());
      // 清理超过5分钟的旧key
      const now = Date.now();
      for (const [k, ts] of FOLLOWUP_EXEC_DEDUP) {
        if (now - ts > 5 * 60 * 1000) FOLLOWUP_EXEC_DEDUP.delete(k);
      }
      try {
        let execResult;
        if (followupIntent.action === 'UPDATE_SL') {
          execResult = await executeUpdateSL(matched, trader, followupIntent);
          if (execResult.success) {
            console.log(`✅ [FollowupExec] UPDATE_SL成功: ${matched} bePx=${execResult.bePx} confirmed=${execResult.confirmed}`);
            await sendTG(
              `✅ <b>止损已移到保本</b>\n\n交易员: ${trader}\n${matched}\n保本价: ${execResult.bePx}\n确认: ${execResult.confirmed ? '✅' : '⚠️待确认'}`
            );
          } else {
            await sendTG(`⚠️ <b>止损移保本失败</b>\n\n${trader} ${matched}: ${execResult.error || '未知错误'}`);
          }
        } else if (followupIntent.action === 'CLOSE') {
          execResult = await executeClose(matched, trader, followupIntent);
          if (execResult.success) {
            console.log(`✅ [FollowupExec] CLOSE成功: ${matched}`);
            await sendTG(`✅ <b>平仓已执行</b>\n\n交易员: ${trader}\n${matched}`);
          } else {
            await sendTG(`⚠️ <b>平仓失败</b>\n\n${trader} ${matched}: ${execResult.error || '未知错误'}`);
          }
        }

        logTraceEvent(traceId, execResult.success ? 'CONFIRMED' : 'FAILED', { trader, action: followupIntent.action, coin: followupIntent.coin, exec_code: execResult.success ? 'OK' : execResult.error, detail: execResult });

        if (execResult?.success) {
          FOLLOWUP_ERR_COUNT = 0; // 成功清零
          // 断路器半开期间：健康探测计数，达2次才真正恢复
          if (FOLLOWUP_SHADOW && !FOLLOWUP_RECOVER_TIMER) {
            FOLLOWUP_HEALTH_COUNT = (FOLLOWUP_HEALTH_COUNT || 0) + 1;
            if (FOLLOWUP_HEALTH_COUNT >= 2) {
              FOLLOWUP_SHADOW = false;
              FOLLOWUP_HEALTH_COUNT = 0;
              console.log('✅ [FollowupExec] 断路器恢复：2次健康探测通过');
              sendTG('✅ <b>断路器恢复</b>\n\nFOLLOWUP_SHADOW=false（2次健康探测通过）');
            }
          } else {
            FOLLOWUP_HEALTH_COUNT = 0;
          }
        }

        await logFollowupShadow({
          ...followupEntry,
          ts_exec: Date.now(),
          executed: true,
          exec_result: execResult
        });
      } catch (e) {
        console.error(`❌ [FollowupExec] 执行异常: ${e.message}`);
        // Patch4: 断路器 — 连续3次失败才降级，30分钟自动恢复
        FOLLOWUP_ERR_COUNT++;
        if (FOLLOWUP_ERR_COUNT >= 3) {
          logTraceEvent(traceId, 'CIRCUIT_TRIP', { trader, error: e.message, detail: { err_count: FOLLOWUP_ERR_COUNT } });
          FOLLOWUP_SHADOW = true;
          if (!FOLLOWUP_RECOVER_TIMER) {
            // 30分钟后进入半开状态（half-open），需2次健康探测才真正恢复
            FOLLOWUP_RECOVER_TIMER = setTimeout(() => {
              FOLLOWUP_RECOVER_TIMER = null;
              console.log('🔄 [FollowupExec] 断路器半开：等待健康探测');
              sendTG('⏳ <b>断路器半开</b>\n\n30分钟冷却完成，等待2次健康探测后恢复');
            }, 30 * 60 * 1000);
          }
        }
        await sendTG(
          `❌ <b>后续信号执行异常</b>\n\n${trader} ${matched}: ${e.message}\n` +
          `🛡️ 已自动回滚：FOLLOWUP_SHADOW=true`
        );
        await logFollowupShadow({
          ...followupEntry,
          ts_exec: Date.now(),
          executed: false,
          rollback_shadow: true,
          exec_error: e.message
        });
      }
      return; // 执行完不走后续开仓/更新流程
    }
  }
  
  // 平仓指令
  // 平仓指令 — 查台账 → 执行 OKX 平仓
  if (signal.isClose && signal.pair) {
    console.log(`🔄 [${trader}] 平仓: ${signal.pair}`);
    saveSignalLog(channelId, trader, signal, 'CLOSE');
    
    const instId = `${signal.pair.replace('/', '-')}-SWAP`;
    const ledgerPos = global.ledger ? global.ledger.getPosition(instId) : null;
    
    if (ledgerPos) {
      // 台账有记录，平仓前实时查OKX获取真实仓位数量
      const closeSide = ledgerPos.direction === 'buy' ? 'sell' : 'buy';
      try {
        // 实时查OKX确认仓位（防止台账与实际不符）
        let realContracts = ledgerPos.contracts.toString();
        try {
          const livePos = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
          const liveP = (livePos.data || []).find(p => p.instId === ledgerPos.instId && parseFloat(p.pos) !== 0);
          if (liveP) {
            realContracts = Math.abs(parseFloat(liveP.pos)).toString();
            console.log(`📊 [${trader}] 实时仓位确认: ${ledgerPos.instId} ${realContracts}张 (台账:${ledgerPos.contracts})`);
          } else {
            console.log(`⚠️ [${trader}] OKX无此仓位: ${ledgerPos.instId}，可能已平仓`);
            if (global.ledger) global.ledger.positions.delete(ledgerPos.instId);
            await sendTG(`ℹ️ <b>平仓信号</b>\n\n${signal.pair} OKX已无仓位，台账已清理`);
            return;
          }
        } catch (e) {
          console.log(`⚠️ 实时查仓失败(${e.message})，使用台账数量: ${realContracts}`);
        }

        const closeResult = await okxReq('POST', '/api/v5/trade/order', {
          instId: ledgerPos.instId, tdMode: 'cross', side: closeSide,
          ordType: 'market', sz: realContracts, reduceOnly: 'true'
        });
        if (closeResult.code === '0') {
          console.log(`✅ [${trader}] 平仓成功: ${ledgerPos.instId}`);
          // 平仓成功后清理台账
          if (global.ledger) global.ledger.positions.delete(ledgerPos.instId);
          await sendTG(
            `✅ <b>平仓已执行</b>\n\n交易员: ${trader} (${group})\n` +
            `币种: ${ledgerPos.instId}\n方向: ${ledgerPos.direction === 'buy' ? '多→平' : '空→平'}\n` +
            `张数: ${realContracts}\n订单: <code>${closeResult.data?.[0]?.ordId || 'OK'}</code>`
          );
        } else {
          console.error(`❌ 平仓失败: ${closeResult.msg}`);
          await sendTG(`❌ <b>平仓失败</b>\n\n${ledgerPos.instId}: ${closeResult.msg}\n⚠️ 请手动平仓！`);
        }
      } catch (e) {
        console.error(`❌ 平仓异常: ${e.message}`);
        await sendTG(`❌ <b>平仓异常</b>\n\n${ledgerPos.instId}: ${e.message}\n⚠️ 请手动平仓！`);
      }
    } else {
      // 台账无记录，尝试直接查OKX
      const instId = `${signal.pair.replace('/', '-')}-SWAP`;
      try {
        const livePos = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
        const liveP = (livePos.data || []).find(p => p.instId === instId && parseFloat(p.pos) !== 0);
        if (liveP) {
          // OKX有仓位但台账没记录，仍然执行平仓
          const sz = Math.abs(parseFloat(liveP.pos)).toString();
          const dir = parseFloat(liveP.pos) > 0 ? 'buy' : 'sell';
          const closeSide = dir === 'buy' ? 'sell' : 'buy';
          console.log(`⚠️ [${trader}] 台账无记录但OKX有仓位，执行平仓: ${instId} ${sz}张`);
          const closeResult = await okxReq('POST', '/api/v5/trade/order', {
            instId, tdMode: 'cross', side: closeSide, ordType: 'market', sz, reduceOnly: 'true'
          });
          if (closeResult.code === '0') {
            await sendTG(`✅ <b>平仓已执行（OKX直查）</b>\n\n交易员: ${trader}\n${instId} ${sz}张\n订单: <code>${closeResult.data?.[0]?.ordId || 'OK'}</code>`);
          } else {
            await sendTG(`❌ <b>平仓失败</b>\n\n${instId}: ${closeResult.msg}\n⚠️ 请手动平仓！`);
          }
        } else {
          await sendTG(
            `🔄 <b>平仓信号（无持仓）</b>\n\n交易员: ${trader} (${group})\n币种: ${signal.pair}\n` +
            `OKX和台账均无此仓位\n原始: ${textPreview.substring(0, 200)}`
          );
        }
      } catch (e) {
        await sendTG(`🔄 <b>平仓信号（台账无记录）</b>\n\n交易员: ${trader}\n${signal.pair}\n原始: ${textPreview.substring(0, 200)}`);
      }
    }
    return;
  }
  
  // 更新止盈止损 — 查台账 → 执行 OKX 修改
  if (signal.isUpdate && signal.pair) {
    console.log(`🔄 [${trader}] 更新: ${signal.pair}`);
    saveSignalLog(channelId, trader, signal, 'UPDATE');
    
    const instId = `${signal.pair.replace('/', '-')}-SWAP`;
    const ledgerPos = global.ledger ? global.ledger.getPosition(instId) : null;
    
    if (ledgerPos) {
      const results = [];
      
      // 更新止损
      if (signal.sl) {
        try {
          // 先取消旧止损
          if (ledgerPos.slOrderId) {
            await okxReq('POST', '/api/v5/trade/cancel-algos', [{
              instId: ledgerPos.instId, algoId: ledgerPos.slOrderId
            }]);
            console.log(`🗑️ 旧止损已取消: ${ledgerPos.slOrderId}`);
          }
          // 挂新止损
          const closeSide = ledgerPos.direction === 'buy' ? 'sell' : 'buy';
          const newSlId = await setStopLoss(
            ledgerPos.instId, closeSide,
            ledgerPos.contracts.toString(), signal.sl, ledgerPos.orderId
          );
          if (newSlId) {
            global.ledger.updateSl(ledgerPos.instId, signal.sl);
            global.ledger.updateSlOrder(ledgerPos.instId, newSlId);
            results.push(`✅ 止损: ${signal.sl}`);
          } else {
            results.push(`❌ 止损设置失败`);
          }
        } catch (e) {
          results.push(`❌ 止损异常: ${e.message}`);
        }
      }
      
      // 更新止盈（如果有新 TP）
      if (signal.tp?.length > 0) {
        const closeSide = ledgerPos.direction === 'buy' ? 'sell' : 'buy';
        // 先查并取消旧的TP algo orders
        try {
          const pendingAlgos = await okxReq('GET', '/api/v5/trade/orders-algo-pending', null, {
            ordType: 'conditional', instType: 'SWAP', instId: ledgerPos.instId
          });
          const tpAlgos = (pendingAlgos.data || []).filter(a => a.tpTriggerPx && a.tpTriggerPx !== '' && (!a.slTriggerPx || a.slTriggerPx === ''));
          for (const algo of tpAlgos) {
            try {
              await okxReq('POST', '/api/v5/trade/cancel-algos', [{ instId: ledgerPos.instId, algoId: algo.algoId }]);
              console.log(`🗑️ 旧止盈已取消: ${algo.algoId} (TP@${algo.tpTriggerPx})`);
            } catch (e) { console.log(`⚠️ 取消旧TP失败: ${e.message}`); }
          }
        } catch (e) {
          console.log(`⚠️ 查询旧TP失败: ${e.message}`);
        }
        // 挂新TP
        // 实时查OKX获取真实持仓数量
        let tpSz = ledgerPos.contracts.toString();
        try {
          const livePos = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });
          const liveP = (livePos.data || []).find(p => p.instId === ledgerPos.instId && parseFloat(p.pos) !== 0);
          if (liveP) tpSz = Math.abs(parseFloat(liveP.pos)).toString();
        } catch (e) {}
        for (let i = 0; i < signal.tp.length; i++) {
          try {
            const tpResult = await okxReq('POST', '/api/v5/trade/order-algo', {
              instId: ledgerPos.instId, tdMode: 'cross', side: closeSide,
              ordType: 'conditional', sz: tpSz,
              tpTriggerPx: signal.tp[i].toString(), tpOrdPx: '-1',
              tpTriggerPxType: 'mark', reduceOnly: 'true'
            });
            if (tpResult.code === '0') {
              results.push(`✅ 止盈${i+1}: ${signal.tp[i]}`);
            } else {
              results.push(`❌ 止盈${i+1}失败: ${tpResult.msg}`);
            }
          } catch (e) {
            results.push(`❌ 止盈${i+1}异常: ${e.message}`);
          }
        }
      }
      
      await sendTG(
        `🔄 <b>SL/TP 已更新</b>\n\n交易员: ${trader} (${group})\n币种: ${ledgerPos.instId}\n` +
        `${results.join('\n')}`
      );
    } else {
      await sendTG(
        `🔄 <b>SL/TP 更新（未持仓）</b>\n\n交易员: ${trader} (${group})\n币种: ${signal.pair}\n` +
        `${signal.sl ? `新止损: ${signal.sl}\n` : ''}` +
        `${signal.tp?.length > 0 ? `新止盈: ${signal.tp.join(', ')}\n` : ''}` +
        `台账中无此仓位，跳过执行`
      );
    }
    return;
  }
  
  // 新开仓信号
  // 低质量/纯图片交易员（weight≤0.1）解析不完整时静默跳过，不写日志不通知
  const traderCfg = Object.values(CONFIG.channels).find(c => c.name === trader);
  const traderBaseWeight = traderCfg?.weight || 1.0;
  const isSilentTrader = traderBaseWeight <= 0.1;

  if (!signal.direction || !signal.pair) {
    if (signal.source !== 'none') {
      if (!isSilentTrader) {
        console.log(`ℹ️ [${trader}] 部分信息: pair=${signal.pair} dir=${signal.direction} (来源: ${signal.source})`);
        if (signal.pair || signal.direction) {
          evolution.recordFailedParse(trader, textPreview, `不完整: pair=${signal.pair} dir=${signal.direction}`);
          evolution.updateTraderStats(trader, { type: 'parse_fail', notes: '信号不完整' });
        }
      }
      // 低质量交易员静默跳过，不记录不通知
    }
    return;
  }
  
  console.log(`\n🎯 [${trader}] 新信号: ${signal.pair} ${signal.direction.toUpperCase()} @ ${signal.entry || '?'} | SL: ${signal.sl || '?'} | 来源: ${signal.source}`);
  
  // ===== 前置：信号时效检查（避免浪费风控API调用）=====
  const signalAgeMs = Date.now() - (message.createdTimestamp || Date.now());
  const signalAgeMin = signalAgeMs / 1000 / 60;
  if (signalAgeMin > 5) {
    console.log(`⏱️ [${trader}] 信号过期 ${signalAgeMin.toFixed(1)}分钟（阈值5分钟），跳过`);
    return;
  }

  // ===== 进化1：重复信号防护 =====
  if (isDuplicateSignal(message.id, signal.pair, signal.direction, signal.entry, signal.raw || textPreview, trader)) {
    console.log(`🔁 [${trader}] 信号已处理，跳过`);
    return;
  }

  // ===== 幂等主键：signalId 防重复下单 =====
  signal.signalId = buildSignalId({
    channelId, author: trader,
    pair: signal.pair, direction: signal.direction,
    entry: signal.entry, sl: signal.sl,
    tsMs: Date.now()
  });
  if (isSignalDuplicate(signal.signalId)) {
    console.log(`🔑 [${trader}] signalId重复，已跳过: ${signal.signalId}`);
    return;
  }

  // ===== 进化2：Vision SL=0 过滤 =====
  // Vision解析时SL=0意味着图片中没有找到止损位，不是真正的止损=0
  if (signal.source && signal.source.includes('vision') && (!signal.sl || signal.sl === 0)) {
    console.log(`🚫 [${trader}] Vision解析未找到止损位，拒绝`);
    evolution.recordFailedParse(trader, textPreview, 'Vision未解析到SL');
    return;
  }

  // ===== 白名单过滤（实盘模式：只做主流高流动性币种）=====
  if (signal.pair && !CONFIG.okx.useDemo) {
    const whitelist = CONFIG.trading.coinWhitelist || [];
    if (whitelist.length > 0 && !whitelist.includes(signal.pair)) {
      console.log(`🚫 [${trader}] ${signal.pair} 不在实盘白名单，跳过（白名单: ${whitelist.join(',')}）`);
      return;
    }
  }

  // ===== 进化3：OKX合约存在性验证 =====
  // 山寨币/现货币种在OKX没有SWAP合约，提前验证避免下单报错
  if (signal.pair) {
    const instId = `${signal.pair.replace('/', '-')}-SWAP`;
    const contractCheck = await getContractInfo(instId);
    if (!contractCheck) {
      console.log(`🚫 [${trader}] OKX无此合约: ${instId}，跳过`);
      evolution.recordFailedParse(trader, textPreview, `OKX无合约: ${instId}`);
      return;
    }
  }

  // ===== 进化4：限价单陈旧信号过滤（防止合约持仓-bot等反复推送失效挂单）=====
  if (signal.entry && signal.pair) {
    try {
      const instId = `${signal.pair.replace('/', '-')}-SWAP`;
      const tickerData = await okxReq('GET', `/api/v5/market/ticker?instId=${instId}`);
      const markPx = parseFloat(tickerData.data?.[0]?.last || 0);
      if (markPx > 0) {
        const deviation = Math.abs(signal.entry - markPx) / markPx;
        // 限价单偏离超过8%视为陈旧信号，直接丢弃（不进入风控，省API调用）
        if (deviation > 0.08) {
          console.log(`🚫 [${trader}] 限价单陈旧: entry=${signal.entry} 偏离市价${(deviation*100).toFixed(1)}% > 8%，跳过`);
          evolution.recordFailedParse(trader, textPreview, `陈旧限价单: entry偏离${(deviation*100).toFixed(1)}%`);
          return;
        }
      }
    } catch (e) { /* 查价失败不影响流程 */ }
  }
  
  saveSignalLog(channelId, trader, signal, 'NEW_SIGNAL');
  
  // 通知收到信号
  const sourceEmoji = signal.source === 'vision+text' ? '🖼️ 图片+文字' : 
                      signal.source === 'text' ? '📝 纯文字' : '📝 ' + signal.source;
  await sendTG(
    `📨 <b>新交易信号</b>\n\n` +
    `交易员: ${trader} (${group})\n` +
    `币种: ${signal.pair}\n` +
    `方向: ${signal.direction.toUpperCase()}\n` +
    `入场: ${signal.entry || '未知'}\n` +
    `止损: ${signal.sl || '⚠️ 未设置'}\n` +
    `止盈: ${signal.tp?.length > 0 ? signal.tp.join(', ') : '未设置'}\n` +
    `杠杆: ${signal.leverage || CONFIG.trading.defaultLeverage + 'x'}\n` +
    `来源: ${sourceEmoji}\n` +
    (signal.visionNotes ? `\n🔍 AI分析: ${signal.visionNotes}` : '') +
    `\n\n🛡️ 正在进行风控分析...`
  );
  
  // ===== 进化：无TP自动推算 =====
  // 很多交易员不给TP，但信号本身质量好。基于SL距离自动推算最小TP（RR=2.0）
  if ((!signal.tp || signal.tp.length === 0) && signal.entry && signal.sl) {
    const risk = Math.abs(signal.entry - signal.sl);
    const minTP = signal.direction === 'buy'
      ? signal.entry + risk * 2.0   // 多单TP在入场价上方 2倍风险
      : signal.entry - risk * 2.0;  // 空单TP在入场价下方 2倍风险
    signal.tp = [parseFloat(minTP.toFixed(6))];
    signal._tpAutoSet = true;
    console.log(`💡 [${trader}] 自动推算TP: ${signal.tp[0]} (RR=2.0，基于SL距离)`);
  }
  
  // ===== 进化：entry合理性验证 =====
  // 防止entry被解析成极大数值（如频道ID）
  if (signal.entry && signal.entry > 1e12) {
    console.log(`🚫 [${trader}] entry异常: ${signal.entry}，疑似解析错误，跳过`);
    evolution.recordFailedParse(trader, textPreview, `entry异常值: ${signal.entry}`);
    return;
  }
  
  // ===== 账户安全检查（下单前） =====
  try {
    const safetyBalance = await getBalance();
    const safetyPositions = await okxReq('GET', '/api/v5/account/positions', null, { instType: 'SWAP' });

    // 1. 持仓数量检查
    const activePos = (safetyPositions.data || []).filter(p => parseFloat(p.pos) !== 0);
    if (activePos.length >= CONFIG.trading.maxPositions) {
      console.log(`🛑 [${trader}] 持仓已满(${activePos.length}/${CONFIG.trading.maxPositions})，跳过`);
      return;
    }

    // 2. 总浮亏检查（超过8%停止下单）
    const totalUpl = activePos.reduce((s, p) => s + parseFloat(p.upl || 0), 0);
    const uplPct = Math.abs(totalUpl) / (safetyBalance + Math.abs(totalUpl)) * 100;
    if (totalUpl < 0 && uplPct > 8) {
      console.log(`🛑 总浮亏 ${uplPct.toFixed(1)}% 超过8%，暂停下单`);
      await sendTG(`⚠️ <b>风控保护</b>\n\n总浮亏已达 ${uplPct.toFixed(1)}%，超过8%阈值\n已暂停新建仓位，请关注现有持仓`);
      return;
    }

    // 3. 日亏损检查（读取今日已亏损金额）
    const todayTrades = (JSON.parse(fs.existsSync(CONFIG.logging.historyPath) ? fs.readFileSync(CONFIG.logging.historyPath, 'utf8') || '{"trades":[]}' : '{"trades":[]}').trades || [])
      .filter(t => t.timestamp && t.timestamp.startsWith(new Date().toISOString().slice(0, 10)) && (t.realizedPnl || 0) < 0);
    const dailyLoss = todayTrades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
    const dailyLossPct = Math.abs(dailyLoss) / safetyBalance * 100;
    if (dailyLossPct > CONFIG.trading.maxDailyLossPercent) {
      console.log(`🛑 今日亏损 ${dailyLossPct.toFixed(1)}% 超过${CONFIG.trading.maxDailyLossPercent}%，今日停止交易`);
      await sendTG(`⚠️ <b>日亏损保护</b>\n\n今日亏损已达 ${dailyLossPct.toFixed(1)}%，超过${CONFIG.trading.maxDailyLossPercent}%阈值\n今日不再开新仓`);
      return;
    }

    // 4. 连续亏损熔断（最近N笔交易全是亏损才触发，中间有盈利则重置）
    const allTrades = JSON.parse(fs.existsSync(CONFIG.logging.historyPath) ? fs.readFileSync(CONFIG.logging.historyPath, 'utf8') || '{"trades":[]}' : '{"trades":[]}').trades || [];
    // 取最近N笔已平仓交易（按时间倒序），检查是否连续亏损
    const recentClosed = allTrades
      .filter(t => t.outcome && ['stopped', 'loss', 'sl_hit'].includes(t.outcome))
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    // 真正的连续亏损判断：从最新往前数，连续N笔都是亏损
    let consecutiveLoss = 0;
    const sortedAll = [...allTrades].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    for (const t of sortedAll) {
      if (!t.outcome) continue; // 未平仓跳过
      if (['stopped', 'loss', 'sl_hit'].includes(t.outcome)) {
        consecutiveLoss++;
      } else {
        break; // 遇到盈利单，连续中断
      }
    }
    if (consecutiveLoss >= CONFIG.trading.maxConsecutiveLoss) {
      const lastLoss = recentClosed[0];
      const lastTs = new Date(lastLoss?.timestamp || 0).getTime();
      const cooldownMs = CONFIG.trading.consecutiveLossCooldownH * 60 * 60 * 1000;
      if (Date.now() - lastTs < cooldownMs) {
        const remainH = ((cooldownMs - (Date.now() - lastTs)) / 3600000).toFixed(1);
        console.log(`🛑 连续${consecutiveLoss}笔止损，冷却中（剩余${remainH}h）`);
        await sendTG(`❄️ <b>连续亏损熔断</b>\n\n已连续${consecutiveLoss}笔止损\n冷却期剩余 ${remainH}h，暂停新开仓`);
        return;
      }
    }
  } catch (e) {
    if (e.message && e.message.includes('401') && CONFIG.okx.useDemo) {
      // 模拟盘API权限限制，余额检查跳过（不阻断下单）
      console.log(`⚠️ 账户安全检查跳过（模拟盘401，不阻断）: ${e.message}`);
    } else {
      console.log(`🛑 账户安全检查异常: ${e.message}，拒绝下单`);
      await sendTG(`⚠️ <b>安全检查异常</b>\n\n${e.message}\n已拒绝新开仓，请检查系统状态`);
      return;
    }
  }

  // ===== Strict Parser 置信度校验 =====
  // 用严格正则解析器给信号打分，低置信度信号警告（不直接拒绝，因为主解析器更强）
  try {
    const rawText = signal.textContent || signal.raw || '';
    if (rawText) {
      const strictResult = parseSignalStrict(rawText);
      signal._confidence = strictResult.confidence;
      signal._warnings = strictResult.warnings || [];

      // ===== CMP市价信号处理（时效锁3s + 滑点0.3% + 失败拒单）=====
      if (strictResult.signal_type === 'market' && !strictResult.entry && !signal.entry && signal.pair) {
        const cmpStart = Date.now();
        try {
          const instId = `${signal.pair.replace('/', '-')}-SWAP`;
          const tickerData = await okxReq('GET', '/api/v5/market/ticker', null, { instId });
          const livePx = parseFloat(tickerData.data?.[0]?.last || 0);
          const elapsed = Date.now() - cmpStart;

          if (elapsed > 3000) {
            const reject_reason = 'CMP_TIMEOUT';
            console.log(`🛑 [${trader}] ${reject_reason}: 取价耗时${elapsed}ms > 3000ms，拒单`);
            saveSignalLog(channelId, trader, signal, 'REJECTED', reject_reason);
            return;
          }
          if (!livePx || Number.isNaN(livePx)) {
            const reject_reason = 'CMP_INVALID_PRICE';
            console.log(`🛑 [${trader}] ${reject_reason}: livePx=${livePx}，拒单`);
            saveSignalLog(channelId, trader, signal, 'REJECTED', reject_reason);
            return;
          }
          // 滑点校验：与信号触发时相比偏移 > 0.3% 拒单
          if (signal._entryRefPx) {
            const slippage = Math.abs(livePx - signal._entryRefPx) / signal._entryRefPx;
            if (slippage > 0.003) {
              const reject_reason = 'SLIPPAGE_EXCEEDED';
              console.log(`🛑 [${trader}] ${reject_reason}: 滑点${(slippage*100).toFixed(3)}% > 0.3%，拒单`);
              saveSignalLog(channelId, trader, signal, 'REJECTED', reject_reason);
              return;
            }
          }
          signal.entry = livePx;
          console.log(`✅ [${trader}] CMP → 市价填充: ${livePx} (${elapsed}ms)`);
        } catch (err) {
          const reject_reason = 'CMP_FETCH_ERROR';
          console.log(`🛑 [${trader}] ${reject_reason}: ${err.message}，拒单`);
          saveSignalLog(channelId, trader, signal, 'REJECTED', reject_reason);
          return;
        }
      }

      // SL自动修正日志
      if (strictResult.auto_fixed_sl) {
        const reject_reason = 'SL_AUTO_FIXED';
        console.log(`⚠️ [${trader}] SL自动补位: ${strictResult.sl} (auto_fixed=true)`);
        await sendTG(`⚠️ <b>SL自动修正</b>\n\n交易员: ${trader}\n币种: ${signal.pair || '未知'}\n修正后SL: ${strictResult.sl}\n标记: auto_fixed`);
      }

      if (strictResult.confidence < 30 && !signal.source?.includes('vision')) {
        // 纯文字信号且置信度极低（方向/pair/entry都没匹配到）→ 记录警告
        console.log(`⚠️ [${trader}] Strict置信度低: ${strictResult.confidence}% matched=${strictResult.matched_patterns.join(',')}`);
      }
    }
  } catch (e) { /* 静默，不影响主流程 */ }

  // ===== Tech Confirm 旁路（crypto-market-data Skill，enforce=false）=====
  let techResult = { tech_trend: 'skipped', tech_score: 0, tech_confirm_pass: null };
  try {
    techResult = await techConfirmBypass(signal);
    signal._techTrend = techResult.tech_trend;
    signal._techScore = techResult.tech_score;
    signal._techConfirmPass = techResult.tech_confirm_pass;
  } catch (e) {
    console.log(`⚠️ TechConfirm 旁路失败: ${e.message}，继续执行`);
  }

  // 风控验证
  const riskResult = await riskControl.validateTrade(signal, message.createdTimestamp);
  logTraceEvent(traceId, riskResult.approved ? 'RISK_PASSED' : 'RISK_REJECTED', { trader, coin: signal.coin, detail: { reason: riskResult.reason } });
  
  if (!riskResult.approved) {
    console.log(`🚫 [${trader}] 风控拒绝`);
    // 风控拒绝不写trade-history（避免空记录污染），只记signal-log
    saveSignalLog(channelId, trader, signal, 'REJECTED');
    evolution.updateTraderStats(trader, { type: 'skipped', pair: signal.pair, notes: riskResult.finalDecision });
    return;
  }
  
  // 进化引擎：获取交易员权重，调整仓位
  const evolvedConfig = evolution.getEvolvedConfig();
  const traderWeight = evolvedConfig.traderWeights[trader] || 1.0;
  if (traderWeight < 1.0) {
    console.log(`📊 [${trader}] 进化权重: ${traderWeight}x (降低仓位)`);
  } else if (traderWeight > 1.0) {
    console.log(`📊 [${trader}] 进化权重: ${traderWeight}x (提升仓位)`);
  }
  signal._traderWeight = traderWeight;
  signal._traderName = trader;
  signal._messageId = message.id; // 传入messageId供commitDedupRecord使用
  signal._traceId = traceId;
  
  // 执行交易
  console.log(`✅ [${trader}] 风控通过，执行交易...`);
  await executeTrade(signal, trader);
}

// ============== 启动 Discord 监控 ==============
const client = new Client({ checkUpdate: false });

// ============== 实盘 Preflight 验证 ==============
async function runPreflight() {
  if (CONFIG.okx.useDemo) return true; // 模拟盘跳过
  console.log('\n🔍 [Preflight] 实盘启动前检查...');
  const errors = [];

  try {
    // 1. API连通 + 余额检查
    const balRes = await okxReq('GET', '/api/v5/account/balance');
    const totalEq = parseFloat(balRes.data?.[0]?.totalEq || 0);
    const availBal = parseFloat(balRes.data?.[0]?.details?.find(d => d.ccy === 'USDT')?.availBal || 0);
    console.log(`  💰 账户总权益: ${totalEq.toFixed(2)} USDT | 可用余额: ${availBal.toFixed(2)} USDT`);
    if (availBal < 20) errors.push(`可用余额 ${availBal.toFixed(2)}U < 20U，资金不足`);

    // 2. 账户配置检查
    const cfgRes = await okxReq('GET', '/api/v5/account/config');
    const acctLv = cfgRes.data?.[0]?.acctLv;
    const posMode = cfgRes.data?.[0]?.posMode;
    console.log(`  ⚙️ 账户等级: ${acctLv} | 持仓模式: ${posMode}`);

    // 3. 时间同步检查
    const srvTime = await okxReq('GET', '/api/v5/public/time');
    const serverTs = parseInt(srvTime.data?.[0]?.ts || Date.now());
    const drift = Math.abs(Date.now() - serverTs);
    console.log(`  🕐 时间漂移: ${drift}ms`);
    if (drift > 30000) errors.push(`时间漂移 ${drift}ms > 30s，签名会失败`);

    // 4. SOL合约最小下单验证（金丝雀阶段）
    const solInfo = await okxReq('GET', '/api/v5/public/instruments?instType=SWAP&instId=SOL-USDT-SWAP');
    const minSz = solInfo.data?.[0]?.minSz;
    const ctVal = solInfo.data?.[0]?.ctVal;
    console.log(`  📋 SOL-USDT-SWAP: minSz=${minSz} ctVal=${ctVal}`);

  } catch (e) {
    errors.push(`API连通失败: ${e.message}`);
  }

  if (errors.length > 0) {
    const errMsg = `🚨 <b>实盘Preflight失败</b>\n\n${errors.map((e,i) => `${i+1}. ${e}`).join('\n')}\n\n系统已停止，请修复后重启`;
    console.error('\n❌ [Preflight] 检查失败:\n' + errors.join('\n'));
    await sendTG(errMsg);
    process.exit(1);
  }

  console.log('✅ [Preflight] 所有检查通过，允许实盘启动\n');
  return true;
}

client.on('ready', async () => {
  const channelCount = Object.keys(CONFIG.channels).length;
  const demoTag = CONFIG.okx.useDemo ? '🟢模拟盘' : '🔴真实盘';
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Antigravity 交易系统 v3.0 已启动`);
  console.log(`${'='.repeat(60)}`);
  console.log(`👤 Discord: ${client.user.tag}`);
  console.log(`📡 监控频道: ${channelCount} 个`);
  console.log(`⚙️ OKX: ${demoTag}`);
  console.log(`🛡️ 风控: Gemini ${riskControl.CONFIG.gemini.model}`);
  console.log(`🖼️ 视觉: Gemini Vision 已启用`);
  console.log(`🛑 止损: 强制（无止损不下单）`);
  console.log(`📊 仓位: 自动计算（2% 风险）`);
  console.log(`${'='.repeat(60)}\n`);
  
  Object.entries(CONFIG.channels).forEach(([id, c]) => {
    console.log(`  📡 [${c.group}] ${c.name} → ${id} (P${c.priority})`);
  });
  console.log('\n⏳ 等待交易信号...\n');
  
  // Telegram 启动通知
  let channelList = '';
  const groups = {};
  Object.values(CONFIG.channels).forEach(ch => {
    if (!groups[ch.group]) groups[ch.group] = [];
    groups[ch.group].push(ch.name);
  });
  Object.entries(groups).forEach(([g, traders]) => {
    channelList += `\n<b>${g}:</b> ${traders.join(', ')}`;
  });
  
  // 初始化持仓台账（三刃辩论融合版 v2.0）
  global.ledger = new PositionLedger(
    {
      apiKey: CONFIG.okx.apiKey,
      secretKey: CONFIG.okx.secretKey,
      passphrase: CONFIG.okx.passphrase,
      baseUrl: CONFIG.okx.baseUrl,
      isDemo: CONFIG.okx.useDemo,
    },
    sendTG
  );
  await global.ledger.init();
  global.ledger.onSyncSuccess = flushPendingSL;
  global.ledger.summary();

  // ===== Preflight（实盘模式） =====
  await runPreflight();

  // ===== 启动通知 =====
  const whitelist = CONFIG.trading.coinWhitelist || [];
  const riskParams = !CONFIG.okx.useDemo
    ? `\n⚙️ <b>实盘风控参数</b>\n最大仓位: ${CONFIG.trading.maxPositions}个\n单笔风险: ${CONFIG.trading.maxRiskPerTradeUSDT}U\n日亏损限制: ${CONFIG.trading.maxDailyLossPercent}%\n连续亏损: ${CONFIG.trading.maxConsecutiveLoss}笔后暂停${CONFIG.trading.consecutiveLossCooldownH}h\n白名单: ${whitelist.join(', ')}\n\n🛑 紧急停机: touch /tmp/kill_trading`
    : '';

  await sendTG(
    `${CONFIG.okx.useDemo ? '🟢' : '🔴'} <b>Antigravity v3.1 已启动</b>\n\n` +
    `模式: <b>${demoTag}</b>\n` +
    `风控: Gemini AI\n` +
    `视觉: Gemini Vision 🖼️\n` +
    `止损: 强制 🛑\n` +
    `监控: ${channelCount} 个频道\n` +
    `${channelList}` +
    riskParams +
    `\n\n⏳ 等待交易信号...`
  );
});

client.on('messageCreate', async (message) => {
  if (!CONFIG.channels[message.channel.id]) return;
  if (message.author.id === client.user.id) return;
  
  try {
    await handleDiscordMessage(message);
  } catch (e) {
    console.error(`❌ 处理消息错误: ${e.message}`);
    await sendTG(`⚠️ <b>处理错误</b>\n\n${e.message}`);
  }
});

// ============== 持仓止损守护（每2分钟）==============
async function guardPositionSL() {
  try {
    const pos = await okxReq('GET', '/api/v5/account/positions', null, {instType:'SWAP'});
    const active = (pos.data||[]).filter(p => p.pos && p.pos !== '0');
    if (active.length === 0) return;

    // 获取现有 algo 止损订单
    const algos = await okxReq('GET', '/api/v5/trade/orders-algo-pending', null, {ordType:'conditional',instType:'SWAP'});
    const hasSL = new Set((algos.data||[]).filter(a=>a.slTriggerPx&&a.slTriggerPx!=='').map(a=>a.instId));

    for (const p of active) {
      if (hasSL.has(p.instId)) continue; // 已有止损，跳过
      const isBuy = parseFloat(p.pos) > 0;
      const avgPx = parseFloat(p.avgPx);

      // 优先用台账记录的原始SL（信号来源的止损价最准确）
      let slPx;
      const ledgerPos = global.ledger ? global.ledger.getPosition(p.instId) : null;
      if (ledgerPos && ledgerPos.sl && ledgerPos.sl > 0) {
        slPx = ledgerPos.sl.toString();
        console.log(`🛡️ 守护止损: ${p.instId} 使用台账原始SL@${slPx}`);
      } else {
        // 台账无SL记录，动态波动率兜底
        try {
          const ticker = await okxReq('GET', `/api/v5/market/ticker?instId=${p.instId}`);
          const t = ticker.data?.[0];
          if (t && t.high24h && t.low24h) {
            const high24 = parseFloat(t.high24h);
            const low24 = parseFloat(t.low24h);
            const volatility = (high24 - low24) / low24;
            const slPct = Math.min(Math.max(volatility * 1.2, 0.01), 0.15);
            slPx = isBuy
              ? (avgPx * (1 - slPct)).toFixed(4)
              : (avgPx * (1 + slPct)).toFixed(4);
            console.log(`🛡️ 动态止损: ${p.instId} 波动率=${(volatility*100).toFixed(1)}% SL@${slPx}`);
          } else {
            slPx = isBuy ? (avgPx * 0.95).toFixed(4) : (avgPx * 1.05).toFixed(4);
            console.log(`⚠️ 行情获取失败，fallback 5%止损: ${p.instId} SL@${slPx}`);
          }
        } catch (e) {
          slPx = isBuy ? (avgPx * 0.95).toFixed(4) : (avgPx * 1.05).toFixed(4);
          console.log(`⚠️ 波动率计算失败，fallback 5%: ${p.instId} SL@${slPx}`);
        }
      }

      // === liquidation_buffer 安全检查（借鉴 freqtrade）===
      // 确保止损价比强平价至少保留 5% 缓冲，防止止损被踏空直接强平
      const liqPx = parseFloat(p.liqPx);
      if (!isNaN(liqPx) && liqPx > 0) {
        const liqBuffer = 0.05;
        const minSafeSlPx = isBuy
          ? liqPx * (1 + liqBuffer)
          : liqPx * (1 - liqBuffer);
        const slPxNum = parseFloat(slPx);
        if (isBuy && slPxNum < minSafeSlPx) {
          console.log(`⚠️ liquidation_buffer: ${p.instId} SL ${slPx} < 安全线 ${minSafeSlPx.toFixed(4)}（liqPx=${liqPx}），上移`);
          slPx = minSafeSlPx.toFixed(4);
        } else if (!isBuy && slPxNum > minSafeSlPx) {
          console.log(`⚠️ liquidation_buffer: ${p.instId} SL ${slPx} > 安全线 ${minSafeSlPx.toFixed(4)}（liqPx=${liqPx}），下移`);
          slPx = minSafeSlPx.toFixed(4);
        }
      }

      // === P0修复: 方向硬校验（太尉+幕僚共识）===
      // 上移/下移后必须检查止损是否仍在正确方向
      const finalSlPx = parseFloat(slPx);
      const directionValid = isBuy ? (finalSlPx < avgPx) : (finalSlPx > avgPx);
      if (!directionValid) {
        const reason = `SL_AFTER_BUFFER_INVALID_DIRECTION: ${p.instId} ${isBuy?'多':'空'} entry=${avgPx} sl=${slPx} liqPx=${p.liqPx}`;
        console.error(`❌ AUTO_SL_ABORTED: ${reason}`);
        console.error(`⚠️ 高风险预警: ${p.instId} 全仓/高杠杆导致无有效SL可挂，建议降杠杆或减仓`);
        await sendTG(`🚨 <b>止损补设失败</b>\n\n${p.instId} ${isBuy?'多':'空'}\n入场: ${avgPx}\n计算SL: ${slPx}\n强平价: ${p.liqPx}\n\n<b>原因: 止损上移后反向（${isBuy?'SL>入场':'SL<入场'}），无法挂单</b>\n<b>建议: 降杠杆或减仓</b>`);
        continue; // 跳过此仓位，不挂无效止损
      }

      try {
        const algoResult = await okxReq('POST', '/api/v5/trade/order-algo', {
          instId: p.instId, tdMode:'cross',
          side: isBuy ? 'sell' : 'buy',
          ordType:'conditional', sz: Math.abs(parseFloat(p.pos)).toString(),
          slTriggerPx: slPx, slOrdPx: '-1',
          slTriggerPxType: 'mark',
          reduceOnly: 'true'
        });
        const algoId = algoResult?.data?.[0]?.algoId || '?';
        console.log(`✅ 止损补设成功: ${p.instId} SL@${slPx} algoId=${algoId} sz=${Math.abs(parseFloat(p.pos))}`);
        await sendTG(`🛡️ <b>自动补设止损</b>\n\n${p.instId} ${isBuy?'多':'空'}\nSL @ ${slPx}\nalgoId: ${algoId}\n（动态波动率止损，持仓保护）`);
      } catch(e) {
        console.error(`止损补设失败: ${p.instId}`, e.message);
        await sendTG(`❌ <b>止损补设API失败</b>\n${p.instId}: ${e.message}`);
      }
    }
  } catch(e) {
    if (e.message && e.message.includes('401') && CONFIG.okx.useDemo) {
      // 模拟盘API限制，静默
    } else {
      console.error('持仓守护错误:', e.message);
    }
  }
}
setInterval(guardPositionSL, 2 * 60 * 1000); // 每2分钟检查

// ============== BUG FIX #5: 盈亏自动回写（每5分钟）==============
async function reconcilePnl() {
  try {
    const histPath = CONFIG.logging.historyPath;
    const data = JSON.parse(fs.readFileSync(histPath, 'utf8') || '{"trades":[]}');
    const openTrades = data.trades.filter(t => t.outcome === 'open' && t.orderId);
    if (openTrades.length === 0) return;

    let updated = 0;
    for (const trade of openTrades) {
      const tradeTime = new Date(trade.timestamp).getTime();
      const tradeDir = trade.direction;
      const tradeEntry = trade.entry || trade.entryFilled || 0;

      // 按instId逐个查（避免limit=20被其他币种稀释，限价单挂单时间长也能匹配）
      let closedPos = [];
      try {
        const posHistory = await okxReq('GET', '/api/v5/account/positions-history', null,
          { instType: 'SWAP', instId: trade.instId, limit: '20' });
        closedPos = posHistory.data || [];
      } catch (e) { console.error(`PnL查询失败 ${trade.instId}: ${e.message}`); continue; }

      const matched = closedPos.find(p => {
        if (p.instId !== trade.instId) return false;
        if (p.openOrdId && p.openOrdId === trade.orderId) return true;
        const pDir = parseFloat(p.pos || 0);
        const pEntry = parseFloat(p.openAvgPx || 0);
        const pTime = parseInt(p.cTime || 0);
        const dirMatch = tradeDir ? (tradeDir === 'buy' ? pDir > 0 : pDir < 0) : true;
        const priceMatch = tradeEntry > 0 && pEntry > 0 ?
          Math.abs(pEntry - tradeEntry) / tradeEntry < 0.005 : true;
        // 时间窗口扩展到4小时（限价单最大挂单时间）
        const timeMatch = Math.abs(pTime - tradeTime) < 4 * 60 * 60 * 1000;
        return dirMatch && priceMatch && timeMatch;
      });

      if (matched && matched.uTime) {
        const pnl = parseFloat(matched.realizedPnl || 0);
        const exitPrice = parseFloat(matched.closeAvgPx || 0);
        trade.outcome = pnl >= 0 ? 'win' : 'loss';
        trade.realizedPnl = pnl;
        trade.exitPrice = exitPrice;
        trade.closedAt = new Date(parseInt(matched.uTime)).toISOString();
        updated++;
        console.log(`📝 PnL回写: ${trade.instId} ${trade.outcome} ${pnl.toFixed(2)}U (匹配方式: ${matched.openOrdId === trade.orderId ? 'orderId' : '多维'})`);
      }
    }

    if (updated > 0) {
      fs.writeFileSync(histPath, JSON.stringify(data, null, 2));
      console.log(`✅ 已回写 ${updated} 笔盈亏记录`);
    }
  } catch (e) {
    console.error('盈亏回写失败:', e.message);
  }
}
setInterval(reconcilePnl, 5 * 60 * 1000); // 每5分钟回写

// ============== 错误处理 ==============
client.on('error', (error) => console.error('❌ Discord 错误:', error.message));
client.on('disconnect', () => console.log('⚠️ Discord 断开，尝试重连...'));

process.on('uncaughtException', async (error) => {
  console.error('❌ 未捕获异常:', error.message);
  await sendTG(`🔴 <b>系统异常</b>\n\n${error.message}`);
});
process.on('unhandledRejection', async (reason) => {
  console.error('❌ Promise 拒绝:', reason);
});

// ============== 启动 ==============
console.log('🚀 正在连接 Discord...\n');
initSignalDb(); // Signal DB初始化
client.login(CONFIG.discordToken).catch(async (err) => {
  console.error('❌ 登录失败:', err.message);
  await sendTG(`🔴 <b>Discord 登录失败</b>\n\n${err.message}`);
  process.exit(1);
});
