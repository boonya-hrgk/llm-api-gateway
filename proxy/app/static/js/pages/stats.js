/* 用量统计（每日 / 每周 / 每月 三种粒度）：趋势图 + 密钥排行 + 矩阵 */
import { api } from "../api.js";
import { esc, fmtNum } from "../util.js";

let _statsCache = null;
let _statsGran = "day";
let _statsMetric = "total_tokens";   // calls | total_tokens | input_tokens | output_tokens | cache_read_tokens
let _statsDays = 7;

const STATS_GRAN_LABELS = { day: "每日", week: "每周", month: "每月" };
const STATS_METRIC_LABELS = {
  total_tokens: "总 Token",
  calls: "调用次数",
  input_tokens: "输入 Token",
  output_tokens: "输出 Token",
  cache_read_tokens: "缓存命中",
};
const STATS_GRAN_META = {
  day: {
    windowDefault: 7,
    options: [[7, "近 7 天"], [14, "近 14 天"], [30, "近 30 天"], [60, "近 60 天"]],
  },
  week: {
    windowDefault: 28,
    options: [[28, "近 4 周"], [56, "近 8 周"], [84, "近 12 周"], [182, "近 26 周"]],
  },
  month: {
    windowDefault: 90,
    options: [[90, "近 3 个月"], [180, "近 6 个月"], [365, "近 12 个月"]],
  },
};

function buildStatsDays() {
  const meta = STATS_GRAN_META[_statsGran] || STATS_GRAN_META.day;
  const sel = document.getElementById("stats-days");
  if (!sel) return;
  sel.replaceChildren();
  meta.options.forEach((pair) => {
    const o = document.createElement("option");
    o.value = pair[0];
    o.textContent = pair[1];
    sel.appendChild(o);
  });
  _statsDays = meta.windowDefault;
  sel.value = String(meta.windowDefault);
}

function setStatsGran(gran) {
  if (!STATS_GRAN_META[gran]) return;
  _statsGran = gran;
  document.querySelectorAll("#stats-gran .stats-gran-tab").forEach((t) => {
    const on = t.dataset.gran === gran;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  buildStatsDays();
  loadStats();
}

async function loadStats() {
  const days = _statsDays || 7;
  const gran = _statsGran;
  const top = parseInt(document.getElementById("rank-top").value, 10) || 10;
  const urlUsage = "/admin/stats/usage?days=" + days + "&granularity=" + gran + "&top=" + top;
  const urlMatrix = "/admin/stats/usage/matrix?days=" + days + "&granularity=" + gran;
  try {
    const [uRes, mRes] = await Promise.all([api(urlUsage), api(urlMatrix)]);
    if (!uRes.ok || !mRes.ok) throw new Error("加载失败");
    const usage = await uRes.json();
    const matrix = await mRes.json();
    _statsCache = usage;
    renderTrendChart(usage.trend);
    renderRankTable(usage.by_key);
    renderMatrix(matrix);
  } catch (e) {
    console.error(e);
    const svg = document.getElementById("trend-chart");
    if (svg) svg.innerHTML = "";
    const rt = document.getElementById("rank-tbody");
    if (rt) rt.innerHTML = '<tr><td colspan="7" class="muted">加载失败</td></tr>';
    const mh = document.getElementById("matrix-head");
    const mt = document.getElementById("matrix-tbody");
    if (mh) mh.innerHTML = "";
    if (mt) mt.innerHTML = '<tr><td colspan="4" class="muted">加载失败</td></tr>';
  }
}

function statsMetricValue(d) {
  if (_statsMetric === "calls") return d.count || 0;
  const v = d ? d[_statsMetric] : 0;
  return Math.max(0, Number(v) || 0);
}

function renderTrendChart(trend) {
  const svg = document.getElementById("trend-chart");
  const metricLabel = STATS_METRIC_LABELS[_statsMetric] || "用量";
  const granName = STATS_GRAN_LABELS[_statsGran] || "每日";
  const titleEl = document.getElementById("trend-title");
  if (titleEl) titleEl.textContent = metricLabel + "趋势（" + granName + "）";
  const legend = document.getElementById("trend-legend");
  if (legend) legend.innerHTML = '<i style="background:var(--primary)"></i>' + esc(metricLabel);

  const W = 600, H = 240;
  const padL = 40, padR = 20, padT = 20, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const list = trend || [];
  const vals = list.map(statsMetricValue);

  if (!list.length) {
    svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (H / 2) +
      '" text-anchor="middle" fill="var(--text-mute)" font-size="13">暂无数据</text>';
    return;
  }

  const maxVal = Math.max(...vals, 1);
  const n = list.length;
  const stepX = n > 1 ? chartW / (n - 1) : chartW;

  let points = "";
  let areaPoints = "";
  let xLabels = "";
  let gridLines = "";

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + (chartH / ySteps) * i;
    const val = Math.round(maxVal * (1 - i / ySteps));
    gridLines += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y +
      '" stroke="var(--border)" stroke-width="1" stroke-dasharray="3,3"/>';
    gridLines += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" ' +
      'fill="var(--text-mute)" font-size="11">' + fmtNum(val) + '</text>';
  }

  list.forEach((d, i) => {
    const x = padL + (n > 1 ? stepX * i : chartW / 2);
    const y = padT + chartH - (vals[i] / maxVal) * chartH;
    points += (i === 0 ? "" : ",") + x + "," + y;
    if (i === 0) areaPoints += x + "," + (padT + chartH) + " ";
    areaPoints += x + "," + y + " ";
    if (i === n - 1) areaPoints += x + "," + (padT + chartH);

    if (n <= 14 || i % Math.ceil(n / 10) === 0 || i === n - 1) {
      // 月粒度横轴用短年份格式（26-09）避免标签过宽重叠
      let label = d.label || String(d.date || "").slice(5);
      if (_statsGran === "month" && String(label).length > 5) label = String(label).slice(2);
      xLabels += '<text x="' + x + '" y="' + (H - 10) + '" text-anchor="middle" ' +
        'fill="var(--text-mute)" font-size="11">' + esc(label) + '</text>';
    }
  });

  const gradId = "trend-grad";
  const r = n > 60 ? 2.2 : 3;
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <polygon points="${areaPoints}" fill="url(#${gradId})"/>
    <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${list.map((d, i) => {
      const x = padL + (n > 1 ? stepX * i : chartW / 2);
      const y = padT + chartH - (vals[i] / maxVal) * chartH;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--primary)"/>`;
    }).join("")}
    ${xLabels}
  `;
}

function renderRankTable(list) {
  const tb = document.getElementById("rank-tbody");
  if (!list || !list.length) {
    tb.innerHTML = '<tr><td colspan="7" class="muted">暂无数据</td></tr>';
    return;
  }
  tb.innerHTML = list.map((d, i) => {
    const idxCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
    const keyLabel = d.key_name
      ? esc(d.key_name) + ' <span class="muted">' + esc(d.key_prefix) + "</span>"
      : esc(d.key_prefix);
    return `
      <tr>
        <td><span class="rank-idx ${idxCls}">${i + 1}</span></td>
        <td>${keyLabel}</td>
        <td class="num">${d.call_count}</td>
        <td class="num" title="${d.input_tokens}">${fmtNum(d.input_tokens)}</td>
        <td class="num" title="${d.output_tokens}">${fmtNum(d.output_tokens)}</td>
        <td class="num" title="${d.cache_read_tokens || 0}">${fmtNum(d.cache_read_tokens || 0)}</td>
        <td class="num" title="${d.total_tokens}">${fmtNum(d.total_tokens)}</td>
      </tr>
    `;
  }).join("");
}

function renderMatrix(matrix) {
  const head = document.getElementById("matrix-head");
  const tb = document.getElementById("matrix-tbody");
  const granName = STATS_GRAN_LABELS[_statsGran] || "每日";
  const titleEl = document.getElementById("matrix-title");
  if (titleEl) titleEl.textContent = "密钥 × " + granName + "明细";

  const rows = (matrix && matrix.rows) || [];
  const periods = (matrix && matrix.periods) || [];
  const colCount = 2 + periods.length; // 密钥列 + 周期列 + 合计列
  if (!rows.length) {
    head.innerHTML = "";
    tb.innerHTML = '<tr><td colspan="' + colCount + '" class="muted">暂无数据</td></tr>';
    return;
  }
  const maxCell = Math.max(1, ...rows.flatMap((r) => (r.cells || []).map((c) => c.total_tokens || 0)));

  head.innerHTML =
    "<tr><th>密钥</th>" +
    periods.map((p) => {
      const range = p.start + " ~ " + p.end;
      return '<th title="' + esc(range) + '">' + esc(p.label) + "</th>";
    }).join("") +
    '<th class="num">合计</th></tr>';

  tb.innerHTML = rows.map((r) => {
    const keyLabel = r.key_name
      ? esc(r.key_name) + ' <span class="muted">' + esc(r.key_prefix) + "</span>"
      : esc(r.key_prefix);
    const cells = (r.cells || []).map((c, i) => {
      const total = c.total_tokens || 0;
      const period = periods[i];
      const range = period ? (period.start + " ~ " + period.end) : "";
      let detail = "";
      if (period) {
        detail = period.label + "：" + c.count + " 次调用 · 输入 " + fmtNum(c.input_tokens) +
          " · 输出 " + fmtNum(c.output_tokens);
        if (c.cache_read_tokens) detail += " · 缓存命中 " + fmtNum(c.cache_read_tokens);
      }
      if (!c.count) {
        return '<td class="mc mc-zero">·</td>';
      }
      if (!total) {
        return '<td class="mc mc-zero" title="' + esc(detail) + ' · 上游未上报 token 用量">0</td>';
      }
      const alpha = Math.min(0.85, 0.10 + 0.34 * (total / maxCell));
      return '<td class="mc" title="' + esc(detail) + '（' + esc(range) + '）">' +
        '<span class="mc-cell" style="background:rgba(16,185,129,' + alpha.toFixed(3) + ')">' +
        fmtNum(total) + "</span></td>";
    }).join("");
    let sumTitle = "合计：调用 " + r.total_calls + " · 输入 " + fmtNum(r.input_tokens) +
      " · 输出 " + fmtNum(r.output_tokens);
    if (r.cache_read_tokens) sumTitle += " · 缓存命中 " + fmtNum(r.cache_read_tokens);
    return "<tr><td class=\"mc-key\">" + keyLabel + "</td>" + cells +
      '<td class="num" title="' + esc(sumTitle) + '">' + fmtNum(r.total_tokens) + "</td></tr>";
  }).join("");
}

export function bindView(root) {
  const bind = (id, fn) => {
    const el = root.querySelector("#" + id);
    if (el) el.addEventListener("change", fn);
  };
  root.querySelector("#stats-gran").addEventListener("click", (e) => {
    const btn = e.target.closest(".stats-gran-tab");
    if (!btn || btn.classList.contains("active")) return;
    setStatsGran(btn.dataset.gran);
  });
  bind("stats-days", (e) => {
    _statsDays = parseInt(e.target.value, 10) || 7;
    loadStats();
  });
  bind("stats-metric", (e) => {
    _statsMetric = e.target.value;
    if (_statsCache) renderTrendChart(_statsCache.trend);
  });
  bind("rank-top", loadStats);
  buildStatsDays();
}

export async function enter() {
  await loadStats();
}
