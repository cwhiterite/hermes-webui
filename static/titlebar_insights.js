// Titlebar insights — pure chip builder.
//
// Decides which compact usage/health chips the app titlebar shows, and at which
// viewport widths, from data the client already has:
//   - session usage  → S.session / S.lastUsage (cost, tokens, cache hit %)
//   - global usage   → /api/insights?days=30  (total_cost, total_tokens)
//   - host health    → /api/system/health     (cpu.percent, memory.percent)
//
// Kept DOM-free and dependency-free so tests can drive it directly (see
// tests/test_titlebar_insights.py). panels.js does the rendering and fetching.
//
// Priority order (most → least important); narrowing the window drops from the
// tail:
//   1 session cost · 2 session tokens · 3 session cache% ·
//   4 global cost (30d) · 5 global tokens (30d) · 6 system CPU/RAM
//
// Width tiers:
//   <= 640px : none          (iPhone)
//   <= 899px : 1-2
//   <= 1199px: 1-4
//   <= 1439px: 1-5
//   >= 1440px: all

function _tbFmtTokens(n){
  const value = Number(n) || 0;
  if(value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if(value >= 1e3) return (value / 1e3).toFixed(1) + 'k';
  return String(value);
}

function _tbFmtCost(c){
  const value = Number(c) || 0;
  if(value <= 0) return '$0';
  return '$' + (value < 0.01 ? value.toFixed(4) : value.toFixed(2));
}

function _tbMaxPriority(viewportWidth){
  const w = Number(viewportWidth) || 0;
  if(w <= 640) return 0;
  if(w <= 899) return 2;
  if(w <= 1199) return 4;
  if(w <= 1439) return 5;
  return 6;
}

function buildTitlebarInsightChips(input){
  const data = input || {};
  const session = data.session || null;
  const global = data.global || null;
  const system = data.system || null;
  const chips = [];

  if(session){
    const cost = Number(session.estimated_cost) || 0;
    const inputTok = Number(session.input_tokens) || 0;
    const outputTok = Number(session.output_tokens) || 0;
    const totalTok = inputTok + outputTok;
    const cacheRead = Number(session.cache_read_tokens) || 0;
    const cachePct = (session.cache_hit_percent === null || session.cache_hit_percent === undefined)
      ? null : Number(session.cache_hit_percent);

    if(cost > 0){
      chips.push({
        key: 'session-cost',
        label: _tbFmtCost(cost),
        detail: _tbFmtCost(cost),
        priority: 1,
      });
    }
    if(totalTok > 0){
      chips.push({
        key: 'session-tokens',
        label: _tbFmtTokens(totalTok),
        detail: 'in ' + _tbFmtTokens(inputTok) + ' / out ' + _tbFmtTokens(outputTok),
        priority: 2,
      });
    }
    if(cachePct !== null && Number.isFinite(cachePct)){
      chips.push({
        key: 'session-cache',
        label: 'cache ' + cachePct + '%',
        detail: cachePct + '% · read ' + _tbFmtTokens(cacheRead),
        priority: 3,
      });
    }
  }

  if(global){
    const cost = Number(global.total_cost) || 0;
    const tokens = Number(global.total_tokens) || 0;
    if(cost > 0){
      chips.push({
        key: 'global-cost',
        label: '30d ' + _tbFmtCost(cost),
        detail: _tbFmtCost(cost) + ' over 30 days',
        priority: 4,
      });
    }
    if(tokens > 0){
      chips.push({
        key: 'global-tokens',
        label: '30d ' + _tbFmtTokens(tokens),
        detail: _tbFmtTokens(tokens) + ' tokens over 30 days',
        priority: 5,
      });
    }
  }

  if(system){
    const cpu = (system.cpu_percent === null || system.cpu_percent === undefined) ? null : Number(system.cpu_percent);
    const mem = (system.memory_percent === null || system.memory_percent === undefined) ? null : Number(system.memory_percent);
    if(cpu !== null || mem !== null){
      const cpuText = cpu === null ? '--' : Math.round(cpu) + '%';
      const memText = mem === null ? '--' : Math.round(mem) + '%';
      const sysText = 'CPU ' + cpuText + ' / RAM ' + memText;
      chips.push({
        key: 'system',
        label: sysText,
        detail: sysText,
        priority: 6,
      });
    }
  }

  const maxPriority = _tbMaxPriority(data.viewportWidth);
  return chips
    .filter(chip => chip.priority <= maxPriority)
    .sort((a, b) => a.priority - b.priority);
}

if(typeof window !== 'undefined'){
  window.buildTitlebarInsightChips = buildTitlebarInsightChips;
}