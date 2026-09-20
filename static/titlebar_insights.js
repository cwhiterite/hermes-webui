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

// Compact integer-rounded token formatter for the context-gauge chip labels.
// Rounds to whole k/M so a gauge reads "192K / 655K" instead of
// "192.0k / 655.4k" — the decimal noise is wasted in a glanceable pressure
// read. Uses the existing _tbFmtTokens thresholds but drops the fractional part.
function _tbFmtGaugeTokens(n){
  const value = Number(n) || 0;
  if(value >= 1e6) return Math.round(value / 1e6) + 'M';
  if(value >= 1e3) return Math.round(value / 1e3) + 'K';
  return String(value);
}

function _tbMaxPriority(viewportWidth){
  const w = Number(viewportWidth) || 0;
  if(w <= 640) return 0;
  if(w <= 899) return 2;
  if(w <= 1199) return 4;
  if(w <= 1439) return 5;
  return 6;
}

// Context-pressure tone for the session-tokens chip. Measured against the
// compression threshold (where the agent actually summarizes old context), not
// the raw model window — 50% of a 1.31M window is already 100% of a ~655K
// threshold, so window-only readings understate real pressure. null when there
// is no threshold to measure against (fallback cumulative rendering).
function _tbContextTone(fraction){
  if(!Number.isFinite(fraction)) return null;
  if(fraction >= 0.95) return 'danger';
  if(fraction >= 0.80) return 'warn';
  return 'ok';
}

function _sessionTokensChip(session){
  const inputTok = Number(session.input_tokens) || 0;
  const outputTok = Number(session.output_tokens) || 0;
  const totalTok = inputTok + outputTok;
  const promptTok = Number(session.last_prompt_tokens);
  const thresholdTok = Number(session.threshold_tokens);
  const contextLen = Number(session.context_length);
  const hasThreshold = Number.isFinite(thresholdTok) && thresholdTok > 0;
  // Prefer the compression threshold as the "pressure line" (that's where
  // context actually gets re-summarized); fall back to the model window when
  // the threshold isn't reported. Fraction is prompt/threshold so ~192K/655K
  // reads ~29% pressure, not 15% of the raw 1.31M window.
  const ceiling = hasThreshold ? thresholdTok : (Number.isFinite(contextLen) ? contextLen : 0);
  const hasPrompt = Number.isFinite(promptTok) && promptTok > 0;
  const canGauge = hasPrompt && ceiling > 0;
  const frac = canGauge ? (promptTok / ceiling) : null;
  const tone = _tbContextTone(frac);
  return {
    key: 'session-tokens',
    // Context gauge when the live prompt + threshold/window are available;
    // otherwise fall back to the cumulative in+out total so the chip never
    // disappears on sessions without context metadata.
    label: canGauge
      ? `${_tbFmtGaugeTokens(promptTok)} / ${_tbFmtGaugeTokens(ceiling)} · ${Math.round(frac * 100)}%`
      : _tbFmtTokens(totalTok),
    detail: canGauge
      ? `prompt ${_tbFmtGaugeTokens(promptTok)} of ${_tbFmtGaugeTokens(ceiling)} context · ${Math.round(frac * 100)}%${hasThreshold ? ' (threshold)' : ' (window)'} · in ${_tbFmtTokens(inputTok)} / out ${_tbFmtTokens(outputTok)}`
      : 'in ' + _tbFmtTokens(inputTok) + ' / out ' + _tbFmtTokens(outputTok),
    priority: 2,
    tone,
  };
}

function buildTitlebarInsightChips(input){
  const data = input || {};
  const session = data.session || null;
  const global = data.global || null;
  const system = data.system || null;
  const chips = [];

  if(session){
    const cost = Number(session.estimated_cost) || 0;
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
    chips.push(_sessionTokensChip(session));
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