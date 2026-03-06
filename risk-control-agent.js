#!/usr/bin/env node
/**
 * 风控智能体 - Risk Control Agent
 * 双层风控架构：
 * - Layer 1: 硬性规则（代码层）- 快速过滤
 * - Layer 2: Gemini AI 智能决策 - 深度分析
 */

const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const https = require('https');

// OKX IP直连修复：DNS污染绕过
const OKX_IPS = ['104.18.43.174', '172.64.144.82'];
let _okxIpIdx = 0;
const okxAgent = new https.Agent({ servername: 'www.okx.com', keepAlive: true, maxSockets: 3 });
function okxAxios(config) {
  const url = (config.url || '').replace('https://www.okx.com', `https://${OKX_IPS[_okxIpIdx++ % OKX_IPS.length]}`);
  return axios({ ...config, url, httpsAgent: okxAgent, headers: { ...config.headers, 'Host': 'www.okx.com' } });
}
const path = require('path');

// ============== MCP TradingView 数据获取 ==============
async function getTradingViewData(pair) {
  // 把 OKX 格式转换为 TradingView 格式: BTC-USDT-SWAP -> BINANCE:BTCUSDT
  const base = pair.replace(/-USDT-SWAP|-USDT/i, '').replace(/-/g, '');
  const tvSymbol = `BINANCE:${base}USDT`;
  
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'lookup_symbols',
        arguments: {
          symbols: [tvSymbol],
          columns: ['close', 'change', 'RSI', 'EMA20', 'EMA200', 'BB.upper', 'BB.lower', 'volume']
        }
      }
    });

    const req = http.request({
      hostname: '127.0.0.1', port: 3741,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          const inner = JSON.parse(resp.result);
          const content = inner.result?.content?.[0]?.text;
          const parsed = content ? JSON.parse(content) : null;
          const sym = parsed?.symbols?.[0];
          if (sym) {
            resolve({
              price: sym.close,
              change24h: sym.change?.toFixed(2),
              rsi: sym.RSI,
              ema20: sym.EMA20,
              ema200: sym.EMA200,
              bbUpper: sym['BB.upper'],
              bbLower: sym['BB.lower'],
              volume: sym.volume,
              symbol: tvSymbol
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ============== 配置 ==============
const CONFIG = {
  // 硬性风控阈值
  hardRules: {
    maxSignalAgeMinutes: 5,        // 信号最大有效期（分钟）
    requireStopLoss: true,          // 是否强制要求止损（铁规则：无止损不下单）
    minLeverage: 1,                 // 最小杠杆
    maxLeverage: 50,                // 最大杠杆
  },
  
  // 资本守护（Capital Guardian）— 受 QuantTradingOS/Capital-Guardian-Agent 启发
  capitalGuardian: {
    enabled: true,
    drawdownHaltThreshold: 20,      // 回撤 >= 20% → 暂停交易
    drawdownReduceThreshold: 10,    // 回撤 >= 10% → 风险减半
    lossStreakCooldown: 4,          // 连续亏损 >= 4笔 → 暂停交易
    cooldownMinutes: 30,           // 暂停交易后冷却期（分钟）
    stateFile: '/home/botdrop/data/capital-guardian-state.json',
  },
  
  // Gemini AI 配置（已禁用，额度留给图片解析用）
  gemini: {
    enabled: false,
    apiKey: process.env.VISION_API_KEY || process.env.GEMINI_API_KEY || '',
    baseUrl: process.env.GEMINI_BASE_URL || 'https://free.aipro.love',
    model: 'gemini-3-flash',                        // 改为 gemini-3-flash
  },
  
  // OKX API 配置（用于获取实时价格）
  okx: {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: 'https://www.okx.com'
  },
  
  // Telegram 通知配置
  telegram: {
    enabled: true,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  }
};

// ============== OKX API 工具 ==============
function okxSignature(timestamp, method, requestPath, body = '') {
  const message = timestamp + method + requestPath + body;
  return crypto.createHmac('sha256', CONFIG.okx.secretKey).update(message).digest('base64');
}

async function okxRequest(method, endpoint, body = null, _retry = 0) {
  const timestamp = new Date().toISOString();
  const M = method.toUpperCase();
  // GET签名必须包含查询字符串！
  const urlObj = new URL('https://www.okx.com' + endpoint);
  const qs = urlObj.search; // 如 "?instId=BTC-USDT-SWAP"
  const signPath = urlObj.pathname + qs;
  const bodyStr = (M !== 'GET' && body) ? JSON.stringify(body) : '';
  const signature = okxSignature(timestamp, M, signPath, bodyStr);
  
  const headers = {
    'OK-ACCESS-KEY': CONFIG.okx.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': CONFIG.okx.passphrase,
    'Content-Type': 'application/json'
  };
  
  try {
    const response = await okxAxios({
      method: M,
      url: CONFIG.okx.baseUrl + signPath,
      headers,
      data: M !== 'GET' ? body : undefined,
      timeout: 10000
    });
    return response.data;
  } catch (e) {
    const isNetErr = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED' ||
                    (e.message || '').includes('socket') || (e.message || '').includes('network') || (e.message || '').includes('TLS');
    if (isNetErr && _retry < 3) {
      const delay = [200, 800, 2000][_retry];
      console.log(`⚠️ [风控] OKX 网络抖动 (${_retry+1}/3)，${delay}ms 后重试`);
      await new Promise(r => setTimeout(r, delay));
      return okxRequest(method, endpoint, body, _retry + 1);
    }
    throw e;
  }
}

// 获取实时市场价格
// 规范化币种格式 → OKX instId，支持多种输入格式
function normalizeInstId(pair) {
  // 去除空格
  let p = pair.trim().toUpperCase();
  
  // 已含斜杠的情况：ETH/USDT → ETH-USDT
  if (p.includes('/')) {
    return p.replace('/', '-');
  }
  
  // 无斜杠的情况：ETHUSD / ETHUSDT / BTCUSD 等
  // 常见报价货币列表（从长到短匹配，防止USDT先被USD截断）
  const quotes = ['USDT', 'BUSD', 'USDC', 'USD', 'BTC', 'ETH', 'BNB'];
  for (const q of quotes) {
    if (p.endsWith(q) && p.length > q.length) {
      const base = p.slice(0, p.length - q.length);
      return `${base}-${q}`;
    }
  }
  
  // 无法识别，原样返回（让OKX自己报错）
  return p;
}

async function getCurrentPrice(pair) {
  try {
    const baseId = normalizeInstId(pair);
    
    // 候选 instId 列表：先 SWAP，再 USDT-SWAP（USD→USDT回退），再现货
    const candidates = [
      `${baseId}-SWAP`,
    ];
    
    // 如果 baseId 以 -USD 结尾（非USDT），追加 -USDT-SWAP 候选
    if (baseId.endsWith('-USD')) {
      candidates.push(`${baseId}T-SWAP`); // USD → USDT
    }
    
    // 追加现货候选
    candidates.push(baseId);
    
    for (const instId of candidates) {
      try {
        const data = await okxRequest('GET', `/api/v5/market/ticker?instId=${instId}`);
        if (data.code === '0' && data.data && data.data[0]) {
          console.log(`✅ 市场数据来源: ${instId}`);
          const last = parseFloat(data.data[0].last);
          const volCcy24hRaw = parseFloat(data.data[0].volCcy24h || 0);
          const isSWAP = instId.endsWith('-SWAP');
          // ===== 进化修复 v3：SWAP合约 volCcy24h 是基础货币数量（如BTC），需×price转USDT =====
          const volCcy24h = isSWAP ? volCcy24hRaw * last : volCcy24hRaw;
          return {
            last,
            bid: parseFloat(data.data[0].bidPx),
            ask: parseFloat(data.data[0].askPx),
            vol24h: parseFloat(data.data[0].vol24h),
            volCcy24h, // 24h成交额（已转换为USDT）
            high24h: parseFloat(data.data[0].high24h),
            low24h: parseFloat(data.data[0].low24h),
            bidSz: parseFloat(data.data[0].bidSz || 0), // 买一量
            askSz: parseFloat(data.data[0].askSz || 0), // 卖一量
            instType: isSWAP ? 'SWAP' : 'SPOT',
          };
        }
        // code非0说明币种不存在，继续下一候选
        console.log(`⚠️ ${instId} 不存在 (code=${data.code})，尝试下一候选...`);
      } catch (innerErr) {
        console.log(`⚠️ ${instId} 请求失败: ${innerErr.message}，尝试下一候选...`);
      }
    }
    
    throw new Error(`所有候选 instId 均无数据: ${candidates.join(', ')}`);
  } catch (e) {
    console.error(`❌ 获取价格失败 (${pair}):`, e.message);
    return null;
  }
}

// ============== Layer 0: 资本守护（Capital Guardian）==============
// 灵感来源: QuantTradingOS/Capital-Guardian-Agent
// 功能: 回撤控制 + 连续亏损冷却 + 动态风险调整

function loadGuardianState() {
  try {
    if (fs.existsSync(CONFIG.capitalGuardian.stateFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.capitalGuardian.stateFile, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {
    peakBalance: 0,
    consecutiveLosses: 0,
    lastLossTime: null,
    cooldownUntil: null,
    riskMultiplier: 1.0,
    totalTradesCount: 0,
    totalLossesCount: 0,
  };
}

function saveGuardianState(state) {
  try {
    const dir = path.dirname(CONFIG.capitalGuardian.stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.capitalGuardian.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('⚠️ 资本守护状态保存失败:', e.message);
  }
}

// 更新交易结果到守护状态
function updateGuardianResult(pnl, balance) {
  const state = loadGuardianState();
  state.totalTradesCount++;
  
  if (balance > state.peakBalance) {
    state.peakBalance = balance;
  }
  
  if (pnl < 0) {
    state.consecutiveLosses++;
    state.totalLossesCount++;
    state.lastLossTime = new Date().toISOString();
    
    // 连续亏损触发冷却
    if (state.consecutiveLosses >= CONFIG.capitalGuardian.lossStreakCooldown) {
      state.cooldownUntil = new Date(Date.now() + CONFIG.capitalGuardian.cooldownMinutes * 60 * 1000).toISOString();
      console.log(`🛡️ [资本守护] 连续${state.consecutiveLosses}次亏损，冷却${CONFIG.capitalGuardian.cooldownMinutes}分钟`);
    }
  } else if (pnl > 0) {
    state.consecutiveLosses = 0; // 盈利重置连亏计数
  }
  
  // 计算回撤
  if (state.peakBalance > 0) {
    const drawdown = ((state.peakBalance - balance) / state.peakBalance) * 100;
    if (drawdown >= CONFIG.capitalGuardian.drawdownHaltThreshold) {
      state.riskMultiplier = 0; // 暂停
    } else if (drawdown >= CONFIG.capitalGuardian.drawdownReduceThreshold) {
      state.riskMultiplier = 0.5; // 风险减半
    } else {
      state.riskMultiplier = 1.0;
    }
  }
  
  saveGuardianState(state);
  return state;
}

// 资本守护验证
async function capitalGuardianCheck() {
  if (!CONFIG.capitalGuardian.enabled) {
    return { passed: true, riskMultiplier: 1.0, reason: '资本守护未启用' };
  }
  
  const state = loadGuardianState();
  const reasons = [];
  
  // 1. 冷却期检查
  if (state.cooldownUntil) {
    const cooldownEnd = new Date(state.cooldownUntil);
    if (Date.now() < cooldownEnd.getTime()) {
      const remainMin = ((cooldownEnd.getTime() - Date.now()) / 60000).toFixed(0);
      reasons.push(`连续${state.consecutiveLosses}次亏损，冷却中（剩余${remainMin}分钟）`);
      console.log(`🛡️ [资本守护] ❌ ${reasons[0]}`);
      return { passed: false, riskMultiplier: 0, reason: reasons.join('; ') };
    } else {
      // 冷却期结束，重置
      state.cooldownUntil = null;
      state.consecutiveLosses = 0;
      saveGuardianState(state);
    }
  }
  
  // 2. 获取当前余额计算回撤
  let currentBalance = 0;
  try {
    const balData = await okxRequest('GET', '/api/v5/account/balance');
    if (balData.code === '0' && balData.data?.[0]) {
      // 用 totalEq（总权益）而非 availBal，与主文件一致
      currentBalance = parseFloat(balData.data[0].totalEq || 0);
      if (currentBalance <= 0) {
        const usdt = balData.data[0].details?.find(d => d.ccy === 'USDT');
        currentBalance = usdt ? parseFloat(usdt.cashBal || usdt.availBal || 0) : 0;
      }
    }
  } catch (e) {
    console.log('⚠️ [资本守护] 获取余额失败，跳过回撤检查');
    return { passed: true, riskMultiplier: state.riskMultiplier || 1.0, reason: '余额获取失败，使用上次风险系数' };
  }
  
  // 更新峰值
  if (currentBalance > state.peakBalance) {
    state.peakBalance = currentBalance;
    saveGuardianState(state);
  }
  
  // 3. 回撤检查
  if (state.peakBalance > 0 && currentBalance > 0) {
    const drawdownPct = ((state.peakBalance - currentBalance) / state.peakBalance) * 100;
    
    if (drawdownPct >= CONFIG.capitalGuardian.drawdownHaltThreshold) {
      reasons.push(`回撤${drawdownPct.toFixed(1)}% ≥ ${CONFIG.capitalGuardian.drawdownHaltThreshold}% → 交易暂停`);
      console.log(`🛡️ [资本守护] ❌ ${reasons[0]}`);
      return { passed: false, riskMultiplier: 0, reason: reasons.join('; ') };
    }
    
    if (drawdownPct >= CONFIG.capitalGuardian.drawdownReduceThreshold) {
      reasons.push(`回撤${drawdownPct.toFixed(1)}% ≥ ${CONFIG.capitalGuardian.drawdownReduceThreshold}% → 风险减半`);
      console.log(`🛡️ [资本守护] ⚠️ ${reasons[0]}`);
      return { passed: true, riskMultiplier: 0.5, reason: reasons.join('; ') };
    }
    
    console.log(`🛡️ [资本守护] ✅ 回撤${drawdownPct.toFixed(1)}% 正常 | 峰值${state.peakBalance.toFixed(0)}U 当前${currentBalance.toFixed(0)}U | 连亏${state.consecutiveLosses}次`);
  }
  
  // 4. 连亏接近阈值警告
  if (state.consecutiveLosses >= CONFIG.capitalGuardian.lossStreakCooldown - 1) {
    reasons.push(`连亏${state.consecutiveLosses}次，接近冷却阈值${CONFIG.capitalGuardian.lossStreakCooldown}`);
    return { passed: true, riskMultiplier: 0.5, reason: reasons.join('; ') };
  }
  
  return { passed: true, riskMultiplier: 1.0, reason: '资本守护通过' };
}

// ============== Layer 1: 硬性规则检查 ==============
async function hardRulesValidation(signal, messageTimestamp) {
  const errors = [];
  const warnings = [];
  
  console.log('\n🔍 [Layer 1] 硬性规则检查...');
  
  // 1. 时间验证
  const now = Date.now();
  const signalAge = (now - messageTimestamp) / 1000 / 60; // 分钟
  
  if (signalAge > CONFIG.hardRules.maxSignalAgeMinutes) {
    errors.push(`信号过期: ${signalAge.toFixed(1)} 分钟 (阈值: ${CONFIG.hardRules.maxSignalAgeMinutes} 分钟)`);
  } else {
    console.log(`✅ 时间验证通过: ${signalAge.toFixed(1)} 分钟`);
  }
  
  // 2. 必要字段检查
  if (!signal.direction || !signal.pair) {
    errors.push('缺少必要字段: direction 或 pair');
  } else {
    console.log(`✅ 字段验证通过: ${signal.pair} ${signal.direction.toUpperCase()}`);
  }
  
  // 3. 止损检查（铁规则：无论市价单还是限价单，无止损一律拒绝）
  if (CONFIG.hardRules.requireStopLoss && !signal.sl) {
    errors.push('缺少止损价格 (SL)，无止损不下单');
  } else if (signal.sl) {
    console.log(`✅ 止损设置: ${signal.sl}`);
  } else if (!CONFIG.hardRules.requireStopLoss && !signal.sl) {
    // requireStopLoss=false时打印警告（不应出现此情况）
    console.log(`⚠️ 无止损信号（配置允许，请检查requireStopLoss配置）`);
  }
  
  // 4. 杠杆检查
  const leverage = parseInt(signal.leverage?.replace('x', '') || '10');
  if (leverage < CONFIG.hardRules.minLeverage || leverage > CONFIG.hardRules.maxLeverage) {
    errors.push(`杠杆超出范围: ${leverage}x (允许: ${CONFIG.hardRules.minLeverage}-${CONFIG.hardRules.maxLeverage})`);
  } else {
    console.log(`✅ 杠杆验证通过: ${leverage}x`);
  }
  
  // 5. 订单类型识别
  const orderType = signal.entry ? 'limit' : 'market';
  console.log(`📋 订单类型: ${orderType === 'limit' ? '限价单' : '市价单'} ${signal.entry ? `@ ${signal.entry}` : ''}`);
  
  // 6. SL方向合理性验证（进化新增）
  if (signal.entry && signal.sl) {
    const isBuy = signal.direction === 'buy';
    if (isBuy && signal.sl >= signal.entry) {
      errors.push(`多单止损(${signal.sl})不能高于入场价(${signal.entry})`);
    } else if (!isBuy && signal.sl <= signal.entry) {
      errors.push(`空单止损(${signal.sl})不能低于入场价(${signal.entry})`);
    }
  }
  
  // 7. SL数值合理性（防止解析错误导致异常值）
  if (signal.entry && signal.sl) {
    const slDeviation = Math.abs(signal.sl - signal.entry) / signal.entry;
    if (slDeviation > 0.5) {
      errors.push(`止损偏离入场价超过50%(${(slDeviation*100).toFixed(0)}%)，疑似解析错误`);
    }
  }
  
  // 8. TP方向合理性验证（进化新增）
  if (signal.entry && signal.tp && signal.tp.length > 0) {
    const isBuy = signal.direction === 'buy';
    const tp1 = signal.tp[0];
    if (isBuy && tp1 <= signal.entry) {
      warnings.push(`多单TP(${tp1})低于入场价，方向可疑`);
    } else if (!isBuy && tp1 >= signal.entry) {
      warnings.push(`空单TP(${tp1})高于入场价，方向可疑`);
    }
  }
  
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    metadata: {
      signalAge,
      orderType,
      leverage
    }
  };
}

// ============== Layer 1.5: 实时账户余额检查 ==============
async function accountBalanceCheck(signal) {
  try {
    const crypto = require('crypto');
    const https = require('https');
    const apiKey = process.env.OKX_API_KEY;
    const secret = process.env.OKX_SECRET_KEY;
    const pass = process.env.OKX_PASSPHRASE;
    const useDemo = process.env.OKX_USE_DEMO !== 'false';

    function okxGet(path) {
      return new Promise((resolve, reject) => {
        const ts = new Date().toISOString();
        const sig = crypto.createHmac('sha256', secret).update(ts + 'GET' + path + '').digest('base64');
        const opts = {
          hostname: 'www.okx.com', port: 443, method: 'GET', path,
          headers: {
            'OK-ACCESS-KEY': apiKey, 'OK-ACCESS-SIGN': sig,
            'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': pass,
            'Content-Type': 'application/json',
            ...(useDemo ? { 'x-simulated-trading': '1' } : {})
          }
        };
        const req = https.request(opts, res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
        });
        req.on('error', reject);
        req.end();
      });
    }

    // 查USDT余额
    const balData = await okxGet('/api/v5/account/balance');
    const usdt = balData.data?.[0]?.details?.find(d => d.ccy === 'USDT');
    const usdtEq = parseFloat(usdt?.eq || 0);
    const usdtAvail = parseFloat(usdt?.availEq || usdt?.availBal || 0);

    // 查持仓保证金
    const posData = await okxGet('/api/v5/account/positions?instType=SWAP');
    const usedMargin = (posData.data || [])
      .filter(p => parseFloat(p.pos) !== 0)
      .reduce((sum, p) => sum + parseFloat(p.imr || 0), 0);

    // 估算本次所需保证金
    const leverage = parseInt(signal.leverage?.replace('x', '') || '10');
    const entry = signal.entry || 0;
    const estimatedMargin = entry > 0 ? (usdtEq * 0.02 * leverage) / entry * entry / leverage : usdtEq * 0.02;
    // 保守估算：单笔最大20%
    const maxMargin = usdtEq * 0.2;

    console.log(`💰 [Layer1.5] USDT: eq=${usdtEq.toFixed(2)} avail=${usdtAvail.toFixed(2)} | 已用保证金: ${usedMargin.toFixed(2)} | 60%上限: ${(usdtEq*0.6).toFixed(2)}`);

    const errors = [];

    // 检查1: USDT可用余额是否足够开单
    if (usdtAvail < 50) {
      errors.push(`USDT可用余额不足(${usdtAvail.toFixed(2)}U < 50U)，无法开单`);
    }
    // 检查2: 全局保证金是否超60%
    if (usedMargin > usdtEq * 0.6) {
      errors.push(`全局保证金已超60%(${(usedMargin/usdtEq*100).toFixed(0)}%)，拒绝新单`);
    }
    // 检查3: 可用余额是否够开仓（修复：原条件maxMargin > usdtEq*0.2永远false）
    const minViableMargin = usdtEq * 0.05; // 可用余额至少要有权益5%才够开最小单
    if (usdtAvail < minViableMargin) {
      errors.push(`可用余额(${usdtAvail.toFixed(2)}U)过低，无法开仓（需至少${minViableMargin.toFixed(2)}U）`);
    }

    return { passed: errors.length === 0, errors, usdtEq, usdtAvail, usedMargin };
  } catch(e) {
    console.log(`⚠️ [Layer1.5] 账户余额查询失败: ${e.message}，放行（不因查询失败阻塞）`);
    return { passed: true, errors: [], usdtEq: 0, usdtAvail: 0, usedMargin: 0 };
  }
}
async function geminiValidation(signal, hardRulesResult, marketData) {
  if (!CONFIG.gemini.enabled || !CONFIG.gemini.apiKey) {
    console.log('⚠️  Gemini AI 未配置，启用本地规则降级验证...');
    // 降级模式：本地规则补充检查（RR + 流动性 + 成交量）
    const fallbackChecks = [];
    // RR检查：有TP才验证RR；无TP则跳过（交易员不发TP很常见），仅做止损距离检查
    if (signal.entry && signal.sl && signal.tp?.length > 0) {
      const risk = Math.abs(signal.entry - signal.sl);
      const reward = Math.abs(signal.tp[0] - signal.entry);
      const rr = risk > 0 ? reward / risk : 0;
      if (rr < 1.5) {
        return { passed: false, reason: `降级验证: RR=${rr.toFixed(2)} 低于1.5`, data: { rr } };
      }
      fallbackChecks.push(`RR=${rr.toFixed(2)} ✅`);
    } else if (signal.entry && signal.sl) {
      // 无TP: 只验证止损距离合理（不超过15%），不卡RR
      const slDist = Math.abs(signal.entry - signal.sl) / signal.entry;
      if (slDist > 0.15) {
        return { passed: false, reason: `降级验证: 无TP且止损距离过大${(slDist*100).toFixed(1)}%`, data: { slDist } };
      }
      fallbackChecks.push(`无TP-止损距离${(slDist*100).toFixed(1)}% ✅`);
    }
    // 流动性检查（24h成交额>100万U）
    if (marketData?.volCcy24h) {
      const vol = parseFloat(marketData.volCcy24h) * (marketData.last || 1);
      if (vol < 1000000) {
        return { passed: false, reason: `降级验证: 24h成交额不足(${(vol/1000).toFixed(0)}K U)`, data: { vol } };
      }
      fallbackChecks.push(`流动性=${(vol/1000000).toFixed(1)}M ✅`);
    }
    // 价差检查（bid-ask spread过大说明流动性差）
    if (marketData?.bidPx && marketData?.askPx) {
      const spread = (parseFloat(marketData.askPx) - parseFloat(marketData.bidPx)) / parseFloat(marketData.last || marketData.askPx);
      if (spread > 0.005) { // spread > 0.5% 拒绝
        return { passed: false, reason: `降级验证: 买卖价差过大 ${(spread*100).toFixed(2)}%`, data: { spread } };
      }
      fallbackChecks.push(`价差=${(spread*100).toFixed(3)}% ✅`);
    }
    // SL合理性复查（止损不能超过入场价的15%，已被Layer1检查过50%，这里收紧）
    if (signal.entry && signal.sl) {
      const slDist = Math.abs(signal.entry - signal.sl) / signal.entry;
      if (slDist > 0.15) {
        return { passed: false, reason: `降级验证: 止损距离过大 ${(slDist*100).toFixed(1)}% (阈值15%)`, data: { slDist } };
      }
      fallbackChecks.push(`SL距离=${(slDist*100).toFixed(1)}% ✅`);
    }
    console.log(`✅ 本地降级验证通过: ${fallbackChecks.join(' | ')}`);
    return { passed: true, reason: `本地降级验证通过 [${fallbackChecks.join(', ')}]` };
  }
  
  console.log('\n🤖 [Layer 2] Gemini AI 智能风控分析...');
  
  try {
    // 获取 TradingView 技术分析数据（并发，最多等待5秒）
    let tvData = null;
    try {
      tvData = await getTradingViewData(signal.pair);
      if (tvData) {
        console.log(`📊 [TradingView] ${signal.pair}: RSI=${tvData.rsi?.toFixed(1)} EMA20=${tvData.ema20?.toFixed(0)} EMA200=${tvData.ema200?.toFixed(0)}`);
      }
    } catch (e) {
      console.log('⚠️  TradingView 数据获取失败，降级使用 OKX 数据');
    }
    
    // 构建 Gemini 提示词
    const prompt = buildGeminiPrompt(signal, hardRulesResult, marketData, tvData);
    
    // 调用 Gemini API
    const url = `${CONFIG.gemini.baseUrl}/v1/chat/completions`;
    
    const response = await axios.post(url, {
      model: CONFIG.gemini.model,
      messages: [
        {
          role: 'system',
          content: `你是一个专业的加密货币跟单交易风控智能体。你的职责是评估每笔跟单信号的风险，做出批准或拒绝的决策。

## 跟单交易核心知识

**交易员可信度权重（影响你的决策严格程度）：**
- 权重 ≥ 1.2x（A级）：舒琴、ajmal、wallstreet-queen → 历史胜率高，可适当放宽价差容忍
- 权重 0.8-1.1x（B级）：币圈所长、加密大漂亮nick、tareeq、三木 → 正常审核
- 权重 ≤ 0.5x（D级）：soul、比特币军长 → 严格审核，置信度阈值提高20%

**跟单信号质量判断：**
- 优质信号：有明确入场价、止损、止盈，RR≥1.5，信号龄<3分钟
- 中等信号：有入场和止损但无止盈（系统自动推算TP），RR=2.0，可接受
- 劣质信号：无止损，或价差>5%，或仅有方向无价位

**市场环境判断辅助：**
- 恐贪指数<20（极度恐惧）：只批准顺势信号，空单优先，多单RR要求提高至2.5
- 24h波动率>10%：价差容忍度可放宽至5%（高波动正常）
- 24h波动率<3%：价差容忍度收紧至1.5%（低波动价差大说明信号过时）

**仓位管理（你的建议要参考）：**
- 单笔最大风险：账户余额2%
- A级交易员可建议加仓至2.5%，D级降至0.5%
- 保证金不超过余额10%

你必须严格按照以下 JSON 格式返回结果，不要添加任何其他文字：
{
  "decision": "APPROVE" 或 "REJECT",
  "confidence": 0-100 的整数,
  "reason": "决策理由（中文）",
  "risk_level": "LOW" 或 "MEDIUM" 或 "HIGH" 或 "EXTREME",
  "suggested_adjustments": {
    "leverage": "建议杠杆（如果需要调整）",
    "position_size": "建议仓位比例（如果需要调整）",
    "sl": "建议止损价（如果需要调整）",
    "tp": "建议止盈价（如果需要调整）"
  },
  "market_analysis": "简短的市场分析（中文，含顺势/逆势判断）"
}

**风控原则（按优先级）：**
1. 无止损 = 强制拒绝，无论任何情况
2. SL方向错误（多单SL>entry，空单SL<entry）= 强制拒绝
3. 价差超过阈值且非高波动市场 = 拒绝（限价单放宽至8%，市价单3%）
4. RR < 1.5:1 = 拒绝（A级交易员可放宽至1.2:1）
5. 信号龄 > 5分钟 = 拒绝
6. 杠杆 > 20x 且无明确止损 = 拒绝
7. 24h振幅 > 15% 时提高警惕，降低置信度阈值
8. 24h成交额 < 100万USDT = 拒绝（流动性不足，滑点风险极大）
9. 24h成交额 < 1000万USDT 时降低置信度10%（中低流动性）
10. 买卖价差 > 0.1% 时注意滑点风险，建议限价单而非市价单`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,  // 适中温度，平衡一致性和完整性
      max_tokens: 2000   // 增加 token 限制，确保响应完整
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.gemini.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000  // 15秒超时
    });
    
    // 解析 Gemini 响应
    let aiResponse = response.data.choices[0].message.content.trim();
    
    // 移除可能的 markdown 代码块标记
    aiResponse = aiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    
    console.log('🤖 Gemini 原始响应:', aiResponse.substring(0, 500) + (aiResponse.length > 500 ? '...' : ''));
    
    // 尝试直接解析整个响应
    let aiDecision;
    try {
      aiDecision = JSON.parse(aiResponse);
    } catch (e) {
      // 如果直接解析失败，尝试提取 JSON 对象
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('❌ Gemini 响应格式错误，无法解析 JSON');
        console.error('原始响应:', aiResponse);
        return { passed: false, reason: 'AI 响应格式错误: ' + e.message };
      }
      
      try {
        aiDecision = JSON.parse(jsonMatch[0]);
      } catch (e2) {
        console.error('❌ JSON 解析失败:', e2.message);
        console.error('提取的JSON:', jsonMatch[0]);
        return { passed: false, reason: 'AI 响应 JSON 解析失败: ' + e2.message };
      }
    }
    
    console.log(`\n🤖 Gemini 决策: ${aiDecision.decision}`);
    console.log(`📊 置信度: ${aiDecision.confidence}%`);
    console.log(`⚠️  风险等级: ${aiDecision.risk_level}`);
    console.log(`💡 理由: ${aiDecision.reason}`);
    console.log(`📈 市场分析: ${aiDecision.market_analysis}`);
    
    if (aiDecision.suggested_adjustments) {
      console.log(`🔧 建议调整:`, aiDecision.suggested_adjustments);
    }
    
    return {
      passed: aiDecision.decision === 'APPROVE',
      reason: aiDecision.reason,
      data: {
        ...aiDecision,
        currentPrice: marketData?.last,
      }
    };
    
  } catch (e) {
    console.error('❌ Gemini API 调用失败:', e.response?.data || e.message);
    
    // Gemini 失败时，降级为基础规则验证
    console.log('⚠️  降级为基础规则验证...');
    return fallbackValidation(signal, marketData);
  }
}

// 构建 Gemini 提示词
function buildGeminiPrompt(signal, hardRulesResult, marketData, tvData = null) {
  const spread = signal.entry && marketData?.last 
    ? ((Math.abs(marketData.last - signal.entry) / signal.entry) * 100).toFixed(2)
    : 'N/A';
  
  const volatility24h = marketData?.high24h && marketData?.low24h
    ? (((marketData.high24h - marketData.low24h) / marketData.low24h) * 100).toFixed(2)
    : 'N/A';
  
  // 流动性评估（基于24h USDT成交量）
  const volUSDT = marketData?.volCcy24h || (marketData?.vol24h && marketData?.last ? marketData.vol24h * marketData.last : 0);
  let liquidityGrade = 'N/A';
  if (volUSDT > 0) {
    if (volUSDT > 500000000) liquidityGrade = '🟢 极高流动性 (>5亿U)';
    else if (volUSDT > 100000000) liquidityGrade = '🟢 高流动性 (>1亿U)';
    else if (volUSDT > 10000000) liquidityGrade = '🟡 中等流动性 (>1000万U)';
    else if (volUSDT > 1000000) liquidityGrade = '🟠 低流动性 (>100万U) — 滑点风险';
    else liquidityGrade = '🔴 极低流动性 (<100万U) — 高滑点风险，建议拒绝';
  }
  
  // 买卖价差（衡量即时流动性）
  const bidAskSpread = marketData?.bid && marketData?.ask
    ? (((marketData.ask - marketData.bid) / marketData.bid) * 100).toFixed(4)
    : 'N/A';
  
  let rrRatio = 'N/A';
  if (signal.sl && signal.tp && signal.tp.length > 0 && signal.entry) {
    const risk = Math.abs(signal.entry - signal.sl);
    const reward = Math.abs(signal.tp[0] - signal.entry);
    rrRatio = risk > 0 ? (reward / risk).toFixed(2) : 'N/A';
  }
  
  return `请评估以下交易信号的风险：

## 交易信号
- 交易员: ${signal._traderName || '未知'} (权重: ${signal._traderWeight || 1.0}x)
- 交易对: ${signal.pair}
- 方向: ${signal.direction?.toUpperCase()}
- 入场价: ${signal.entry || '未指定（市价单）'}
- 止损 (SL): ${signal.sl || '未设置'}
- 止盈 (TP): ${signal.tp?.length ? signal.tp.join(', ') + (signal._tpAutoSet ? '（系统自动推算，RR=2.0）' : '') : '未设置'}
- 杠杆: ${signal.leverage || '10x'}
- 订单类型: ${hardRulesResult.metadata.orderType === 'limit' ? '限价单' : '市价单'}
- 信号龄: ${hardRulesResult.metadata.signalAge.toFixed(1)} 分钟

## OKX 实时市场数据
- 当前价格: ${marketData?.last || 'N/A'}
- 买一价 (Bid): ${marketData?.bid || 'N/A'}
- 卖一价 (Ask): ${marketData?.ask || 'N/A'}
- 买卖价差: ${bidAskSpread}%${bidAskSpread !== 'N/A' && parseFloat(bidAskSpread) > 0.1 ? ' ⚠️ 价差偏大' : ''}
- 24h最高: ${marketData?.high24h || 'N/A'}
- 24h最低: ${marketData?.low24h || 'N/A'}
- 24h成交量: ${marketData?.vol24h || 'N/A'}
- 24h成交额(USDT): ${volUSDT > 0 ? (volUSDT > 1e6 ? (volUSDT/1e6).toFixed(1) + 'M' : volUSDT.toFixed(0)) : 'N/A'}
- 流动性评级: ${liquidityGrade}

## TradingView 技术分析${tvData ? '' : '（数据不可用）'}
${tvData ? `- 当前价: $${tvData.price} (${tvData.change24h}% 24h)
- RSI: ${tvData.rsi?.toFixed(1) || 'N/A'}${tvData.rsi > 70 ? ' ⚠️ 超买' : tvData.rsi < 30 ? ' ⚠️ 超卖' : ' ✅ 正常区间'}
- EMA20: ${tvData.ema20?.toFixed(2) || 'N/A'} | EMA200: ${tvData.ema200?.toFixed(2) || 'N/A'}
- 布林带上轨: ${tvData.bbUpper?.toFixed(2) || 'N/A'} | 下轨: ${tvData.bbLower?.toFixed(2) || 'N/A'}
- 趋势判断: ${tvData.ema20 && tvData.ema200 ? (tvData.ema20 > tvData.ema200 ? '📈 多头排列（EMA20>EMA200）' : '📉 空头排列（EMA20<EMA200）') : 'N/A'}
- 价格位置: ${tvData.price && tvData.bbUpper && tvData.bbLower ? 
    (tvData.price > tvData.bbUpper ? '突破布林带上轨（谨慎追多）' :
     tvData.price < tvData.bbLower ? '跌破布林带下轨（谨慎追空）' : '布林带内正常波动') : 'N/A'}` : '- 无法获取 TradingView 技术数据，仅凭 OKX 市场数据判断'}

## 计算指标
- 价差（信号价 vs 当前价）: ${spread}%
- 24h波动率: ${volatility24h}%
- 风险回报比: ${rrRatio}

## 原始信号文本
${signal.raw || '无'}

请根据以上信息进行风险评估并给出决策。`;
}

// 降级验证（Gemini 不可用时）
function fallbackValidation(signal, marketData) {
  console.log('🔄 执行降级验证...');
  
  if (!marketData?.last) {
    return { passed: false, reason: '降级验证: 无法获取实时价格' };
  }
  
  // 价格合理性检查（限价单和市价单分开处理）
  if (signal.entry) {
    const priceDiff = Math.abs(marketData.last - signal.entry) / marketData.last;
    const isLimit = !!signal.entry;
    // 限价单允许偏离8%（等待挂单），市价单只允许3%
    const threshold = isLimit ? 0.08 : 0.03;
    if (priceDiff > threshold) {
      return {
        passed: false,
        reason: `降级验证: 价差过大 ${(priceDiff * 100).toFixed(2)}% (阈值: ${threshold * 100}%)`,
        data: { currentPrice: marketData.last, spread: priceDiff }
      };
    }
  }
  
  // 高杠杆无止损检查
  const leverage = parseInt(signal.leverage?.replace('x', '') || '10');
  if (leverage > 20 && !signal.sl) {
    return {
      passed: false,
      reason: `降级验证: 高杠杆 (${leverage}x) 且无止损`,
      data: { leverage }
    };
  }
  
  return {
    passed: true,
    reason: '降级验证通过（基础规则）',
    data: { currentPrice: marketData.last }
  };
}

// ============== Telegram 通知 ==============
async function sendTelegramNotification(message) {
  if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken) {
    return;
  }
  
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`,
      {
        chat_id: CONFIG.telegram.chatId,
        text: message,
        parse_mode: 'HTML'
      }
    );
    console.log('📱 Telegram 通知已发送');
  } catch (e) {
    console.error('⚠️  Telegram 通知发送失败:', e.message);
  }
}

// ============== 主验证流程 ==============
async function validateTrade(signal, messageTimestamp = Date.now()) {
  console.log('\n' + '='.repeat(60));
  console.log('🛡️  风控智能体启动');
  console.log('='.repeat(60));
  console.log('信号:', JSON.stringify(signal, null, 2));
  
  const result = {
    approved: false,
    layer0: null,   // 资本守护
    layer1: null,
    layer2: null,
    finalDecision: '',
    timestamp: new Date().toISOString()
  };
  
  // Layer 0: 资本守护（回撤+连亏检查）
  result.layer0 = await capitalGuardianCheck();
  
  if (!result.layer0.passed) {
    result.finalDecision = `🛡️ [资本守护] ${result.layer0.reason}`;
    console.log('\n' + result.finalDecision);
    
    await sendTelegramNotification(
      `🛡️ <b>交易被资本守护拦截</b>\n\n` +
      `币种: ${signal.pair}\n` +
      `方向: ${signal.direction?.toUpperCase()}\n` +
      `原因: ${result.layer0.reason}\n\n` +
      `💡 系统正在保护资金安全`
    );
    
    return result;
  }
  
  // Layer 1: 硬性规则
  result.layer1 = await hardRulesValidation(signal, messageTimestamp);
  
  if (!result.layer1.passed) {
    result.finalDecision = `❌ [LAYER 1] ${result.layer1.errors.join('; ')}`;
    console.log('\n' + result.finalDecision);
    
    await sendTelegramNotification(
      `🛑 <b>交易被拒绝 [硬性规则]</b>\n\n` +
      `币种: ${signal.pair}\n` +
      `方向: ${signal.direction?.toUpperCase()}\n` +
      `原因: ${result.layer1.errors.join(', ')}`
    );
    
    return result;
  }

  // Layer 1.5: 实时账户余额检查（先查账户再下单，不靠猜）
  const balCheck = await accountBalanceCheck(signal);
  if (!balCheck.passed) {
    result.finalDecision = `❌ [LAYER 1.5 余额] ${balCheck.errors.join('; ')}`;
    console.log('\n' + result.finalDecision);
    await sendTelegramNotification(
      `🛑 <b>交易被拒绝 [余额不足]</b>\n\n` +
      `币种: ${signal.pair}\n` +
      `USDT可用: ${balCheck.usdtAvail?.toFixed(2)}U\n` +
      `已用保证金: ${balCheck.usedMargin?.toFixed(2)}U\n` +
      `原因: ${balCheck.errors.join(', ')}`
    );
    return result;
  }
  
  // 获取实时市场数据（供 Layer 2 使用）
  console.log('\n📊 获取实时市场数据...');
  const marketData = await getCurrentPrice(signal.pair);
  
  if (!marketData) {
    console.log('⚠️ 无法获取市场数据，降级为纯规则模式（跳过Gemini分析）');
    // 降级兜底：必须通过RR检查，不能直接放行
    if (signal.entry && signal.sl && signal.tp?.length > 0) {
      const risk = Math.abs(signal.entry - signal.sl);
      const reward = Math.abs(signal.tp[0] - signal.entry);
      const rr = risk > 0 ? reward / risk : 0;
      if (rr < 1.5) {
        result.approved = false;
        result.finalDecision = `❌ 降级拒绝: RR=${rr.toFixed(2)} 低于1.5（无市场数据，从严审核）`;
        result.layer2 = { passed: false, reason: `降级: RR不足 ${rr.toFixed(2)}` };
        return result;
      }
      console.log(`✅ 降级RR检查通过: ${rr.toFixed(2)}`);
    } else if (!signal.sl) {
      // 无止损无法计算RR，直接拒绝（降级模式从严）
      result.approved = false;
      result.finalDecision = '❌ 降级拒绝: 无止损且无市场数据，从严拒绝';
      result.layer2 = { passed: false, reason: '降级: 无止损无市场数据' };
      return result;
    }
    result.approved = true;
    result.finalDecision = '✅ 降级通过（网络抖动，RR检查通过，Layer1规则已满足）';
    result.layer2 = { passed: true, reason: '降级：无市场数据，RR已验证', data: {} };
    await sendTelegramNotification(
      `⚠️ <b>风控降级模式</b>\n\n` +
      `币种: ${signal.pair}\n` +
      `方向: ${signal.direction?.toUpperCase()}\n` +
      `原因: 无法获取实时市场数据（网络抖动）\n` +
      `处理: 仅执行Layer1硬性规则+RR检查，跳过Gemini AI\n` +
      `结论: ✅ 允许交易`
    );
    return result;
  }
  
  console.log(`📊 市场数据: 当前价=${marketData.last} | Bid=${marketData.bid} | Ask=${marketData.ask} | 24h量=${marketData.vol24h}`);
  
  // Layer 2: Gemini AI 智能决策
  result.layer2 = await geminiValidation(signal, result.layer1, marketData);
  
  if (!result.layer2.passed) {
    result.finalDecision = `❌ [LAYER 2 - Gemini AI] ${result.layer2.reason}`;
    console.log('\n' + result.finalDecision);
    
    const aiData = result.layer2.data || {};
    let notificationText = 
      `⚠️ <b>Gemini AI 风控拒绝</b>\n\n` +
      `币种: ${signal.pair}\n` +
      `方向: ${signal.direction?.toUpperCase()}\n` +
      `当前价: ${marketData.last}\n` +
      `风险等级: ${aiData.risk_level || 'N/A'}\n` +
      `置信度: ${aiData.confidence || 'N/A'}%\n` +
      `原因: ${result.layer2.reason}`;
    
    if (aiData.market_analysis) {
      notificationText += `\n\n📈 市场分析:\n${aiData.market_analysis}`;
    }
    
    if (aiData.suggested_adjustments) {
      const adj = aiData.suggested_adjustments;
      const adjustments = Object.entries(adj)
        .filter(([k, v]) => v && v !== 'null' && v !== '无')
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
      if (adjustments) {
        notificationText += `\n\n🔧 建议调整:\n${adjustments}`;
      }
    }
    
    await sendTelegramNotification(notificationText);
    
    return result;
  }
  
  // 通过所有验证
  result.approved = true;
  result.riskMultiplier = result.layer0?.riskMultiplier || 1.0; // 资本守护风险系数
  result.finalDecision = '✅ 风控验证通过，批准交易' + (result.riskMultiplier < 1 ? ` (风险×${result.riskMultiplier})` : '');
  
  console.log('\n' + '='.repeat(60));
  console.log(result.finalDecision);
  console.log('='.repeat(60));
  
  const aiData = result.layer2.data || {};
  await sendTelegramNotification(
    `✅ <b>交易已批准</b>\n\n` +
    `币种: ${signal.pair}\n` +
    `方向: ${signal.direction?.toUpperCase()}\n` +
    `类型: ${result.layer1.metadata.orderType === 'limit' ? '限价单' : '市价单'}\n` +
    `当前价: ${marketData.last}\n` +
    `信号龄: ${result.layer1.metadata.signalAge.toFixed(1)} 分钟\n` +
    `风险等级: ${aiData.risk_level || 'N/A'}\n` +
    `置信度: ${aiData.confidence || 'N/A'}%\n` +
    `AI理由: ${result.layer2.reason || 'N/A'}`
  );
  
  return result;
}

// ============== 导出 ==============
module.exports = {
  validateTrade,
  updateGuardianResult,  // 交易结束后调用，更新连亏/回撤状态
  capitalGuardianCheck,  // 独立调用检查资本守护状态
  CONFIG
};

// ============== CLI 测试 ==============
if (require.main === module) {
  console.log('🧪 风控智能体测试模式\n');
  
  // 测试信号
  const testSignal = {
    direction: 'buy',
    pair: 'BTC/USDT',
    entry: 96000,
    sl: 95000,
    tp: [98000, 99000],
    leverage: '10x',
    raw: 'BTC/USDT LONG @ 96000, SL: 95000, TP: 98000/99000, 10x'
  };
  
  // 模拟 2 分钟前的信号
  const messageTimestamp = Date.now() - (2 * 60 * 1000);
  
  validateTrade(testSignal, messageTimestamp).then(result => {
    console.log('\n📋 最终验证结果:', JSON.stringify(result, null, 2));
    process.exit(result.approved ? 0 : 1);
  }).catch(err => {
    console.error('❌ 测试失败:', err);
    process.exit(1);
  });
}
