#!/usr/bin/env node
/**
 * Strict Signal Parser for OpenClaw
 * v2.0 - 华尔街聚合适配：$COIN格式、CMP市价、SL粘连数字、引用块过滤、白名单扩展
 */

const COIN_WHITELIST = 'BTC|ETH|SOL|BNB|XRP|ADA|DOGE|MATIC|DOT|AVAX|LINK|UNI|ATOM|LTC|NEAR|TRX|SEI|ARB|OP|SUI|APT|INJ|TIA|JUP|WIF|BONK|PEPE|FLOKI|TON|NOT|ORDI|SATS|BOME|MEW|POPCAT|ENS|SPX|GMT|SAND|MANA|FET|RENDER|IO|ZRO';

function tryFixStickyDecimal(slStr) {
  const m = slStr.match(/^(0+)(\d+\.?\d*)$/);
  if (!m) return null;
  const zeros = m[1].length;
  const digits = m[2];
  return parseFloat('0.' + '0'.repeat(Math.max(0, zeros - 1)) + digits);
}

function isSlDirectionValid(direction, entry, sl, tp) {
  if (!direction || typeof entry !== 'number' || Number.isNaN(entry) || typeof sl !== 'number' || Number.isNaN(sl)) return false;
  const firstTp = Array.isArray(tp) && tp.length > 0 ? tp[0] : null;
  if (direction === 'buy') {
    if (typeof firstTp === 'number' && !Number.isNaN(firstTp)) return sl < entry && entry < firstTp;
    return sl < entry;
  }
  if (direction === 'sell') {
    if (typeof firstTp === 'number' && !Number.isNaN(firstTp)) return firstTp < entry && entry < sl;
    return sl > entry;
  }
  return false;
}

function parseSignalStrict(text) {
  const result = {
    raw: text, direction: null, pair: null, entry: null, sl: null, tp: [],
    leverage: null, position_size: null, signal_type: null, confidence: 0,
    matched_patterns: [], warnings: [], auto_fixed_sl: false
  };
  if (!text || !text.trim()) { result.error = 'Empty signal'; return result; }

  // 预处理：去引用块、标记行、$前缀
  text = text.split('\n').filter(line => !line.trimStart().startsWith('>')).join('\n');
  text = text.replace(/\*\*(回复消息|回复内容|已编辑)[：:]\*\*/gi, '');
  text = text.replace(/\$([A-Z]+)/gi, '$1');

  // 1. 方向
  if (/\b(LONG|做多|多单|开多|买入|看多|BUY)\b/i.test(text) || /▲|green|多/i.test(text)) {
    result.direction = 'buy'; result.matched_patterns.push('direction:buy');
  } else if (/\b(SHORT|做空|空单|开空|卖出|看空|SELL)\b/i.test(text) || /▼|red|空/i.test(text)) {
    result.direction = 'sell'; result.matched_patterns.push('direction:sell');
  }

  // 2. 交易对
  const pairMatch = text.match(new RegExp(`\\b(${COIN_WHITELIST})\\s*\\/?\\s*(USDT|USD)\\b`, 'i'));
  if (pairMatch) {
    result.pair = pairMatch[1].toUpperCase() + '/USDT'; result.matched_patterns.push('pair:' + result.pair);
  } else {
    const soloPair = text.match(new RegExp(`\\b(${COIN_WHITELIST})\\b`, 'i'));
    if (soloPair) { result.pair = soloPair[1].toUpperCase() + '/USDT'; result.matched_patterns.push('pair:' + result.pair); }
  }

  // 3. 入场价（CMP/Market优先）
  if (/Entry\s*[:\-]?\s*(CMP|Market|current\s*price|市价)/i.test(text)) {
    result.signal_type = 'market'; result.entry = null;
    result.matched_patterns.push('entry:CMP');
    result.warnings.push('entry=CMP，需主程序取OKX实时价（时效≤3s，滑点≤0.3%，失败拒单）');
  } else {
    const entryMatch = text.match(/@\s*(\d+\.?\d*)|EP\s*[:\-]?\s*(\d+\.?\d*)|Entry\s*(?:Price)?\s*[:\-]?\s*(\d+\.?\d*)|Entries?\s*[:\-]?\s*(\d+\.?\d*)|入场\s*[:\-]?\s*(\d+\.?\d*)|入仓\s*[:\-]?\s*(\d+\.?\d*)|开仓(?:价)?\s*[:\-]?\s*(\d+\.?\d*)|at\s*[:\-]?\s*(\d+\.?\d*)/i);
    if (entryMatch) {
      result.entry = parseFloat(entryMatch[1] || entryMatch[2] || entryMatch[3] || entryMatch[4] || entryMatch[5] || entryMatch[6] || entryMatch[7] || entryMatch[8]);
      result.matched_patterns.push('entry:' + result.entry);
    } else {
      const priceAfterPair = text.match(new RegExp(`(?:${COIN_WHITELIST})\\s+(\\d+\\.?\\d*)`, 'i'));
      if (priceAfterPair) { result.entry = parseFloat(priceAfterPair[1]); result.matched_patterns.push('entry:' + result.entry); }
    }
  }

  // 5. 止盈（先于SL，供方向校验）
  const textNoLev = text.replace(/\d+\s*x\b/gi, '').replace(/\d+\s*倍\b/gi, '');
  const tpValues = [];
  const tpMatch = textNoLev.match(/(?:TP|Targets?|止盈|目标|take\s*profit)\s*[:\-]?\s*([\d\s,\.]+)/gi);
  if (tpMatch) { for (const m of tpMatch) { const nums = m.match(/\d+\.?\d*/g); if (nums) tpValues.push(...nums); } }
  if (tpValues.length > 0) { result.tp = [...new Set(tpValues.map(t => parseFloat(t)))]; result.matched_patterns.push('tp:' + result.tp.join(',')); }

  // 4. 止损（含粘连修正+方向校验）
  const slRawMatch = text.match(/SL\s*[:\-]?\s*(\S+)|Stop(?:s|loss)?\s*[:\-]?\s*(\S+)|止损(?:点)?\s*[:\-]?\s*(\S+)/i);
  if (slRawMatch) {
    const slRaw = (slRawMatch[1] || slRawMatch[2] || slRawMatch[3] || '').trim().replace(/[^\d.]/g, '');
    if (slRaw && /^\d+\.?\d*$/.test(slRaw)) {
      if (/^0\d+$/.test(slRaw) && !slRaw.includes('.')) {
        const fixedSl = tryFixStickyDecimal(slRaw);
        if (fixedSl !== null && isSlDirectionValid(result.direction, result.entry, fixedSl, result.tp)) {
          result.sl = fixedSl; result.auto_fixed_sl = true;
          result.matched_patterns.push('sl:' + result.sl + '(auto_fixed)');
          result.warnings.push('SL疑似粘连数字，已自动补位为 ' + fixedSl + '（auto_fixed=true）');
        } else {
          result.sl = null; result.warnings.push('SL补位失败或方向校验不通过（原始值:' + slRaw + '），拒单');
        }
      } else { result.sl = parseFloat(slRaw); result.matched_patterns.push('sl:' + result.sl); }
    }
  }

  // 6. 杠杆
  const levMatch = text.match(/(\d+)\s*x\b|杠杆\s*[:\-]?\s*(\d+)|leverage\s*[:\-]?\s*(\d+)|(\d+)\s*倍\b/i);
  if (levMatch) { result.leverage = parseInt(levMatch[1] || levMatch[2] || levMatch[3] || levMatch[4]); result.matched_patterns.push('leverage:' + result.leverage); }

  // 7. 仓位
  const posMatch = text.match(/仓位\s*[:\-]?\s*(\d+\.?\d*)\s*%|持仓\s*[:\-]?\s*(\d+\.?\d*)\s*%|(?:position\s*size)\s*[:\-]?\s*(\d+\.?\d*)\s*%|(?:(\d+)\s*%仓位)|(?:(\d+\.?\d*)\s*%仓位)/i);
  if (posMatch) { result.position_size = (posMatch[1] || posMatch[2] || posMatch[3] || posMatch[4] || posMatch[5]) + '%'; result.matched_patterns.push('position:' + result.position_size); }

  // 8. 信号类型
  if (/DCA|dca|加仓|added/i.test(text)) { result.signal_type = 'dca'; result.matched_patterns.push('signal_type:dca'); }
  if (/BE|breakeven|be|flat|保本/i.test(text)) { result.signal_type = 'breakeven'; result.matched_patterns.push('signal_type:breakeven'); }
  if (/close|closed|out|平仓/i.test(text)) { result.signal_type = 'close'; result.matched_patterns.push('signal_type:close'); }

  // 置信度
  let mc = 0;
  if (result.direction) mc++;
  if (result.pair) mc++;
  if (result.entry || result.signal_type === 'market') mc++;
  if (result.sl) mc++;
  if (result.tp.length > 0) mc++;
  if (result.leverage) mc++;
  if (result.position_size) mc++;
  result.confidence = Math.round((mc / 7) * 100);

  return result;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--test') {
    const tests = [
      'Buy BTC/USDT @65000 SL64000 TP68000 10x 仓位2%',
      'LONG ETH 3500 SL 3400 TP 3600 3650',
      'SHORT BTCUSDT 44000 SL 45000 TP 43000',
      'SOL 做多 180 止损 170 止盈 190 195 200 5x',
      'BTC 开空 50000 止损51000 止盈49000',
      '▲ BTC entry 65000 SL 64000 TP 68000',
      'BTC DCA 3500',
      'BTC BE 保本',
      'BTC close 平仓',
      '$SEI Short Setup: Entry: CMP TP: 0.0632 SL: 00718',
      'LONG ARB @ 1.25 SL: 1.20 TP: 1.35',
      'BTC Short Entry: Market SL: 85000 TP: 80000',
    ];
    for (const t of tests) {
      console.log('输入:', t.substring(0, 60) + (t.length > 60 ? '...' : ''));
      const r = parseSignalStrict(t);
      console.log('→ dir=' + r.direction + ' pair=' + r.pair + ' entry=' + r.entry + ' sl=' + r.sl + ' tp=' + r.tp + ' sig=' + r.signal_type + ' auto_fix=' + r.auto_fixed_sl + ' conf=' + r.confidence + '%');
      if (r.warnings.length) console.log('  warnings:', r.warnings);
      console.log('');
    }
  } else if (args.length > 0) {
    console.log(JSON.stringify(parseSignalStrict(args.join(' ')), null, 2));
  } else {
    console.log('用法: node strict-parser/index.js <signal>');
    console.log('测试: node strict-parser/index.js --test');
  }
}

module.exports = { parseSignalStrict };
