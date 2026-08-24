// ── Tab switching ───────────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "tab-workflow" && lastTopologyData) {
      requestAnimationFrame(() => renderTopology(lastTopologyData));
    }
  });
});

// ── Shared config ───────────────────────────────────────────────────────

async function loadConfig() {
  const res = await fetch("/api/config");
  const cfg = await res.json();
  document.getElementById("link-grafana").href = cfg.grafana_url;
  document.getElementById("link-satellite").href = cfg.satellite_url;
  document.getElementById("link-aap").href = cfg.aap_url;
  if (cfg.ansible_password_preset) {
    document.querySelector(".password-box").classList.add("hidden");
  }
  return cfg;
}
loadConfig();

function getAnsiblePassword() {
  const el = document.getElementById("ansible-password");
  return el && el.value ? el.value : undefined;
}

// ── Tab 1: playbook jobs ────────────────────────────────────────────────

const statusPill = document.getElementById("status-pill");
const consoleLog = document.getElementById("console-log");
let pollTimer = null;

function setStatusPill(el, status) {
  el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  el.className = "status-pill status-" + status;
}

const PLAYBOOK_BUTTON_IDS = ["btn-revert", "btn-verify-crypto"];

function setButtonsDisabled(disabled) {
  PLAYBOOK_BUTTON_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

async function startPlaybookJob(endpoint) {
  setButtonsDisabled(true);
  setStatusPill(statusPill, "running");
  consoleLog.textContent = "";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ansible_password: getAnsiblePassword() }),
  });
  const job = await res.json();
  if (!res.ok) {
    consoleLog.textContent = "Error: " + (job.error || "failed to start job");
    setStatusPill(statusPill, "failed");
    setButtonsDisabled(false);
    return;
  }
  pollJob(job.id);
}

function pollJob(jobId) {
  let since = 0;
  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    const res = await fetch(`/api/jobs/${jobId}?since=${since}`);
    const job = await res.json();
    if (job.log && job.log.length) {
      consoleLog.textContent += job.log.join("\n") + "\n";
      consoleLog.scrollTop = consoleLog.scrollHeight;
      since = job.log_total;
    }
    if (job.status === "success" || job.status === "failed") {
      clearInterval(pollTimer);
      setStatusPill(statusPill, job.status);
      setButtonsDisabled(false);
      if (job.error) {
        consoleLog.textContent += "\n" + job.error + "\n";
      }
    }
  }, 1200);
}

document.getElementById("btn-revert").addEventListener("click", () => startPlaybookJob("/api/playbooks/revert"));
document.getElementById("btn-verify-crypto").addEventListener("click", () => startPlaybookJob("/api/playbooks/verify-crypto"));
document.getElementById("btn-goto-workflow").addEventListener("click", () => document.getElementById("tab-btn-workflow").click());

// ── Tab 2: Agent workflow ───────────────────────────────────────────────

const workflowSelect = document.getElementById("workflow-select");
const workflowStatusPill = document.getElementById("workflow-status-pill");
const workflowResult = document.getElementById("workflow-result");
const workflowAuthError = document.getElementById("workflow-auth-error");
let workflowPollTimer = null;
let workflowStreamAbort = null;
let workflowStreamSteps = [];
let workflowStreamSessionId = null;
const workflowExpandedTools = new Set();
const workflowExpandedToolGroups = new Set();
const workflowExpandedAgents = new Set();

async function loadWorkflows() {
  workflowSelect.innerHTML = "<option value=''>Loading workflows…</option>";
  workflowAuthError.classList.add("hidden");

  const res = await fetch("/api/workflows");
  const data = await res.json();

  if (!res.ok) {
    workflowSelect.innerHTML = "<option value=''>Unavailable</option>";
    workflowAuthError.textContent = data.error || "Failed to load workflows.";
    workflowAuthError.classList.remove("hidden");
    return;
  }

  const workflows = data.workflows || [];
  if (!workflows.length) {
    workflowSelect.innerHTML = "<option value=''>No workflows found</option>";
    return;
  }

  workflowSelect.innerHTML = workflows
    .map((w) => `<option value="${w.id}">${w.name}</option>`)
    .join("");

  if (typeof loadTopology === "function") {
    loadTopology(workflowSelect.value);
  }
}

document.getElementById("btn-refresh-workflows").addEventListener("click", loadWorkflows);
loadWorkflows();

workflowResult.addEventListener("click", (e) => {
  const agentBtn = e.target.closest(".agent-step-toggle");
  if (agentBtn) {
    const agentKey = agentBtn.dataset.agentKey;
    if (!agentKey) return;
    if (workflowExpandedAgents.has(agentKey)) {
      workflowExpandedAgents.delete(agentKey);
    } else {
      workflowExpandedAgents.add(agentKey);
    }
    const running = workflowPollTimer !== null;
    workflowResult.innerHTML = renderWorkflowResult({ status: running ? "running" : "success" });
    return;
  }

  const groupBtn = e.target.closest(".tool-group-toggle");
  if (groupBtn) {
    const groupKey = groupBtn.dataset.toolGroupKey;
    if (!groupKey) return;
    if (workflowExpandedToolGroups.has(groupKey)) {
      workflowExpandedToolGroups.delete(groupKey);
    } else {
      workflowExpandedToolGroups.add(groupKey);
    }
    const running = workflowPollTimer !== null;
    workflowResult.innerHTML = renderWorkflowResult({ status: running ? "running" : "success" });
    return;
  }

  const btn = e.target.closest(".tool-call-toggle");
  if (!btn) return;
  const key = btn.dataset.toolKey;
  if (!key) return;
  if (workflowExpandedTools.has(key)) {
    workflowExpandedTools.delete(key);
  } else {
    workflowExpandedTools.add(key);
  }
  const running = workflowPollTimer !== null;
  workflowResult.innerHTML = renderWorkflowResult({ status: running ? "running" : "success" });
});

// ── Tab 2: workflow topology ────────────────────────────────────────────

const topologyEmpty = document.getElementById("topology-empty");
const topologyGraph = document.getElementById("topology-graph");
const topologyStage = document.getElementById("topology-stage");
const topologyNodesEl = document.getElementById("topology-nodes");
const topologyEdgesEl = document.getElementById("topology-edges");
const topologyLegend = document.getElementById("topology-legend");
let lastTopologyData = null;

const RANK_ORDER = ["input", "orchestrator", "agent", "output", "node"];
const TOPO_NODE_GAP_X = 52;
const TOPO_NODE_GAP_Y = 44;
const TOPO_DOMAIN_PAD = 48;

function estimateNodeSize(node) {
  const type = RANK_ORDER.includes(node.type) ? node.type : "node";
  const att = node.attachments || {};
  const hasMeta =
    (att.llm && att.llm.length) || (att.mcp && att.mcp.length) || (att.tools && att.tools.length);

  if (type === "input" || type === "output") {
    return { w: 130, h: 140 };
  }

  let h = 96;
  if (hasMeta) h += 18;
  const labelLen = (node.label || "").length;
  const w = Math.max(120, Math.min(200, labelLen * 6.5));
  return { w, h };
}

/**
 * Place nodes in a wrapping grid inside the domain box.
 * Keeps a fixed number of columns; respects measured or estimated sizes.
 */
function placeGrid(nodes, getSize, startX, startY, cols, gapX, gapY, positions) {
  // Group into rows
  const rows = [];
  for (let i = 0; i < nodes.length; i += cols) {
    rows.push(nodes.slice(i, i + cols));
  }

  let y = startY;
  rows.forEach((row) => {
    const rowH = Math.max(...row.map((n) => getSize(n).h));
    let x = startX;
    row.forEach((node) => {
      const sz = getSize(node);
      positions[node.id] = { x: x + sz.w / 2, y: y + rowH / 2 };
      x += sz.w + gapX;
    });
    y += rowH + gapY;
  });

  // Total dimensions consumed
  const maxRowW = rows.reduce((max, row) => {
    const w = row.reduce((s, n) => s + getSize(n).w, 0) + (row.length - 1) * gapX;
    return Math.max(max, w);
  }, 0);
  const totalH = rows.reduce((s, row) => s + Math.max(...row.map((n) => getSize(n).h)), 0)
    + (rows.length - 1) * gapY;
  return { gridW: maxRowW, gridH: totalH };
}

function layoutTopologyNodes(data, width, height, measuredSizes = null) {
  const padX = 48;
  const padY = 48;
  const stageGap = 96;

  const byRank = {};
  RANK_ORDER.forEach((r) => (byRank[r] = []));
  data.nodes.forEach((n) => {
    const rank = RANK_ORDER.includes(n.type) ? n.type : "node";
    byRank[rank].push(n);
  });

  const sizeById = {};
  const getSize = (node) => {
    const s = measuredSizes?.[node.id] || estimateNodeSize(node);
    sizeById[node.id] = s;
    return s;
  };

  const positions = {};
  let xOff = padX;
  let inputLabelX = null;
  let outputLabelX = null;

  // ── Input node (left, vertically centred later) ──
  const inputNodes = byRank.input;
  let inputColW = 0;
  if (inputNodes.length) {
    const sz = getSize(inputNodes[0]);
    inputColW = sz.w;
    inputLabelX = xOff + sz.w / 2;
    // y is set after we know domain height
    inputNodes.forEach((node) => {
      positions[node.id] = { x: xOff + sz.w / 2, y: 0 }; // placeholder
    });
    xOff += sz.w + stageGap;
  }

  // ── Domain box (orchestrator + agents in a grid) ──
  const masOrch = byRank.orchestrator;
  const masAgents = [...byRank.agent, ...byRank.node];
  const domainNodes = [...masOrch, ...masAgents];
  let domainBox = null;
  let domainCenterY = 0;

  if (domainNodes.length) {
    // Decide column count: prefer 3 cols, at most ceil(sqrt(n))
    const cols = domainNodes.length <= 3
      ? domainNodes.length
      : domainNodes.length <= 6
        ? 3
        : 4;

    const gridStartX = xOff + TOPO_DOMAIN_PAD;
    const gridStartY = TOPO_DOMAIN_PAD;

    const { gridW, gridH } = placeGrid(
      domainNodes, getSize,
      gridStartX, gridStartY,
      cols, TOPO_NODE_GAP_X, TOPO_NODE_GAP_Y,
      positions,
    );

    const domainW = gridW + TOPO_DOMAIN_PAD * 2;
    const domainH = gridH + TOPO_DOMAIN_PAD * 2;

    domainBox = {
      left: xOff,
      top: padY,
      width: domainW,
      height: domainH,
    };
    domainCenterY = padY + domainH / 2;

    // Shift all domain node positions by padY so they sit inside the box
    domainNodes.forEach((node) => {
      positions[node.id].y += padY;
    });

    xOff = domainBox.left + domainW + stageGap;
  }

  // Compute the vertical centre of the whole canvas based on the domain box
  const canvasH = domainBox
    ? domainBox.top + domainBox.height + padY
    : Math.max(300, height);
  const centerY = domainBox ? domainCenterY : padY + canvasH / 2;

  // Fix input/output y now that we know centerY
  inputNodes.forEach((node) => {
    positions[node.id].y = centerY;
  });

  // ── Output node (right, centred with domain box) ──
  const outputNodes = byRank.output;
  if (outputNodes.length) {
    const sz = getSize(outputNodes[0]);
    outputLabelX = xOff + sz.w / 2;
    outputNodes.forEach((node) => {
      positions[node.id] = { x: xOff + sz.w / 2, y: centerY };
    });
  }

  return {
    positions,
    sizeById,
    typeById: Object.fromEntries(
      data.nodes.map((n) => [n.id, RANK_ORDER.includes(n.type) ? n.type : "node"]),
    ),
    domainBox,
    inputLabelX,
    outputLabelX,
    centerY,
    padY,
  };
}

function measureTopologyNodes() {
  const measured = {};
  topologyNodesEl.querySelectorAll("[data-node-id]").forEach((el) => {
    measured[el.dataset.nodeId] = {
      w: el.offsetWidth,
      h: el.offsetHeight,
    };
  });
  return measured;
}

function applyTopologyPositions(positions) {
  topologyNodesEl.querySelectorAll("[data-node-id]").forEach((el) => {
    const pos = positions[el.dataset.nodeId];
    if (!pos) return;
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";
  });
}

function ensureTopologyArrowMarkers() {
  const SVG_NS = "http://www.w3.org/2000/svg";
  let defs = topologyEdgesEl.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs");
    topologyEdgesEl.appendChild(defs);
  }
  if (!defs.querySelector("#topo-flow-arrow")) {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", "topo-flow-arrow");
    marker.setAttribute("markerWidth", "10");
    marker.setAttribute("markerHeight", "10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("orient", "auto");
    const head = document.createElementNS(SVG_NS, "path");
    head.setAttribute("d", "M0,0 L10,5 L0,10 z");
    head.setAttribute("class", "flow-arrow-head");
    marker.appendChild(head);
    defs.appendChild(marker);
  }
}

function drawFlowArrow(x1, y1, x2, y2, label) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  line.setAttribute("class", "link link-flow-arrow");
  line.setAttribute("marker-end", "url(#topo-flow-arrow)");
  topologyEdgesEl.appendChild(line);

  if (label) {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String((x1 + x2) / 2));
    text.setAttribute("y", String((y1 + y2) / 2 - 10));
    text.setAttribute("class", "flow-arrow-label");
    text.setAttribute("text-anchor", "middle");
    text.textContent = label;
    topologyEdgesEl.appendChild(text);
  }
}

/**
 * Returns the point on a rectangle's border that lies in the direction of (targetX, targetY).
 * cx/cy = centre, w/h = full dimensions.
 */
function rectEdgePoint(cx, cy, w, h, targetX, targetY) {
  const dx = targetX - cx;
  const dy = targetY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = w / 2;
  const hh = h / 2;
  // Which rectangle side does the direction ray hit first?
  if (Math.abs(dx) * hh >= Math.abs(dy) * hw) {
    const t = hw / Math.abs(dx);
    return { x: cx + dx * t, y: cy + dy * t };
  } else {
    const t = hh / Math.abs(dy);
    return { x: cx + dx * t, y: cy + dy * t };
  }
}

function drawTopologyEdges(data, positions, typeById, layout) {
  topologyEdgesEl.innerHTML = "";
  ensureTopologyArrowMarkers();

  const SVG_NS = "http://www.w3.org/2000/svg";
  const masTypes = new Set(["orchestrator", "agent", "node"]);
  const sizeById = layout.sizeById;

  // Collect only internal domain edges first so we can index them for spread
  const domainEdges = data.edges.filter((edge) => {
    const fromType = typeById[edge.from];
    const toType   = typeById[edge.to];
    return masTypes.has(fromType) && masTypes.has(toType)
      && positions[edge.from] && positions[edge.to];
  });

  const count = domainEdges.length;
  domainEdges.forEach((edge, i) => {
    const from = positions[edge.from];
    const to   = positions[edge.to];
    const fromSz = sizeById[edge.from] || { w: 120, h: 96 };
    const toSz   = sizeById[edge.to]   || { w: 120, h: 96 };

    const p1 = rectEdgePoint(from.x, from.y, fromSz.w, fromSz.h, to.x, to.y);
    const p2 = rectEdgePoint(to.x,   to.y,   toSz.w,   toSz.h,   from.x, from.y);

    // Spread control points perpendicularly so no two curves share a path.
    // Index i is mapped from [-maxOff, +maxOff] across all edges.
    const maxOff = Math.min(60, count * 14);
    const t = count > 1 ? (i / (count - 1)) * 2 - 1 : 0; // -1 … +1
    const perpOff = t * maxOff;

    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;

    // Perpendicular direction to the line p1→p2
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx + (-dy / len) * perpOff;
    const cy = my + ( dx / len) * perpOff;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`);
    path.setAttribute("class", "link link-ai");
    path.setAttribute("fill", "none");
    path.setAttribute("marker-end", "url(#topo-flow-arrow)");
    topologyEdgesEl.appendChild(path);
  });

  drawTopologyPipelineSpine(data, positions, layout.sizeById, layout);
}

function drawTopologyPipelineSpine(data, positions, sizeById, layout) {
  if (!layout?.domainBox) return;

  const box = layout.domainBox;
  const midY = layout.centerY ?? box.top + box.height / 2;
  const boxLeft = box.left;
  const boxRight = box.left + box.width;
  const workflowLabel = layout.workflowName || "Workflow";

  const inputNode = data.nodes.find((n) => n.type === "input");
  const outputNode = data.nodes.find((n) => n.type === "output");

  const arrowPad = 14; // breathing room between node/box edge and arrow tip

  if (inputNode && positions[inputNode.id] && sizeById[inputNode.id]) {
    const pos = positions[inputNode.id];
    const sz = sizeById[inputNode.id];
    drawFlowArrow(pos.x + sz.w / 2 + arrowPad, pos.y, boxLeft - arrowPad, midY);
  }

  if (outputNode && positions[outputNode.id] && sizeById[outputNode.id]) {
    const pos = positions[outputNode.id];
    const sz = sizeById[outputNode.id];
    drawFlowArrow(boxRight + arrowPad, midY, pos.x - sz.w / 2 - arrowPad, pos.y);
  }

  // No redundant subtitle — the arrow nodes and directional arrows already show the flow.
}

function computeBounds(positions, sizeById, layout) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [id, pos] of Object.entries(positions)) {
    const { w, h } = sizeById[id];
    minX = Math.min(minX, pos.x - w / 2);
    maxX = Math.max(maxX, pos.x + w / 2);
    minY = Math.min(minY, pos.y - h / 2);
    maxY = Math.max(maxY, pos.y + h / 2);
  }
  if (layout?.domainBox) {
    const b = layout.domainBox;
    minX = Math.min(minX, b.left);
    maxX = Math.max(maxX, b.left + b.width);
    minY = Math.min(minY, b.top);
    maxY = Math.max(maxY, b.top + b.height);
  }
  return { minX, maxX, minY, maxY };
}

function fitTopologyStage(positions, sizeById, graphW, graphH, layout) {
  const bounds = computeBounds(positions, sizeById, layout);
  const contentW = bounds.maxX - bounds.minX;
  const contentH = bounds.maxY - bounds.minY;
  if (contentW <= 0 || contentH <= 0) return;

  for (const id of Object.keys(positions)) {
    positions[id].x -= bounds.minX;
    positions[id].y -= bounds.minY;
  }

  if (layout) {
    if (layout.domainBox) {
      layout.domainBox.left -= bounds.minX;
      layout.domainBox.top -= bounds.minY;
    }
    if (layout.inputLabelX) layout.inputLabelX -= bounds.minX;
    if (layout.outputLabelX) layout.outputLabelX -= bounds.minX;
    if (layout.centerY) layout.centerY -= bounds.minY;
  }

  topologyStage.style.width = contentW + "px";
  topologyStage.style.height = contentH + "px";

  const pad = 16;
  const scaleX = (graphW - pad * 2) / contentW;
  const scaleY = (graphH - pad * 2) / contentH;
  const scale = Math.min(scaleX, scaleY, 1);
  topologyStage.style.transform = `scale(${Math.max(0.92, scale)})`;
}

function finalizeTopologyLayout(data, layout, graphW, graphH) {
  applyTopologyPositions(layout.positions);
  fitTopologyStage(layout.positions, layout.sizeById, graphW, graphH, layout);
  applyTopologyPositions(layout.positions);
  renderTopologyChrome(layout);
  drawTopologyEdges(data, layout.positions, layout.typeById, layout);
}

function renderTopologyChrome(layout) {
  topologyStage
    .querySelectorAll(".layer-label, .layer-divider, .domain-box, .flow-stage-label")
    .forEach((el) => el.remove());

  if (layout.inputLabelX) {
    const inputLbl = document.createElement("div");
    inputLbl.className = "flow-stage-label";
    inputLbl.textContent = "User Input";
    inputLbl.style.left = `${layout.inputLabelX}px`;
    topologyStage.appendChild(inputLbl);
  }

  if (layout.domainBox) {
    const box = layout.domainBox;
    const el = document.createElement("div");
    el.className = "domain-box domain-mas";
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    const title = layout.workflowName || "Multi-Agent System";
    el.innerHTML = `<div class="domain-label">${escapeHtml(title)}</div>`;
    topologyStage.insertBefore(el, topologyNodesEl);
  }

  if (layout.outputLabelX) {
    const outLbl = document.createElement("div");
    outLbl.className = "flow-stage-label";
    outLbl.textContent = "Final Answer";
    outLbl.style.left = `${layout.outputLabelX}px`;
    topologyStage.appendChild(outLbl);
  }
}

function buildAttachmentMeta(att) {
  const parts = [];
  if (att.mcp?.length) parts.push(att.mcp.join(", "));
  if (att.llm?.length) parts.push(att.llm.join(", "));
  if (att.tools?.length) parts.push(att.tools.join(", "));
  return parts.join(" · ");
}

// Same icon language as docs/topology.html (Material-style inline SVG paths),
// mapped onto our node categories instead of infra roles.
const TOPO_ICONS = {
  input:
    '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>',
  orchestrator:
    '<path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/>',
  agent:
    '<path d="M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zm9 5h-9v-2h9v2zm-1.5-3.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>',
  output:
    '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>',
  node:
    '<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
};

const TYPE_LABELS = { input: "User Query", orchestrator: "Orchestrator", agent: "Agent", output: "Final Answer", node: "Node" };

function formatTopologyLabel(node, type) {
  if (type === "input") return "User Query";
  if (type === "output") return "Final Answer";
  return node.label || TYPE_LABELS[type] || type;
}

async function loadTopology(blueprintId) {
  if (!blueprintId) {
    topologyGraph.classList.add("hidden");
    topologyLegend.classList.add("hidden");
    topologyEmpty.classList.remove("hidden");
    return;
  }

  const res = await fetch(`/api/workflows/${blueprintId}/topology`);
  const data = await res.json();
  if (!res.ok) {
    topologyGraph.classList.add("hidden");
    topologyLegend.classList.add("hidden");
    topologyEmpty.textContent = data.error || "Could not load topology.";
    topologyEmpty.classList.remove("hidden");
    return;
  }
  renderTopology(data);
}

function renderTopology(data) {
  lastTopologyData = data;
  topologyEmpty.classList.add("hidden");
  topologyGraph.classList.remove("hidden");
  topologyLegend.classList.remove("hidden");
  topologyNodesEl.innerHTML = "";
  topologyEdgesEl.innerHTML = "";
  topologyStage.querySelectorAll(".layer-label, .layer-divider, .domain-box, .flow-stage-label").forEach((el) => el.remove());

  const width = topologyGraph.clientWidth || 600;
  const height = topologyGraph.clientHeight || 420;
  topologyGraph.style.height = "";
  topologyStage.style.transform = "";
  topologyStage.style.width = "";
  topologyStage.style.height = "";

  let layout = layoutTopologyNodes(data, width, height);
  layout.workflowName = data.name || "Workflow";
  buildTopologyNodeElements(data, layout.positions);

  const measured = measureTopologyNodes();
  if (Object.keys(measured).length > 0) {
    layout = layoutTopologyNodes(data, width, height, measured);
    layout.workflowName = data.name || "Workflow";
  }

  finalizeTopologyLayout(data, layout, width, height);
}

function buildTopologyNodeElements(data, positions) {
  topologyNodesEl.innerHTML = "";

  data.nodes.forEach((node) => {
    const pos = positions[node.id];
    if (!pos) return;
    const type = RANK_ORDER.includes(node.type) ? node.type : "node";
    const att = node.attachments || {};
    const label = formatTopologyLabel(node, type);
    const meta = buildAttachmentMeta(att);

    const el = document.createElement("div");
    el.dataset.nodeId = node.id;
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";

    if (type === "input") {
      el.className = "topo-node theme-users";
      el.innerHTML = `
        <div class="node-body">
          <svg viewBox="0 0 24 24">${TOPO_ICONS.input}</svg>
        </div>
        <div class="node-label">
          <div class="name">${escapeHtml(label)}</div>
          <div class="meta">User prompt</div>
        </div>
      `;
    } else if (type === "output") {
      el.className = "topo-node theme-grafana";
      el.innerHTML = `
        <div class="node-body">
          <div class="pulse-ring"></div>
          <svg viewBox="0 0 24 24">${TOPO_ICONS.output}</svg>
        </div>
        <div class="node-label">
          <div class="name">${escapeHtml(label)}</div>
          <div class="meta">Workflow output</div>
        </div>
      `;
    } else if (type === "orchestrator") {
      el.className = "topo-node topo-mini";
      el.innerHTML = `
        <div class="node-body mini-body mini-orch">
          <div class="pulse-ring"></div>
          <svg viewBox="0 0 24 24" fill="#22d3ee">${TOPO_ICONS.orchestrator}</svg>
        </div>
        <div class="node-label">
          <div class="name mini-name">${escapeHtml(label)}</div>
          ${meta ? `<div class="meta mini-meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      `;
    } else if (type === "agent") {
      el.className = "topo-node topo-mini";
      el.innerHTML = `
        <div class="node-body mini-body mini-agent">
          <div class="pulse-ring"></div>
          <svg viewBox="0 0 24 24" fill="#a78bfa">${TOPO_ICONS.agent}</svg>
        </div>
        <div class="node-label">
          <div class="name mini-name">${escapeHtml(label)}</div>
          ${meta ? `<div class="meta mini-meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      `;
    } else {
      el.className = "topo-node topo-mini";
      el.innerHTML = `
        <div class="node-body mini-body mini-mcp">
          <svg viewBox="0 0 24 24" fill="#fb923c">${TOPO_ICONS.node}</svg>
        </div>
        <div class="node-label">
          <div class="name mini-name">${escapeHtml(label)}</div>
          ${meta ? `<div class="meta mini-meta">${escapeHtml(meta)}</div>` : ""}
        </div>
      `;
    }

    topologyNodesEl.appendChild(el);
  });
}

workflowSelect.addEventListener("change", () => loadTopology(workflowSelect.value));

window.addEventListener("resize", () => {
  if (lastTopologyData && document.getElementById("tab-workflow").classList.contains("active")) {
    renderTopology(lastTopologyData);
  }
});

document.getElementById("btn-run-workflow").addEventListener("click", async () => {
  const blueprintId = workflowSelect.value;
  const prompt = document.getElementById("workflow-prompt").value.trim();

  if (!blueprintId) {
    alert("Select a workflow first.");
    return;
  }
  if (!prompt) {
    alert("Enter a prompt first.");
    return;
  }

  setStatusPill(workflowStatusPill, "running");
  workflowResult.innerHTML = '<div class="workflow-waiting">Starting workflow…</div>';
  document.getElementById("btn-run-workflow").disabled = true;
  workflowStreamSteps = [];
  workflowStreamSessionId = null;
  workflowExpandedTools.clear();
  workflowExpandedToolGroups.clear();
  workflowExpandedAgents.clear();
  if (workflowStreamAbort) workflowStreamAbort.abort();

  const res = await fetch("/api/workflows/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blueprint_id: blueprintId, prompt }),
  });
  const job = await res.json();

  if (!res.ok) {
    setStatusPill(workflowStatusPill, "failed");
    workflowResult.textContent = "Error: " + (job.error || "failed to start workflow");
    document.getElementById("btn-run-workflow").disabled = false;
    return;
  }

  pollWorkflowJob(job.id);
  if (job.session_id) {
    subscribeWorkflowStream(job.session_id);
  }
});

function unwrapStreamEvent(event) {
  if (Array.isArray(event) && event[0] === "custom" && event[1]) {
    return event[1];
  }
  return event;
}

function isWorkflowResultStep(step) {
  const id = (step.node_id || "").toLowerCase();
  const name = (step.node_name || "").toLowerCase();
  if (id === "user_question_node" || id === "final_answer_node") return false;
  if (id.includes("user_question") || id.includes("final_answer")) return false;
  if (name.includes("user question") || name.includes("final answer")) return false;
  if (step.node_type === "input" || step.node_type === "output") return false;
  return true;
}

function processWorkflowStreamEvent(event) {
  const data = unwrapStreamEvent(event);
  if (!data || typeof data !== "object") return;

  const eventType = data.type || "";
  if (eventType === "heartbeat" || eventType === "stream_end" || eventType === "stream_error") {
    return;
  }

  const node = data.node || data.node_uid || "unknown";
  const displayName = data.display_name || node;

  if (!isWorkflowResultStep({ node_id: node, node_name: displayName, node_type: data.node_type })) {
    return;
  }

  let step = workflowStreamSteps.find((s) => s.node_id === node);
  if (!step) {
    step = {
      node_id: node,
      node_name: displayName,
      text: "",
      status: "running",
      tools: [],
    };
    workflowStreamSteps.push(step);
  }

  if (eventType === "llm_token") {
    step.text += data.chunk || "";
  } else if (eventType === "tool_calling") {
    const callId = data.call_id;
    const tool = data.tool;
    if (callId && tool) {
      if (!step.tools.some((t) => t.id === callId)) {
        step.tools.push({ id: callId, name: tool, args: data.args });
      }
    }
  } else if (eventType === "tool_result") {
    const callId = data.call_id;
    if (callId) {
      const toolEntry = step.tools.find((t) => t.id === callId);
      if (toolEntry) {
        toolEntry.output = data.output;
      } else {
        step.tools.push({ id: callId, name: data.tool || "tool", output: data.output });
      }
    }
  } else if (eventType === "complete") {
    step.status = "complete";
  } else if (eventType.startsWith("agent_")) {
    step.text += `\n[agent ${eventType.replace("agent_", "")}]\n`;
  }
}

function subscribeWorkflowStream(sessionId) {
  if (workflowStreamAbort) workflowStreamAbort.abort();
  workflowStreamSessionId = sessionId;
  workflowStreamAbort = new AbortController();

  (async () => {
    try {
      const response = await fetch(
        `/api/workflows/stream?sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: { Accept: "application/x-ndjson" },
          signal: workflowStreamAbort.signal,
        },
      );

      if (!response.ok || !response.body) {
        console.warn("Workflow stream unavailable:", response.status);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "stream_end") return;
            if (event.type === "stream_error") {
              console.warn("Stream error:", event.error);
              return;
            }
            processWorkflowStreamEvent(event);
            workflowResult.innerHTML = renderWorkflowResult({ status: "running" });
          } catch (err) {
            console.warn("Bad stream line:", line, err);
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("Workflow stream failed:", err);
      }
    }
  })();
}

function shortAgentLabel(uid) {
  if (!uid) return "—";
  const match = String(uid).match(/^(.+)-Agent-/i);
  if (match) return match[1].replace(/-/g, " ");
  return uid.length > 28 ? uid.slice(0, 28) + "…" : uid;
}

function isOrchestratorStep(step) {
  const n = (step.node_name || step.node_id || "").toLowerCase();
  return n.includes("orchestrator");
}

function summarizeToolCall(name, args) {
  if (!args) return name;
  if (name === "iem.delegate_task") {
    const item = args.work_item_id ? ` · ${args.work_item_id}` : "";
    return `Delegate → ${shortAgentLabel(args.dst_uid)}${item}`;
  }
  if (name === "workplan.mark") {
    return `Mark ${args.item_id || "?"} as ${args.status || "?"}`;
  }
  if (name === "workplan.create_or_update") {
    const n = Array.isArray(args.items) ? args.items.length : 0;
    return `Update execution plan (${n} step${n === 1 ? "" : "s"})`;
  }
  return name;
}

function agentStepMetaLabel(step, tools) {
  if (isOrchestratorStep(step)) {
    const d = tools.filter((t) => t.name === "iem.delegate_task").length;
    return d ? `${d} delegation${d === 1 ? "" : "s"}` : null;
  }
  const groups = buildToolDisplayGroups(tools);
  if (groups.length === 1 && groups[0].type === "batch") {
    return `${groups[0].name} × ${groups[0].count}`;
  }
  if (!tools.length) return null;
  return `${tools.length} tool call${tools.length === 1 ? "" : "s"}`;
}

function toolGroupCollapsedLabel(tools, groups) {
  if (groups.length === 1 && groups[0].type === "batch") {
    return `${groups[0].name} × ${groups[0].count}`;
  }
  const batchParts = groups
    .filter((g) => g.type === "batch")
    .map((g) => `${g.name} × ${g.count}`);
  if (batchParts.length && batchParts.length === groups.length) {
    return batchParts.join(", ");
  }
  return `${tools.length} tool call${tools.length === 1 ? "" : "s"}`;
}

function buildToolDisplayGroups(tools) {
  const special = new Set(["workplan.create_or_update", "iem.delegate_task", "workplan.mark"]);
  const groups = [];
  let batch = null;

  tools.forEach((tool, index) => {
    if (special.has(tool.name)) {
      if (batch) {
        groups.push(batch);
        batch = null;
      }
      groups.push({ type: "single", tool, index });
      return;
    }
    if (batch && batch.name === tool.name) {
      batch.count += 1;
      batch.tools.push(tool);
      batch.indices.push(index);
    } else {
      if (batch) groups.push(batch);
      batch = { type: "batch", name: tool.name, count: 1, tools: [tool], indices: [index] };
    }
  });
  if (batch) groups.push(batch);
  return groups;
}

function renderOrchestratorActivity(step) {
  const tools = step.tools || [];
  let html = "";

  const planTool = tools.find((t) => t.name === "workplan.create_or_update" && t.args?.items);
  if (planTool) {
    html += '<div class="orch-section">';
    html += '<div class="orch-section-title">Execution plan</div>';
    if (planTool.args.summary) {
      html += `<p class="orch-summary">${escapeHtml(planTool.args.summary)}</p>`;
    }
    html += '<ol class="orch-numbered-list">';
    planTool.args.items.forEach((item) => {
      const assignee = item.assigned_uid
        ? shortAgentLabel(item.assigned_uid)
        : item.kind === "local"
          ? "Orchestrator"
          : "—";
      html += "<li>";
      html += `<span class="orch-item-title">${escapeHtml(item.title || item.id || "Step")}</span>`;
      html += `<span class="orch-item-meta">${escapeHtml(assignee)}</span>`;
      html += "</li>";
    });
    html += "</ol></div>";
  }

  const delegations = tools.filter((t) => t.name === "iem.delegate_task");
  if (delegations.length) {
    html += '<div class="orch-section">';
    html += '<div class="orch-section-title">Delegations</div>';
    html += '<ol class="orch-numbered-list">';
    delegations.forEach((t, i) => {
      const args = t.args || {};
      const preview = String(args.content || "")
        .split("\n")
        .find((line) => line.trim())
        ?.trim()
        .slice(0, 120);
      html += "<li>";
      html += `<span class="orch-del-target">→ ${escapeHtml(shortAgentLabel(args.dst_uid))}</span>`;
      if (args.work_item_id) {
        html += `<span class="orch-item-meta">${escapeHtml(args.work_item_id)}</span>`;
      }
      if (preview) {
        html += `<span class="orch-del-preview">${escapeHtml(preview)}</span>`;
      }
      html += "</li>";
    });
    html += "</ol></div>";
  }

  const marks = tools.filter((t) => t.name === "workplan.mark");
  if (marks.length) {
    html += '<div class="orch-section">';
    html += '<div class="orch-section-title">Progress updates</div>';
    html += '<ul class="orch-mark-list">';
    marks.forEach((t) => {
      const a = t.args || {};
      html += `<li><strong>${escapeHtml(a.item_id || "?")}</strong> → ${escapeHtml(a.status || "?")}</li>`;
    });
    html += "</ul></div>";
  }

  const other = tools.filter(
    (t) => !["workplan.create_or_update", "iem.delegate_task", "workplan.mark"].includes(t.name),
  );
  if (other.length) {
    html += renderGroupedToolCallsGroup(step, other);
  }

  return html;
}

function renderToolBatch(step, batch) {
  const batchKey = `${step.node_id}:batch:${batch.name}`;
  const expanded = workflowExpandedTools.has(batchKey);
  let html = '<div class="tool-call tool-call-batch">';
  html += `<button type="button" class="tool-call-toggle" data-tool-key="${escapeHtml(batchKey)}" aria-expanded="${expanded}">`;
  html += `<span class="tool-call-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>`;
  html += `<span class="tool-call-name">${escapeHtml(batch.name)}</span>`;
  html += `<span class="tool-call-state pending">× ${batch.count}</span>`;
  html += "</button>";
  if (expanded) {
    html += '<div class="tool-call-details">';
    batch.tools.forEach((tool, i) => {
      html += `<div class="tool-batch-line">${i + 1}. ${escapeHtml(tool.name)}</div>`;
    });
    html += "</div>";
  }
  html += "</div>";
  return html;
}

function renderGroupedToolCallsGroup(step, toolsSubset) {
  const tools = toolsSubset || step.tools || [];
  if (!tools.length) return "";

  const groupKey = `group:${step.node_id}`;
  const expanded = workflowExpandedToolGroups.has(groupKey);
  const groups = buildToolDisplayGroups(tools);

  let html = '<div class="tool-calls-group">';
  html += `<button type="button" class="tool-group-toggle" data-tool-group-key="${escapeHtml(groupKey)}" aria-expanded="${expanded}">`;
  html += `<span class="tool-group-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>`;
  html += `<span class="tool-group-label">${escapeHtml(toolGroupCollapsedLabel(tools, groups))}</span>`;
  html += "</button>";

  html += `<div class="tool-calls-list${expanded ? "" : " collapsed"}">`;
  groups.forEach((g) => {
    if (g.type === "batch") {
      html += renderToolBatch(step, g);
    } else {
      html += renderToolCall(step, g.tool, g.index, true);
    }
  });
  html += "</div></div>";
  return html;
}

function formatToolPayload(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderToolCall(step, tool, index, compactSummary) {
  const key = `${step.node_id}:${tool.id || index}`;
  const expanded = workflowExpandedTools.has(key);
  const hasDetails = tool.args || tool.output;
  const displayName = compactSummary
    ? summarizeToolCall(tool.name, tool.args)
    : tool.name;

  let html = '<div class="tool-call">';
  html += `<button type="button" class="tool-call-toggle" data-tool-key="${escapeHtml(key)}" aria-expanded="${expanded}">`;
  html += `<span class="tool-call-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>`;
  html += `<span class="tool-call-name">${escapeHtml(displayName)}</span>`;
  if (tool.output) {
    html += '<span class="tool-call-state done">done</span>';
  } else {
    html += '<span class="tool-call-state pending">call</span>';
  }
  html += "</button>";

  if (hasDetails) {
    html += `<div class="tool-call-details${expanded ? "" : " collapsed"}">`;
    if (tool.args) {
      html += '<div class="tool-call-block">';
      html += '<span class="tool-call-label">Args</span>';
      html += `<pre>${escapeHtml(formatToolPayload(tool.args))}</pre>`;
      html += "</div>";
    }
    if (tool.output) {
      html += '<div class="tool-call-block">';
      html += '<span class="tool-call-label">Output</span>';
      html += `<pre>${escapeHtml(formatToolPayload(tool.output))}</pre>`;
      html += "</div>";
    }
    html += "</div>";
  }
  html += "</div>";
  return html;
}

function renderToolCallsGroup(step) {
  return renderGroupedToolCallsGroup(step);
}

function resolveStepStatus(step) {
  const s = step.status || "idle";
  if (s === "complete") return { card: "complete", css: "status-complete", label: "Done" };
  if (s === "failed") return { card: "failed", css: "status-failed", label: "Failed" };
  if (s === "idle") return { card: "idle", css: "status-idle", label: "Idle" };
  return { card: "running", css: "status-running", label: "Running" };
}

function renderAgentStep(step) {
  const agentKey = step.node_id;
  const expanded = workflowExpandedAgents.has(agentKey);
  const tools = step.tools || [];
  const { card: statusCard, css: statusCss, label: statusLabel } = resolveStepStatus(step);
  const orchestrator = isOrchestratorStep(step);
  const metaLabel = agentStepMetaLabel(step, tools);

  let html = `<div class="stream-step ${statusCard}${orchestrator ? " stream-step-orchestrator" : ""}">`;
  html += `<button type="button" class="agent-step-toggle" data-agent-key="${escapeHtml(agentKey)}" aria-expanded="${expanded}">`;
  html += `<span class="agent-step-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>`;
  html += `<span class="stream-step-name">${escapeHtml(step.node_name || step.node_id || "Agent")}</span>`;
  html += `<span class="stream-step-status ${statusCss}">${escapeHtml(statusLabel)}</span>`;
  if (!expanded && metaLabel) {
    html += `<span class="agent-step-meta">${escapeHtml(metaLabel)}</span>`;
  }
  html += "</button>";

  html += `<div class="agent-step-body${expanded ? "" : " collapsed"}">`;
  if (step.text) {
    html += '<div class="agent-output-label">Output</div>';
    html += `<pre class="stream-step-text">${escapeHtml(step.text)}</pre>`;
  }
  if (tools.length) {
    if (orchestrator) {
      html += renderOrchestratorActivity(step);
    } else {
      html += renderGroupedToolCallsGroup(step);
    }
  }
  html += "</div></div>";
  return html;
}

function renderWorkflowResult(job) {
  const r = job.result || {};
  const steps = (workflowStreamSteps.length
    ? workflowStreamSteps
    : job.stream_steps || r.stream_steps || []).filter(isWorkflowResultStep);
  let html = "";

  const sessionId = r.session_id || job.session_id || workflowStreamSessionId;
  if (sessionId || job.status === "running") {
    const st = r.status || (job.status === "running" ? "RUNNING" : "?");
    html += `<div class="workflow-meta">Session: ${escapeHtml(sessionId || "…")} · Status: ${escapeHtml(st)}</div>`;
  }

  if (r.poll_handoff) {
    html +=
      '<div class="workflow-handoff">Workflow is still running on MAS — live updates continue below.</div>';
  }

  if (steps.length) {
    html += '<div class="workflow-stream">';
    steps.forEach((step) => {
      html += renderAgentStep(step);
    });
    html += "</div>";
  } else if (job.status === "running") {
    html += '<div class="workflow-waiting">Listening for agent activity… agents may run in parallel.</div>';
  }

  if (r.output && job.status === "success") {
    html += '<div class="workflow-final">';
    html += '<div class="workflow-final-label">Final Answer</div>';
    html += `<pre class="workflow-final-text">${escapeHtml(r.output)}</pre>`;
    html += "</div>";
  }

  return html || '<div class="workflow-waiting">Running…</div>';
}

function isWorkflowTerminal(job) {
  const st = String((job.result && job.result.status) || "").toUpperCase();
  return st === "COMPLETED" || st === "FAILED" || st === "CANCELLED";
}

function pollWorkflowJob(jobId) {
  if (workflowPollTimer) clearInterval(workflowPollTimer);

  workflowPollTimer = setInterval(async () => {
    const res = await fetch(`/api/workflows/jobs/${jobId}`);
    const job = await res.json();

    if (job.status === "success" && isWorkflowTerminal(job)) {
      clearInterval(workflowPollTimer);
      if (workflowStreamAbort) workflowStreamAbort.abort();
      setStatusPill(workflowStatusPill, "success");
      document.getElementById("btn-run-workflow").disabled = false;
      workflowResult.innerHTML = renderWorkflowResult(job);
    } else if (job.status === "success" && !isWorkflowTerminal(job)) {
      setStatusPill(workflowStatusPill, "running");
      workflowResult.innerHTML = renderWorkflowResult({ ...job, status: "running" });
    } else if (job.status === "failed") {
      clearInterval(workflowPollTimer);
      if (workflowStreamAbort) workflowStreamAbort.abort();
      setStatusPill(workflowStatusPill, "failed");
      document.getElementById("btn-run-workflow").disabled = false;
      workflowResult.textContent = "Error: " + (job.error || "workflow failed");
    } else {
      if (job.session_id && job.session_id !== workflowStreamSessionId) {
        subscribeWorkflowStream(job.session_id);
      }
      workflowResult.innerHTML = renderWorkflowResult(job);
    }
  }, 800);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
