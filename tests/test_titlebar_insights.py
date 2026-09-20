"""Tests for the titlebar insights chip builder (static/titlebar_insights.js).

The builder is DOM-free, so it runs directly in a Node `vm` context. These
assert the priority order, the width tiers (including the iPhone case), the
per-chip presence rules, and the value formatting.
"""
import json
from pathlib import Path
import subprocess
import tempfile

REPO_ROOT = Path(__file__).resolve().parents[1]
TITLEBAR_JS = (REPO_ROOT / "static" / "titlebar_insights.js").read_text(encoding="utf-8")


def _run(script_body: str):
    script = f"""
const vm = require('vm');
const ctx = {{ console }};
vm.createContext(ctx);
vm.runInContext({json.dumps(TITLEBAR_JS)}, ctx);
const out = vm.runInContext(`(() => {{ {script_body} }})()`, ctx);
process.stdout.write(JSON.stringify(out));
"""
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
        handle.write(script)
        script_path = Path(handle.name)
    try:
        proc = subprocess.run(["node", str(script_path)], check=True, capture_output=True, text=True)
    finally:
        script_path.unlink(missing_ok=True)
    return json.loads(proc.stdout)


FULL = """
{
  session: {
    estimated_cost: 0.0042,
    input_tokens: 12000,
    output_tokens: 3456,
    cache_read_tokens: 11000,
    cache_hit_percent: 92
  },
  global: { total_cost: 1.23, total_tokens: 1234567 },
  system: { cpu_percent: 12.4, memory_percent: 43.2 }
}
"""


def test_iphone_width_shows_no_chips():
    result = _run(f"const input = Object.assign({FULL}, {{ viewportWidth: 400 }});"
                  "return buildTitlebarInsightChips(input).map(c => c.key);")
    assert result == []


def test_narrow_width_keeps_only_session_cost_and_tokens():
    result = _run(f"const input = Object.assign({FULL}, {{ viewportWidth: 800 }});"
                  "return buildTitlebarInsightChips(input).map(c => c.key);")
    assert result == ["session-cost", "session-tokens"]


def test_medium_width_adds_cache_and_global_cost():
    result = _run(f"const input = Object.assign({FULL}, {{ viewportWidth: 1000 }});"
                  "return buildTitlebarInsightChips(input).map(c => c.key);")
    assert result == ["session-cost", "session-tokens", "session-cache", "global-cost"]


def test_wide_width_adds_global_tokens():
    result = _run(f"const input = Object.assign({FULL}, {{ viewportWidth: 1300 }});"
                  "return buildTitlebarInsightChips(input).map(c => c.key);")
    assert result == ["session-cost", "session-tokens", "session-cache", "global-cost", "global-tokens"]


def test_widest_width_adds_system():
    result = _run(f"const input = Object.assign({FULL}, {{ viewportWidth: 1600 }});"
                  "return buildTitlebarInsightChips(input).map(c => c.key);")
    assert result == [
        "session-cost", "session-tokens", "session-cache",
        "global-cost", "global-tokens", "system",
    ]


def test_missing_sources_omit_their_chips():
    result = _run("""
        return buildTitlebarInsightChips({
          viewportWidth: 1600,
          session: { input_tokens: 10, output_tokens: 5 },
          global: null,
          system: null,
        }).map(c => c.key);
    """)
    assert result == ["session-tokens"]


def test_zero_cost_and_null_cache_are_omitted():
    result = _run("""
        return buildTitlebarInsightChips({
          viewportWidth: 1600,
          session: { estimated_cost: 0, input_tokens: 10, output_tokens: 5, cache_hit_percent: null },
          global: { total_cost: 0, total_tokens: 0 },
          system: null,
        }).map(c => c.key);
    """)
    assert result == ["session-tokens"]


def test_formatting_is_compact_and_cost_aware():
    result = _run("""
        return buildTitlebarInsightChips({
          viewportWidth: 1600,
          session: { estimated_cost: 0.0042, input_tokens: 12000, output_tokens: 3456, cache_read_tokens: 11000, cache_hit_percent: 92 },
          global: { total_cost: 1.23, total_tokens: 1234567 },
          system: { cpu_percent: 12.4, memory_percent: 43.2 },
        }).reduce((acc, c) => Object.assign(acc, { [c.key]: c.label }), {});
    """)
    assert result["session-cost"] == "$0.0042"
    assert result["session-tokens"] == "15.5k"
    assert result["session-cache"] == "cache 92%"
    assert result["global-cost"] == "30d $1.23"
    assert result["global-tokens"] == "30d 1.2M"
    assert result["system"] == "CPU 12% / RAM 43%"


def test_system_chip_tolerates_a_single_missing_metric():
    result = _run("""
        return buildTitlebarInsightChips({
          viewportWidth: 1600,
          session: null,
          global: null,
          system: { cpu_percent: null, memory_percent: 50 },
        }).map(c => c.label);
    """)
    assert result == ["CPU -- / RAM 50%"]


# ── Context-gauge session-tokens chip ─────────────────────────────────────────
# When the live prompt + compression threshold are present, the session-tokens
# chip becomes a pressure gauge measured against the threshold (the point where
# context actually gets re-summarized), with a `tone` field for color states.


def test_session_tokens_gauges_against_threshold():
    result = _run("""
        return buildTitlebarInsightChips({
          viewportWidth: 1600,
          session: {
            input_tokens: 12000, output_tokens: 3456,
            last_prompt_tokens: 192000,
            threshold_tokens: 655360,
            context_length: 1310720,
          },
          global: null,
          system: null,
        })[0];
    """)
    assert result["key"] == "session-tokens"
    # 192000/655360 ≈ 0.293 → 29% against the threshold (NOT 15% of the window).
    assert result["label"] == "192K / 655K · 29%"
    assert result["tone"] == "ok"
    assert "192K" in result["detail"] and "(threshold)" in result["detail"]


def test_session_tokens_gauges_falls_back_to_window_when_no_threshold():
    result = _run("""
        return buildTitlebarInsightChips({
          viewportWidth: 1600,
          session: {
            input_tokens: 10, output_tokens: 5,
            last_prompt_tokens: 500000,
            threshold_tokens: 0,
            context_length: 1000000,
          },
          global: null,
          system: null,
        })[0];
    """)
    # 500000/1000000 = 50% against the window when no threshold is reported.
    assert result["label"] == "500K / 1M · 50%"
    assert result["tone"] == "ok"
    assert "(window)" in result["detail"]


def test_session_tokens_warn_danger_tones():
    def run(prompt):
        return _run(f"""
            return buildTitlebarInsightChips({{
              viewportWidth: 1600,
              session: {{
                input_tokens: 1, output_tokens: 1,
                last_prompt_tokens: {prompt},
                threshold_tokens: 1000000,
                context_length: 2000000,
              }},
              global: null,
              system: null,
            }})[0];
        """)["tone"]
    assert run(750000) == "ok"      # 75%
    assert run(820000) == "warn"    # 82% >= 80%
    assert run(960000) == "danger"  # 96% >= 95%


def test_session_tokens_falls_back_to_cumulative_without_context_metadata():
    result = _run("""
        return buildTitlebarInsightChips({
          viewportWidth: 1600,
          session: { input_tokens: 12000, output_tokens: 3456 },
          global: null,
          system: null,
        })[0];
    """)
    # No last_prompt_tokens/threshold → cumulative in+out total, no tone.
    assert result["key"] == "session-tokens"
    assert result["label"] == "15.5k"
    assert result["tone"] is None