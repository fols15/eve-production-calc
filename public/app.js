const searchInput = document.getElementById("search");
const browseListEl = document.getElementById("browseList");
const emptyState = document.getElementById("emptyState");
const itemView = document.getElementById("itemView");
const itemIcon = document.getElementById("itemIcon");
const itemName = document.getElementById("itemName");
const itemBadge = document.getElementById("itemBadge");
const itemBatchInfo = document.getElementById("itemBatchInfo");
const sellOrdersBody = document.getElementById("sellOrdersBody");
const buyOrdersBody = document.getElementById("buyOrdersBody");
const chartPanel = document.getElementById("chartPanel");
const chartStatus = document.getElementById("chartStatus");
const quantityInput = document.getElementById("quantity");
const facilityTaxInput = document.getElementById("facilityTax");
const disableReactionsInput = document.getElementById("disableReactions");
const systemSearchInput = document.getElementById("systemSearch");
const systemResultsEl = document.getElementById("systemResults");
const sellSystemSearchInput = document.getElementById("sellSystemSearch");
const sellSystemResultsEl = document.getElementById("sellSystemResults");
const calcBtn = document.getElementById("calcBtn");
const treePanel = document.getElementById("treePanel");
const treeBody = document.getElementById("tree");
const resultsPanel = document.getElementById("resultsPanel");
const blueprintsPanel = document.getElementById("blueprintsPanel");
const blueprintsBody = document.getElementById("blueprintsBody");
const structurePicker = document.getElementById("structurePicker");
const structureBonusLine = document.getElementById("structureBonusLine");

let selected = null; // { typeID, name, buildable }
let currentTree = null;
let decisions = {}; // typeID -> 'build' | 'buy' (sent to the server as overrides) — manual build/buy override, independent of blueprint sourcing (which the server now resolves automatically, see server/blueprintSourcing.js)
let selectedSystem = { solarSystemID: 30000142, name: "Jita" }; // production system — job cost
let sellSystem = { solarSystemID: 30000142, name: "Jita" }; // where the finished product is sold — revenue only
let lastTreeData = null; // full last /api/tree response: totals + shoppingList, server-computed
let selectedStructureId = ""; // "" = manual system+tax above; otherwise a known structure's id (own or someone else's)
let knownStructures = []; // cached /api/structures — reused by the picker and the best-systems "Выбрать" button

// ============ persist the current screen across page reloads ============
// localStorage, not a server session — this is what you're CALCULATING
// (item + params + build/buy and ME overrides), not the calculated numbers
// themselves, so a restore always re-fetches a fresh /api/tree instead of
// replaying stale prices from before the reload.
const UI_STATE_KEY = "eve-calc-ui-state-v1";

function saveUiState() {
  if (!selected) return;
  try {
    localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        selected,
        quantity: quantityInput.value,
        facilityTax: facilityTaxInput.value,
        disableReactions: disableReactionsInput.checked,
        selectedSystem,
        sellSystem,
        salesTaxPct: salesTaxInput.value,
        brokerFeePct: brokerFeeInput.value,
        industryLevel: industryLevelInput.value,
        advancedIndustryLevel: advancedIndustryLevelInput.value,
        selectedStructureId,
        decisions,
      })
    );
  } catch {
    // localStorage can throw (private browsing, quota) — losing persistence isn't fatal
  }
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

// Job duration, EVE-style: "2д 5ч 12м" (drops leading zero units, always
// shows at least minutes so a short job doesn't render as "").
function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return "—";
  let s = Math.round(totalSeconds);
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const minutes = Math.floor(s / 60);
  const parts = [];
  if (days) parts.push(`${days}д`);
  if (hours || days) parts.push(`${hours}ч`);
  parts.push(`${minutes}м`);
  return parts.join(" ");
}

function iconUrl(typeID, size = 32) {
  return `https://images.evetech.net/types/${typeID}/icon?size=${size}`;
}

function iconImg(typeID, size, cls) {
  return `<img class="${cls}" src="${iconUrl(typeID, size)}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
}

// ============ sidebar: search + in-game-style category tree ============

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) {
    loadBrowseRoot();
    return;
  }
  searchTimer = setTimeout(async () => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const items = await res.json();
    renderSearchList(items);
  }, 200);
});

function renderSearchList(items) {
  browseListEl.innerHTML = "";
  if (!items.length) {
    browseListEl.innerHTML = `<div class="browse-empty">Ничего не найдено</div>`;
    return;
  }
  for (const item of items) browseListEl.appendChild(renderBrowseItem(item));
}

async function loadBrowseRoot() {
  browseListEl.innerHTML = `<div class="browse-loading">Загрузка категорий...</div>`;
  const { groups } = await fetchBrowse(null);
  browseListEl.innerHTML = "";
  for (const g of groups) browseListEl.appendChild(renderBrowseGroup(g));
}

async function fetchBrowse(groupId) {
  const url = groupId === null ? "/api/browse" : `/api/browse?groupId=${groupId}`;
  const res = await fetch(url);
  return res.json();
}

function renderBrowseGroup(group) {
  const wrap = document.createElement("div");
  wrap.className = "browse-node";

  const row = document.createElement("div");
  row.className = "browse-row group";
  // No folder glyph — a real EVE icon (images.evetech.net, same CDN as every
  // item row) borrowed from a representative item inside this category
  // (server/sde.js/representativeTypeID), since CCP doesn't serve market
  // group icons themselves anywhere publicly.
  // A few representative types are old/edge-case content with no real icon
  // asset on CCP's image server (e.g. some ancient blueprints) — fall back
  // to the folder glyph instead of a blank gap when that happens.
  const iconHtml = group.iconTypeID
    ? `<img class="icon" src="${iconUrl(group.iconTypeID, 32)}" alt="" loading="lazy" onerror="this.outerHTML='&lt;span class=&quot;icon folder-icon&quot;&gt;📁&lt;/span&gt;'" />`
    : `<span class="icon folder-icon">📁</span>`;
  row.innerHTML = `<span class="toggle">▸</span>${iconHtml}<span class="label">${group.name}</span>`;
  wrap.appendChild(row);

  let childrenEl = null;
  let loaded = false;
  let expanded = false;

  row.addEventListener("click", async () => {
    expanded = !expanded;
    row.querySelector(".toggle").textContent = expanded ? "▾" : "▸";
    if (!expanded) {
      if (childrenEl) childrenEl.classList.add("hidden");
      return;
    }
    if (!loaded) {
      loaded = true;
      childrenEl = document.createElement("div");
      childrenEl.className = "browse-children";
      childrenEl.innerHTML = `<div class="browse-loading">Загрузка...</div>`;
      wrap.appendChild(childrenEl);
      const { groups, items } = await fetchBrowse(group.groupID);
      childrenEl.innerHTML = "";
      for (const g of groups) childrenEl.appendChild(renderBrowseGroup(g));
      for (const it of items) childrenEl.appendChild(renderBrowseItem(it));
    } else {
      childrenEl.classList.remove("hidden");
    }
  });

  return wrap;
}

function renderBrowseItem(item) {
  const row = document.createElement("div");
  row.className = "browse-row item";
  row.dataset.typeId = item.typeID;
  row.innerHTML = `<span class="toggle"></span>${iconImg(item.typeID, 32, "icon")}<span class="label">${item.name}</span>${item.buildable ? '<span class="buildable-tag">чертёж</span>' : ""}`;
  row.addEventListener("click", () => {
    // A quantity left over from a previous item (e.g. a big batch typed for
    // cheap ammo, or auto-filled by the profit scanner's "Открыть" for a
    // different item) silently carries over otherwise — for a low-liquidity
    // item that reads as a wildly wrong "huge loss" on Quick Sell (the walked
    // buy-order book is thin, so an unrealistically large quantity craters
    // the average price), when it's actually just a stale quantity, not a
    // real result. A fresh pick from search/browse always starts at 1.
    quantityInput.value = "1";
    selectItem(item);
  });
  return row;
}

function markSelectedRow(typeID) {
  document.querySelectorAll(".browse-row.item.selected").forEach((el) => el.classList.remove("selected"));
  const row = document.querySelector(`.browse-row.item[data-type-id="${typeID}"]`);
  if (row) row.classList.add("selected");
}

loadBrowseRoot();

// ============ item selection & market snapshot ============

async function selectItem(item) {
  selected = item;
  markSelectedRow(item.typeID);

  emptyState.classList.add("hidden");
  itemView.classList.remove("hidden");

  itemIcon.src = iconUrl(item.typeID, 64);
  itemName.textContent = item.name;
  itemBadge.textContent = item.buildable ? "Есть чертёж — можно строить" : "Нет чертежа — только рынок";
  itemBadge.className = `item-badge ${item.buildable ? "buildable" : ""}`;
  itemBatchInfo.classList.add("hidden");
  itemBatchInfo.textContent = "";

  if (item.buildable) {
    // Batch size varies wildly by item (100/run for common T1 ammo, 1/run
    // for some capital/structure items) — shown immediately on selection so
    // typing "1" into "Количество единиц" (meaning 1 unit, not 1 run) never
    // reads as the calculator being broken when the real batch is bigger.
    fetch(`/api/recipe-info?typeId=${item.typeID}`)
      .then((r) => r.json())
      .then((info) => {
        if (selected?.typeID !== item.typeID || !info.buildable) return; // stale response from a since-abandoned selection
        itemBatchInfo.textContent = `1 ран чертежа «${info.blueprintName}» = ${fmt(info.outputQuantity)} шт.`;
        itemBatchInfo.classList.remove("hidden");
      })
      .catch(() => {});
  }

  treePanel.hidden = true;
  resultsPanel.hidden = true;
  blueprintsPanel.classList.add("hidden");
  currentTree = null;

  sellOrdersBody.innerHTML = `<tr class="empty-row"><td colspan="2">Загрузка...</td></tr>`;
  buyOrdersBody.innerHTML = `<tr class="empty-row"><td colspan="2">Загрузка...</td></tr>`;
  const res = await fetch(`/api/orderbook?typeId=${item.typeID}`);
  const book = await res.json();
  renderOrderTable(sellOrdersBody, book.sell);
  renderOrderTable(buyOrdersBody, book.buy);

  loadMarketChart(item.typeID);
  saveUiState();
}

// ============ price/volume chart (exchange-style: price line above, volume bars below) ============

let priceChartInstance = null;
let volumeChartInstance = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function loadMarketChart(typeID) {
  chartPanel.hidden = false;
  chartStatus.textContent = "Загрузка истории торгов...";
  try {
    const res = await fetch(`/api/market-history?typeId=${typeID}`);
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error ?? `HTTP ${res.status}`);
    if (selected?.typeID !== typeID) return; // stale response from a since-abandoned selection

    if (!rows.length) {
      chartStatus.textContent = "Нет истории торгов по этому предмету в The Forge.";
      priceChartInstance?.destroy();
      volumeChartInstance?.destroy();
      priceChartInstance = null;
      volumeChartInstance = null;
      return;
    }

    // ESI history is region-wide (The Forge), not Jita-4-4-scoped like the
    // live order book above — the only granularity CCP's history endpoint offers.
    const recent = rows.slice(-90);
    const labels = recent.map((r) => r.date);
    const cyan = cssVar("--cyan");
    const gold = cssVar("--gold");
    const muted = cssVar("--muted");
    const border = cssVar("--border");

    const priceData = {
      labels,
      datasets: [
        {
          label: "Highest",
          data: recent.map((r) => r.highest),
          borderColor: "transparent",
          backgroundColor: `${cyan}22`,
          pointRadius: 0,
          fill: "+1",
          order: 2,
        },
        {
          label: "Lowest",
          data: recent.map((r) => r.lowest),
          borderColor: "transparent",
          backgroundColor: "transparent",
          pointRadius: 0,
          fill: false,
          order: 3,
        },
        {
          label: "Average",
          data: recent.map((r) => r.average),
          borderColor: gold,
          backgroundColor: gold,
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
          order: 1,
        },
      ],
    };
    const commonScales = {
      x: { ticks: { color: muted, maxTicksLimit: 10 }, grid: { color: border } },
    };

    priceChartInstance?.destroy();
    priceChartInstance = new Chart(document.getElementById("priceChart"), {
      type: "line",
      data: priceData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: muted } } },
        scales: { ...commonScales, y: { ticks: { color: muted }, grid: { color: border } } },
      },
    });

    volumeChartInstance?.destroy();
    volumeChartInstance = new Chart(document.getElementById("volumeChart"), {
      type: "bar",
      data: {
        labels,
        datasets: [{ label: "Объём", data: recent.map((r) => r.volume), backgroundColor: `${cyan}88` }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: { ...commonScales, y: { ticks: { color: muted }, grid: { color: border } } },
      },
    });

    chartStatus.textContent = `Показано ${recent.length} дн. (из ${rows.length} доступных).`;
  } catch (err) {
    chartStatus.textContent = `Ошибка загрузки графика: ${err.message}`;
  }
}

function renderOrderTable(tbody, orders) {
  tbody.innerHTML = "";
  if (!orders.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="2">Нет ордеров в Jita 4-4</td></tr>`;
    return;
  }
  for (const o of orders) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmt(o.quantity)}</td><td>${fmt(o.price)}</td>`;
    tbody.appendChild(tr);
  }
}

// ============ system picker (for job cost / system cost index) ============

systemSearchInput.value = selectedSystem.name;

let systemSearchTimer = null;
systemSearchInput.addEventListener("input", () => {
  clearTimeout(systemSearchTimer);
  const q = systemSearchInput.value.trim();
  if (!q) {
    systemResultsEl.classList.add("hidden");
    return;
  }
  systemSearchTimer = setTimeout(async () => {
    const res = await fetch(`/api/systems/search?q=${encodeURIComponent(q)}`);
    const systems = await res.json();
    renderSystemResults(systems);
  }, 200);
});

function renderSystemResults(systems) {
  if (!systems.length) {
    systemResultsEl.classList.add("hidden");
    return;
  }
  systemResultsEl.innerHTML = "";
  for (const sys of systems) {
    const div = document.createElement("div");
    div.className = "search-result-row";
    div.innerHTML = `<span>${sys.name}</span><span class="sec">${sys.security.toFixed(1)}</span>`;
    div.addEventListener("click", () => {
      selectedSystem = { solarSystemID: sys.solarSystemID, name: sys.name };
      systemSearchInput.value = sys.name;
      systemResultsEl.classList.add("hidden");
    });
    systemResultsEl.appendChild(div);
  }
  systemResultsEl.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".system-picker-label")) systemResultsEl.classList.add("hidden");
});

// ============ sell-location picker (revenue only — materials stay Jita) ============

sellSystemSearchInput.value = sellSystem.name;

let sellSystemSearchTimer = null;
sellSystemSearchInput.addEventListener("input", () => {
  clearTimeout(sellSystemSearchTimer);
  const q = sellSystemSearchInput.value.trim();
  if (!q) {
    sellSystemResultsEl.classList.add("hidden");
    return;
  }
  sellSystemSearchTimer = setTimeout(async () => {
    const res = await fetch(`/api/systems/search?q=${encodeURIComponent(q)}`);
    const systems = await res.json();
    renderSellSystemResults(systems);
  }, 200);
});

function renderSellSystemResults(systems) {
  if (!systems.length) {
    sellSystemResultsEl.classList.add("hidden");
    return;
  }
  sellSystemResultsEl.innerHTML = "";
  for (const sys of systems) {
    const div = document.createElement("div");
    div.className = "search-result-row";
    div.innerHTML = `<span>${sys.name}</span><span class="sec">${sys.security.toFixed(1)}</span>`;
    div.addEventListener("click", () => {
      sellSystem = { solarSystemID: sys.solarSystemID, name: sys.name };
      sellSystemSearchInput.value = sys.name;
      sellSystemResultsEl.classList.add("hidden");
    });
    sellSystemResultsEl.appendChild(div);
  }
  sellSystemResultsEl.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".system-picker-label")) sellSystemResultsEl.classList.add("hidden");
});

// ============ production calculation ============

// Fetches a freshly server-computed tree for the current item/params, with
// `decisions` sent as build/buy overrides (empty = all server defaults).
// The server is the single source of truth for costs (see bom.js) — the
// client never recomputes them, which is what used to silently produce
// wrong, self-contradictory totals for trees that reuse the same material
// at very different quantities in different branches.
async function fetchTree() {
  const quantity = Math.max(1, Number(quantityInput.value) || 1);
  const industryLevel = Math.min(5, Math.max(0, Number(industryLevelInput.value) || 0));
  const advancedIndustryLevel = Math.min(5, Math.max(0, Number(advancedIndustryLevelInput.value) || 0));
  const sellSystemId = sellSystem.solarSystemID;
  const salesTaxPct = Math.max(0, Number(salesTaxInput.value) || 0);
  const brokerFeePct = Math.max(0, Number(brokerFeeInput.value) || 0);
  const params = new URLSearchParams({
    typeId: selected.typeID,
    quantity,
    industryLevel,
    advancedIndustryLevel,
    sellSystemId,
    salesTaxPct,
    brokerFeePct,
  });
  // A known structure (own or someone else's — see resolveProductionSite in
  // index.js) makes the SERVER resolve systemId/facilityTax/ME bonus from
  // its stored record; otherwise fall back to the manual system + tax
  // fields, same as before structures existed.
  if (selectedStructureId) {
    params.set("structureId", selectedStructureId);
  } else {
    params.set("systemId", selectedSystem.solarSystemID);
    params.set("facilityTax", Math.max(0, Number(facilityTaxInput.value) || 0));
  }
  if (disableReactionsInput.checked) params.set("disableReactions", "1");
  if (Object.keys(decisions).length) params.set("overrides", JSON.stringify(decisions));

  const res = await fetch(`/api/tree?${params.toString()}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// Single fetch-and-render path shared by every place that recomputes the
// tree (initial calculate, optimize, build/buy toggle) — the server now
// resolves every blueprint's real source/ME/cost itself (see
// server/blueprintSourcing.js), so this is just fetch + render, no client
// side reconciliation pass needed anymore.
async function recomputeAndRender() {
  const data = await fetchTree();
  lastTreeData = data;
  currentTree = data.tree;
  renderTree();
  renderResults();
  renderBlueprintsPanel(data);
  return data;
}

// resetOverrides=false is only for restoring a saved screen on page load,
// where `decisions` was just set from localStorage and clearing it here
// would defeat the whole point of restoring.
async function calculate(resetOverrides = true) {
  if (!selected) return;
  if (resetOverrides) {
    decisions = {}; // fresh calculation always starts from server defaults
  }

  calcBtn.disabled = true;
  calcBtn.textContent = "Загрузка цен...";
  try {
    await recomputeAndRender();
    treePanel.hidden = false;
    resultsPanel.hidden = false;
  } catch (err) {
    alert(`Ошибка: ${err.message}`);
  } finally {
    calcBtn.disabled = false;
    calcBtn.textContent = "Рассчитать производство";
  }
}

calcBtn.addEventListener("click", () => calculate());

document.getElementById("optimizeBtn").addEventListener("click", async () => {
  if (!currentTree) return;
  decisions = {}; // clears any manual overrides, restoring the server's optimum
  const btn = document.getElementById("optimizeBtn");
  btn.disabled = true;
  try {
    await recomputeAndRender();
  } catch (err) {
    alert(`Ошибка: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ============ find the best production system within 10 jumps of Jita ============

const findSystemBtn = document.getElementById("findSystemBtn");
const bestSystemsPanel = document.getElementById("bestSystemsPanel");
const bestSystemsBody = document.getElementById("bestSystemsBody");
const avoidSystemSearchInput = document.getElementById("avoidSystemSearch");
const avoidSystemResultsEl = document.getElementById("avoidSystemResults");
const avoidSystemTagsEl = document.getElementById("avoidSystemTags");

// Systems to route around entirely — both the jump-distance search and the
// "best systems" candidate scan treat these as impassable (unsafe space, a
// blocked gate, wherever), rather than merely deprioritizing them.
let avoidSystems = []; // [{ solarSystemID, name }]

function renderAvoidTags() {
  avoidSystemTagsEl.innerHTML = "";
  for (const sys of avoidSystems) {
    const tag = document.createElement("span");
    tag.className = "avoid-tag";
    tag.innerHTML = `${sys.name} <button type="button" aria-label="Убрать">×</button>`;
    tag.querySelector("button").addEventListener("click", () => {
      avoidSystems = avoidSystems.filter((s) => s.solarSystemID !== sys.solarSystemID);
      renderAvoidTags();
    });
    avoidSystemTagsEl.appendChild(tag);
  }
}

let avoidSearchTimer = null;
avoidSystemSearchInput.addEventListener("input", () => {
  clearTimeout(avoidSearchTimer);
  const q = avoidSystemSearchInput.value.trim();
  if (!q) {
    avoidSystemResultsEl.classList.add("hidden");
    return;
  }
  avoidSearchTimer = setTimeout(async () => {
    const res = await fetch(`/api/systems/search?q=${encodeURIComponent(q)}`);
    const systems = await res.json();
    renderAvoidSystemResults(systems);
  }, 200);
});

function renderAvoidSystemResults(systems) {
  const avoided = new Set(avoidSystems.map((s) => s.solarSystemID));
  const options = systems.filter((sys) => !avoided.has(sys.solarSystemID));
  if (!options.length) {
    avoidSystemResultsEl.classList.add("hidden");
    return;
  }
  avoidSystemResultsEl.innerHTML = "";
  for (const sys of options) {
    const div = document.createElement("div");
    div.className = "search-result-row";
    div.innerHTML = `<span>${sys.name}</span><span class="sec">${sys.security.toFixed(1)}</span>`;
    div.addEventListener("click", () => {
      avoidSystems.push({ solarSystemID: sys.solarSystemID, name: sys.name });
      renderAvoidTags();
      avoidSystemSearchInput.value = "";
      avoidSystemResultsEl.classList.add("hidden");
    });
    avoidSystemResultsEl.appendChild(div);
  }
  avoidSystemResultsEl.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".avoid-picker-label")) avoidSystemResultsEl.classList.add("hidden");
});

findSystemBtn.addEventListener("click", async () => {
  if (!selected) return;
  const quantity = Math.max(1, Number(quantityInput.value) || 1);
  const facilityTax = Math.max(0, Number(facilityTaxInput.value) || 0);

  findSystemBtn.disabled = true;
  findSystemBtn.textContent = "Ищу...";
  try {
    const params = new URLSearchParams({ typeId: selected.typeID, quantity, facilityTax, maxJumps: 10, limit: 10 });
    if (avoidSystems.length) params.set("avoid", avoidSystems.map((s) => s.solarSystemID).join(","));
    const res = await fetch(`/api/best-systems?${params.toString()}`);
    if (!res.ok) {
      const err = await res.json();
      alert(`Ошибка: ${err.error}`);
      return;
    }
    const data = await res.json();
    renderBestSystems(data.results);
    bestSystemsPanel.classList.remove("hidden");
  } finally {
    findSystemBtn.disabled = false;
    findSystemBtn.textContent = "🔍 Найти лучшую систему";
  }
});

function renderBestSystems(results) {
  bestSystemsBody.innerHTML = "";
  if (!results.length) {
    bestSystemsBody.innerHTML = `<tr><td colspan="9">Не нашлось систем с Manufacturing-станциями в пределах 10 прыжков (проверьте список игнорируемых систем — маршрут мог упереться в тупик).</td></tr>`;
    return;
  }
  for (const r of results) {
    const tr = document.createElement("tr");
    if (r.systemId === selectedSystem.solarSystemID) tr.className = "current-system";
    const nameCell = r.structure
      ? `🏗️ ${r.name} <span class="stations-cell" style="display:inline">— ${r.structure.name} (${r.structure.typeName ?? "структура"}, налог ${r.structure.facilityTax}%)</span>`
      : r.name;
    tr.innerHTML = `
      <td>${nameCell}</td>
      <td>${r.security.toFixed(1)}</td>
      <td>${r.jumps ?? "—"}</td>
      <td>${(r.costIndex * 100).toFixed(2)}%</td>
      <td>${fmt(r.jobCost)} ISK</td>
      <td class="cost-cell">${fmt(r.totalCost)} ISK</td>
      <td class="stations-cell">${r.stations.join(", ") || "—"}</td>
      <td><button class="pick-btn route-btn" data-system-id="${r.systemId}">Путь</button></td>
      <td><button class="pick-btn" data-system-id="${r.systemId}" data-system-name="${r.name}">Выбрать</button></td>
    `;
    bestSystemsBody.appendChild(tr);

    const routeRow = document.createElement("tr");
    routeRow.className = "route-row hidden";
    routeRow.innerHTML = `<td colspan="9" class="route-cell"></td>`;
    bestSystemsBody.appendChild(routeRow);

    tr.querySelector(".route-btn").addEventListener("click", async (e) => {
      if (!routeRow.classList.contains("hidden")) {
        routeRow.classList.add("hidden");
        return;
      }
      const cell = routeRow.querySelector(".route-cell");
      routeRow.classList.remove("hidden");
      if (!cell.dataset.loaded) {
        cell.textContent = "Строю маршрут…";
        try {
          const params = new URLSearchParams({ to: r.systemId });
          if (avoidSystems.length) params.set("avoid", avoidSystems.map((s) => s.solarSystemID).join(","));
          const res = await fetch(`/api/route?${params.toString()}`);
          const data = await res.json();
          if (!res.ok) {
            cell.textContent = `Не удалось построить маршрут: ${data.error}`;
          } else {
            cell.textContent = `${data.jumps} прыжков: ` + data.path.map((s) => `${s.name} (${s.security.toFixed(1)})`).join(" → ");
            cell.dataset.loaded = "1";
          }
        } catch (err) {
          cell.textContent = `Ошибка: ${err.message}`;
        }
      }
    });

    tr.querySelector(".pick-btn:not(.route-btn)").addEventListener("click", () => {
      selectedSystem = { solarSystemID: r.systemId, name: r.name };
      systemSearchInput.value = r.name;
      // A structure row carries its OWN facilityTax + hull ME bonus —
      // picking it should behave exactly like picking it from the
      // "Структура" dropdown, not just borrow its systemId.
      selectedStructureId = r.structure ? r.structure.id : "";
      structurePicker.value = selectedStructureId;
      systemSearchInput.disabled = Boolean(r.structure);
      facilityTaxInput.disabled = Boolean(r.structure);
      if (r.structure) facilityTaxInput.value = r.structure.facilityTax;
      calculate();
    });
  }
}

// Every number here (unitCost, jobCost, decision) comes straight from the
// server's aggregate BOM rollup (bom.js) — the client never recomputes cost
// itself. A material can appear dozens of times in a tree at very different
// quantities (e.g. Vagabond needs "Fernite Carbide" 7 times, from 284 to
// 200,495 units), and reactions/manufacturing run in discrete batches, so
// pricing each occurrence in isolation client-side gave wrong, compounding
// totals — the server sums total demand per typeID across the WHOLE tree
// first, then prices ONE combined batch, and hands back a per-node rate
// that's already correct to just multiply by that node's local quantity.

function renderTree() {
  treeBody.innerHTML = "";
  renderNodeRow(currentTree, 0);
}

function nodeCost(node) {
  return node.quantity * (node.unitCost ?? 0);
}

function renderNodeRow(node, depth) {
  const isLeaf = !node.buildable || node.decision !== "build";

  const tr = document.createElement("tr");
  tr.className = "tree-row";

  let toggleHtml = "";
  if (node.buildable) {
    const checked = node.decision === "build" ? "checked" : "";
    toggleHtml = `<label><input type="checkbox" data-toggle="${node.typeID}" ${checked}/> строить</label>`;
  } else {
    toggleHtml = `<span class="leaf-tag">рынок</span>`;
  }

  const priceLabel = isLeaf
    ? `${fmt(node.unitCost)} ISK`
    : `${fmt(node.runs)} ран × ${fmt(node.outputQuantity)} = ${fmt(node.runs * node.outputQuantity)} шт.`;
  const jobCostLabel = !isLeaf && node.buildable ? `${fmt(node.jobCost)} ISK` : "—";
  // The REAL blueprint's own ME/TE (own > contract copy > contract original
  // > Forge market — see server/blueprintSourcing.js), not an editable
  // assumption anymore: the server already picked the only honest value.
  const meCell = node.buildable ? String(node.me ?? 0) : "—";
  const teCell = node.buildable ? String(node.te ?? 0) : "—";
  const timeLabel = node.buildable ? formatDuration(node.timeSec) : "—";

  tr.innerHTML = `
    <td class="name-cell" style="padding-left:${8 + depth * 18}px">
      ${iconImg(node.typeID, 32, "icon")}<span class="name">${node.name}</span>
    </td>
    <td>${fmt(node.quantity)}</td>
    <td>${meCell}</td>
    <td>${teCell}</td>
    <td>${timeLabel}</td>
    <td>${priceLabel}</td>
    <td>${jobCostLabel}</td>
    <td class="cost-cell">${fmt(nodeCost(node))} ISK</td>
    <td class="toggle-cell">${toggleHtml}</td>
  `;
  treeBody.appendChild(tr);

  const checkbox = tr.querySelector("input[type=checkbox]");
  if (checkbox) {
    checkbox.addEventListener("change", async (e) => {
      decisions[node.typeID] = e.target.checked ? "build" : "buy";
      checkbox.disabled = true;
      try {
        await recomputeAndRender();
      } catch (err) {
        alert(`Ошибка: ${err.message}`);
      }
    });
  }

  if (!isLeaf && node.materials) {
    for (const m of node.materials) renderNodeRow(m, depth + 1);
  }
}

function renderResults() {
  // Everything here — including revenueSell/revenueQuickSell — comes straight
  // from the server response (see /api/tree in index.js): Quick Sell walks
  // the real buy-order book for `quantity` units the same way Quick Buy
  // walks the sell side for materials, instead of assuming the whole batch
  // trades at the single best bid.
  const { totalCost, totalJobCost, totalMaterialsCost, totalBlueprintCost, allBuildCost, revenueSell, revenueQuickSell, sellUnitPrice, quickSellUnitPrice, sellSystemName, productionSite } = lastTreeData;

  document.getElementById("totalCost").textContent = `${fmt(totalCost)} ISK`;
  const blueprintCostPart = totalBlueprintCost > 0 ? ` + чертежи ${fmt(totalBlueprintCost)}` : "";
  document.getElementById("costBreakdown").textContent = `материалы ${fmt(totalMaterialsCost)} + job cost ${fmt(totalJobCost)}${blueprintCostPart} ISK (${selectedSystem.name})`;

  const structure = selectedStructureId ? knownStructures.find((s) => s.id === selectedStructureId) : null;
  const durationBits = [];
  if (productionSite?.structureManufacturingDurationPct > 0) durationBits.push(`производство −${productionSite.structureManufacturingDurationPct.toFixed(0)}%`);
  if (productionSite?.structureReactionDurationPct > 0) durationBits.push(`реакции −${productionSite.structureReactionDurationPct.toFixed(0)}%`);
  const durationText = durationBits.length ? `, время структуры: ${durationBits.join(", ")}` : "";
  const skillText =
    productionSite && (productionSite.industryLevel > 0 || productionSite.advancedIndustryLevel > 0)
      ? ` Навыки: Industry ${productionSite.industryLevel}, Advanced Industry ${productionSite.advancedIndustryLevel} — снижают время производства (не реакций).`
      : "";
  structureBonusLine.textContent =
    productionSite && (productionSite.structureMePct > 0 || productionSite.jobFeeBonusPct > 0)
      ? `Структура${structure ? ` «${structure.name}»` : ""}: налог ${productionSite.facilityTax}%, ME-бонус +${productionSite.structureMePct.toFixed(1)}%, Job Fee −${productionSite.jobFeeBonusPct.toFixed(1)}%${durationText} (уже учтено в затратах и времени выше; плюс SCC surcharge 4% — фиксированный, без бонусов).${skillText}`
      : skillText.trim();

  const savings = allBuildCost - totalCost;
  const savingsEl = document.getElementById("costSavings");
  savingsEl.textContent = savings > 1 ? `оптимизация экономит ${fmt(savings)} ISK vs постройка всего вручную` : "";

  const sellLocationLabel = `(${sellSystemName})`;
  document.getElementById("sellLocationLabelQuick").textContent = sellLocationLabel;
  document.getElementById("sellLocationLabelSell").textContent = sellLocationLabel;

  document.getElementById("revenueQuickSell").textContent = revenueQuickSell === null ? "нет ордеров" : `${fmt(revenueQuickSell)} ISK`;
  document.getElementById("revenueSell").textContent = revenueSell === null ? "нет ордеров" : `${fmt(revenueSell)} ISK`;

  // Revenue above is net of Sales Tax + Broker's Fee — this is the raw price
  // per unit you'd actually type into a sell order (or that gets hit on an
  // instant sale), so it matches what the in-game market window shows.
  document.getElementById("quickSellUnitPriceLine").textContent =
    quickSellUnitPrice == null ? "" : `Цена за ед.: ${fmt(quickSellUnitPrice)} ISK`;
  document.getElementById("sellUnitPriceLine").textContent =
    sellUnitPrice == null ? "" : `Выставить по: ${fmt(sellUnitPrice)} ISK/шт.`;

  setProfit("profitQuickSell", revenueQuickSell, totalCost);
  setProfit("profitSell", revenueSell, totalCost);

  document.getElementById("appraiseNote").textContent = "";

  // Single hook for every recompute path (calculate, optimize, build/buy
  // toggle, per-blueprint ME edit, contract-driven auto-recompute) — all of
  // them call renderResults() right after fetching a fresh tree.
  saveUiState();
}

function setProfit(elId, revenue, cost) {
  const el = document.getElementById(elId);
  if (revenue === null) {
    el.textContent = "—";
    el.className = "result-profit";
    return;
  }
  const profit = revenue - cost;
  el.textContent = `${profit >= 0 ? "+" : ""}${fmt(profit)} ISK`;
  el.className = `result-profit ${profit >= 0 ? "profit-pos" : "profit-neg"}`;
}

// ============ blueprints used (right rail): server-resolved, read-only ============

// The server already found the real source for every blueprint actually
// used (own > contract copy > contract original > Forge market — see
// server/blueprintSourcing.js) and folded its real cost into totalCost —
// this just displays what it found, nothing left to pick manually.
const SOURCE_LABELS = { owned: "свой чертёж", copy: "копия (контракт)", original: "оригинал (контракт)", market: "рынок The Forge" };

function renderBlueprintsPanel(data) {
  const list = data.blueprintsNeeded ?? [];
  blueprintsBody.innerHTML = "";
  if (!list.length) {
    blueprintsPanel.classList.add("hidden");
    return;
  }
  blueprintsPanel.classList.remove("hidden");
  for (const bp of list) {
    const tr = document.createElement("tr");
    const sourceLabel = SOURCE_LABELS[bp.source] ?? "—";
    const totalCell =
      bp.source === "owned"
        ? "0 ISK (свой)"
        : bp.totalBlueprintCost === undefined
        ? "—"
        : bp.source === "copy"
        ? `Копий: ${bp.copiesNeeded}, итого ${fmt(bp.totalBlueprintCost)} ISK`
        : `Разово: ${fmt(bp.totalBlueprintCost)} ISK`;

    tr.innerHTML = `
      <td class="name-cell">${iconImg(bp.blueprintTypeID, 24, "icon")}<span class="name">${bp.blueprintName}</span>${bp.source === "owned" ? ' <span class="leaf-tag">свой BPO</span>' : ""}</td>
      <td>${fmt(bp.runsNeeded)}</td>
      <td>${bp.me ?? "—"}</td>
      <td class="stations-cell">${sourceLabel}</td>
      <td class="total-cell">${totalCell}</td>
    `;
    blueprintsBody.appendChild(tr);
  }
}

// ============ open on appraise.gnf.lt (Goonpraisal) ============

document.getElementById("appraiseBtn").addEventListener("click", async () => {
  if (!currentTree || !lastTreeData) return;
  const btn = document.getElementById("appraiseBtn");
  const note = document.getElementById("appraiseNote");
  btn.disabled = true;
  btn.textContent = "Открываю appraise.gnf.lt...";
  note.textContent = "";
  try {
    // Only the materials actually being bought (the leaf boundary of the
    // tree, as the server computed it) — the finished product itself is
    // deliberately left out, since it's built FROM these materials, not an
    // extra item on top of them; including both would double-count the value.
    const lines = lastTreeData.shoppingList.map((e) => `${e.quantity} ${e.name}`);

    const res = await fetch("/api/appraise-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const { url } = await res.json();
    window.open(url, "_blank", "noopener");
    note.textContent = `Открыто в новой вкладке: ${url}. Только материалы для покупки (без самого строящегося предмета — иначе задвоение). Там считает рынок Jita целиком (не только станция 4-4), поэтому цифры могут немного отличаться от наших.`;
  } catch (err) {
    alert(`Не удалось создать appraisal на appraise.gnf.lt: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Открыть все компоненты на appraise.gnf.lt ↗";
  }
});

// ============ structures panel: EVE SSO + known structures ============

const structuresToggleBtn = document.getElementById("structuresToggleBtn");
const structuresPanel = document.getElementById("structuresPanel");
const structuresBody = document.getElementById("structuresBody");
const ssoLoggedOut = document.getElementById("ssoLoggedOut");
const ssoLoggedIn = document.getElementById("ssoLoggedIn");
const loginBtn = document.getElementById("loginBtn");
const oauthConfigStatus = document.getElementById("oauthConfigStatus");
const topbarLoginBtn = document.getElementById("topbarLoginBtn");
const topbarSetupBtn = document.getElementById("topbarSetupBtn");
const topbarAuthStatus = document.getElementById("topbarAuthStatus");
const topbarCharacterName = document.getElementById("topbarCharacterName");
const topbarLogoutBtn = document.getElementById("topbarLogoutBtn");

let structuresLoaded = false;

structuresToggleBtn.addEventListener("click", async () => {
  structuresPanel.classList.toggle("hidden");
  if (!scanPanel.classList.contains("hidden")) scanPanel.classList.add("hidden");
  if (!structuresPanel.classList.contains("hidden") && !structuresLoaded) {
    structuresLoaded = true;
    // Order matters: refreshOauthConfigStatus() decides the topbar "log in"
    // button's visibility from refreshAuthStatus()'s just-set loggedIn flag.
    await refreshAuthStatus();
    await Promise.all([refreshOauthConfigStatus(), refreshStructuresList()]);
  }
});

// If we just came back from /auth/callback, open the panel and show the result.
if (new URLSearchParams(location.search).get("loggedin") === "1") {
  history.replaceState({}, "", location.pathname);
  structuresToggleBtn.click();
}

async function refreshOauthConfigStatus() {
  const res = await fetch("/api/oauth-config/status");
  const data = await res.json();
  document.getElementById("redirectUriHint").textContent = data.redirectUri;
  document.getElementById("scopesHint").textContent = data.scopes.join(", ");
  if (data.clientId) document.getElementById("clientIdInput").value = data.clientId;
  loginBtn.classList.toggle("hidden", !data.configured);
  oauthConfigStatus.textContent = data.configured ? "Client ID/Secret сохранены." : "Ещё не настроено.";
  // Topbar mirrors this: a real "log in" button once configured, a "set up
  // login" shortcut into the panel before that — never both, and neither
  // once actually logged in (see refreshAuthStatus, which hides both).
  topbarLoginBtn.classList.toggle("hidden", !data.configured || topbarAuthStatus.dataset.loggedIn === "1");
  topbarSetupBtn.classList.toggle("hidden", data.configured);
}

document.getElementById("saveOauthConfigBtn").addEventListener("click", async () => {
  const clientId = document.getElementById("clientIdInput").value.trim();
  const clientSecret = document.getElementById("clientSecretInput").value.trim();
  if (!clientId || !clientSecret) return;
  const res = await fetch("/api/oauth-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`Ошибка: ${err.error ?? res.status}`);
    return;
  }
  document.getElementById("clientSecretInput").value = "";
  await refreshOauthConfigStatus();
});

async function refreshAuthStatus() {
  const res = await fetch("/api/auth/status");
  const data = await res.json();
  ssoLoggedOut.classList.toggle("hidden", data.loggedIn);
  ssoLoggedIn.classList.toggle("hidden", !data.loggedIn);

  topbarAuthStatus.dataset.loggedIn = data.loggedIn ? "1" : "0";
  topbarAuthStatus.classList.toggle("hidden", !data.loggedIn);
  if (data.loggedIn) {
    document.getElementById("characterNameLabel").textContent = data.characterName;
    topbarCharacterName.textContent = data.characterName;
    await fetchTaxRates();
  }
}

async function doLogout() {
  await fetch("/api/auth/logout", { method: "POST" });
  await refreshAuthStatus();
  await refreshOauthConfigStatus(); // a real login button should reappear once logged out
}

document.getElementById("logoutBtn").addEventListener("click", doLogout);
topbarLogoutBtn.addEventListener("click", doLogout);

topbarSetupBtn.addEventListener("click", () => {
  structuresPanel.classList.remove("hidden");
  scanPanel.classList.add("hidden");
  document.querySelector(".sso-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("clientIdInput")?.focus();
});

// ============ personal Sales Tax / Broker's Fee (from skills + standings) ============

const salesTaxInput = document.getElementById("salesTaxInput");
const brokerFeeInput = document.getElementById("brokerFeeInput");
const industryLevelInput = document.getElementById("industryLevelInput");
const advancedIndustryLevelInput = document.getElementById("advancedIndustryLevelInput");
const taxRatesStatus = document.getElementById("taxRatesStatus");

async function fetchTaxRates() {
  const btn = document.getElementById("fetchTaxRatesBtn");
  btn.disabled = true;
  taxRatesStatus.textContent = "Запрашиваю скиллы и репутацию...";
  try {
    const res = await fetch("/api/character/tax-rates");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    salesTaxInput.value = data.salesTaxPct.toFixed(2);
    brokerFeeInput.value = data.brokerFeePct.toFixed(2);
    industryLevelInput.value = data.industryLevel;
    advancedIndustryLevelInput.value = data.advancedIndustryLevel;
    taxRatesStatus.textContent = `Accounting ${data.accountingLevel}, Broker Relations ${data.brokerRelationsLevel}, Industry ${data.industryLevel}, Advanced Industry ${data.advancedIndustryLevel}, репутация к фракции ${data.factionStanding.toFixed(1)}, к корпорации ${data.corpStanding.toFixed(1)}.`;
  } catch (err) {
    taxRatesStatus.textContent = `Не удалось подтянуть: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("fetchTaxRatesBtn").addEventListener("click", fetchTaxRates);

document.getElementById("syncCorpBtn").addEventListener("click", async () => {
  const btn = document.getElementById("syncCorpBtn");
  const status = document.getElementById("syncStatus");
  btn.disabled = true;
  status.textContent = "Синхронизирую...";
  try {
    const res = await fetch("/api/my-corp-structures/sync", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    status.textContent = `Готово: найдено структур — ${data.count}.`;
    await refreshStructuresList();
  } catch (err) {
    status.textContent = `Ошибка: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

async function refreshStructuresList() {
  const res = await fetch("/api/structures");
  knownStructures = await res.json();
  refreshStructurePicker();

  structuresBody.innerHTML = "";
  if (!knownStructures.length) {
    structuresBody.innerHTML = `<tr><td colspan="8">Пока пусто.</td></tr>`;
    return;
  }
  for (const s of knownStructures) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.name}</td>
      <td>${s.systemName}</td>
      <td>${s.typeName ?? "—"}</td>
      <td><input type="number" min="0" max="100" step="0.1" value="${s.facilityTax}" class="structure-tax-input" style="width:70px" /></td>
      <td class="me-bonus-cell">+${s.structureMePct.toFixed(1)}%</td>
      <td class="me-bonus-cell">−${s.jobFeeBonusPct.toFixed(1)}%</td>
      <td>${s.source === "corp" ? "корпорация" : "вручную"}</td>
      <td>${s.source === "manual" ? `<button class="remove-structure-btn" data-id="${s.id}">Удалить</button>` : ""}</td>
    `;
    structuresBody.appendChild(tr);

    tr.querySelector(".structure-tax-input").addEventListener("change", async (e) => {
      await fetch(`/api/structures/${s.id}/tax`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facilityTax: Number(e.target.value) || 0 }),
      });
    });

    const removeBtn = tr.querySelector(".remove-structure-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        await fetch(`/api/structures/${s.id}`, { method: "DELETE" });
        await refreshStructuresList();
      });
    }
  }
}

// ============ picking a KNOWN structure (own or someone else's) as the production site ============

function refreshStructurePicker() {
  const current = structurePicker.value;
  structurePicker.innerHTML = knownStructures.length
    ? `<option value="">— вручную, система + налог выше —</option>`
    : `<option value="">— нет структур: добавьте в «🏗️ Мои структуры» ниже —</option>`;
  for (const s of knownStructures) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.name} (${s.systemName}, налог ${s.facilityTax}%, ME +${s.structureMePct.toFixed(1)}%, Job Fee −${s.jobFeeBonusPct.toFixed(1)}%)`;
    structurePicker.appendChild(opt);
  }
  // Keep the current pick selected across a refresh, unless it no longer exists.
  if ([...structurePicker.options].some((o) => o.value === current)) structurePicker.value = current;
  else selectedStructureId = structurePicker.value;
}

// Shared by the picker's own change handler and restoreFromSavedState (a
// restored pick has to re-derive the same read-only system/tax display, not
// just set selectedStructureId, or the two would drift out of sync).
function applyStructureSelection(structureId) {
  selectedStructureId = structureId;
  const structure = knownStructures.find((s) => s.id === selectedStructureId);
  // Manual system/tax fields become read-only display of the resolved values
  // while a structure is picked — the server ignores them anyway once
  // structureId is sent (see resolveProductionSite in index.js), so leaving
  // them editable-looking would be misleading.
  systemSearchInput.disabled = Boolean(structure);
  facilityTaxInput.disabled = Boolean(structure);
  if (structure) {
    systemSearchInput.value = structure.systemName;
    facilityTaxInput.value = structure.facilityTax;
    selectedSystem = { solarSystemID: structure.systemId, name: structure.systemName };
  }
}

structurePicker.addEventListener("change", () => applyStructureSelection(structurePicker.value));

// Restores whatever item/params/tree were on screen before the last reload
// (see saveUiState/loadUiState above) — run after the structures list is
// loaded so a saved structurePicker selection has a matching <option> to
// actually land on.
async function restoreFromSavedState() {
  const state = loadUiState();
  if (!state || !state.selected) return;

  quantityInput.value = state.quantity ?? quantityInput.value;
  facilityTaxInput.value = state.facilityTax ?? facilityTaxInput.value;
  disableReactionsInput.checked = state.disableReactions ?? false;
  salesTaxInput.value = state.salesTaxPct ?? salesTaxInput.value;
  brokerFeeInput.value = state.brokerFeePct ?? brokerFeeInput.value;
  industryLevelInput.value = state.industryLevel ?? industryLevelInput.value;
  advancedIndustryLevelInput.value = state.advancedIndustryLevel ?? advancedIndustryLevelInput.value;
  selectedSystem = state.selectedSystem ?? selectedSystem;
  sellSystem = state.sellSystem ?? sellSystem;
  systemSearchInput.value = selectedSystem.name;
  sellSystemSearchInput.value = sellSystem.name;
  decisions = state.decisions ?? {};
  if (state.selectedStructureId) {
    structurePicker.value = state.selectedStructureId;
    applyStructureSelection(state.selectedStructureId);
  }

  await selectItem(state.selected);
  await calculate(false); // keep the restored decisions instead of resetting them
}

// Structures panel loads lazily (only when opened) but the picker in the
// main calc form and the topbar login status need to be right there from
// the first paint, not hidden behind opening an unrelated panel first.
(async () => {
  await refreshAuthStatus();
  await Promise.all([refreshOauthConfigStatus(), refreshStructuresList()]);
  await restoreFromSavedState();
})();
structuresLoaded = true;

// --- find someone else's (or your own) structure by name via ESI, add it in one click ---

const structureSearchInput = document.getElementById("structureSearchInput");
const structureSearchResults = document.getElementById("structureSearchResults");
const structureSearchStatus = document.getElementById("structureSearchStatus");

let structureSearchTimer = null;
structureSearchInput.addEventListener("input", () => {
  clearTimeout(structureSearchTimer);
  const q = structureSearchInput.value.trim();
  structureSearchStatus.textContent = "";
  if (q.length < 3) {
    structureSearchResults.classList.add("hidden");
    return;
  }
  structureSearchTimer = setTimeout(async () => {
    structureSearchStatus.textContent = "Ищу через ESI...";
    try {
      const res = await fetch(`/api/structures/search?q=${encodeURIComponent(q)}`);
      const list = await res.json();
      if (!res.ok) throw new Error(list.error ?? `HTTP ${res.status}`);

      structureSearchStatus.textContent = list.length ? "" : "Ничего не найдено (нет прав видимости к структуре либо её нет с таким именем).";
      structureSearchResults.innerHTML = "";
      for (const s of list) {
        const div = document.createElement("div");
        div.className = "search-result-row";
        div.innerHTML = `<span>${s.name}</span><span class="sec">${s.systemName}${s.typeName ? `, ${s.typeName}` : ""}</span>`;
        div.addEventListener("click", async () => {
          structureSearchResults.classList.add("hidden");
          structureSearchInput.value = "";
          structureSearchStatus.textContent = `Добавляю «${s.name}»...`;
          const addRes = await fetch("/api/structures", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: s.name,
              systemId: s.systemId,
              typeId: s.typeId,
              typeName: s.typeName,
              structureId: s.structureId,
              facilityTax: 0,
            }),
          });
          if (!addRes.ok) {
            const err = await addRes.json().catch(() => ({}));
            structureSearchStatus.textContent = `Ошибка: ${err.error ?? addRes.status}`;
            return;
          }
          structureSearchStatus.textContent = `Добавлено: «${s.name}». Впишите налог комплекса в таблице выше (ESI его не отдаёт).`;
          await refreshStructuresList();
        });
        structureSearchResults.appendChild(div);
      }
      structureSearchResults.classList.toggle("hidden", list.length === 0);
    } catch (err) {
      structureSearchStatus.textContent = `Ошибка: ${err.message}`;
      structureSearchResults.classList.add("hidden");
    }
  }, 300);
});

// --- add-structure form: its own tiny system search, separate from the main one ---

let newStructureSystem = null;
const newStructureSystemInput = document.getElementById("newStructureSystem");
const newStructureSystemResults = document.getElementById("newStructureSystemResults");

let newStructureSystemTimer = null;
newStructureSystemInput.addEventListener("input", () => {
  clearTimeout(newStructureSystemTimer);
  const q = newStructureSystemInput.value.trim();
  if (!q) {
    newStructureSystemResults.classList.add("hidden");
    return;
  }
  newStructureSystemTimer = setTimeout(async () => {
    const res = await fetch(`/api/systems/search?q=${encodeURIComponent(q)}`);
    const list = await res.json();
    newStructureSystemResults.innerHTML = "";
    for (const sys of list) {
      const div = document.createElement("div");
      div.className = "search-result-row";
      div.innerHTML = `<span>${sys.name}</span><span class="sec">${sys.security.toFixed(1)}</span>`;
      div.addEventListener("click", () => {
        newStructureSystem = sys;
        newStructureSystemInput.value = sys.name;
        newStructureSystemResults.classList.add("hidden");
      });
      newStructureSystemResults.appendChild(div);
    }
    newStructureSystemResults.classList.toggle("hidden", list.length === 0);
  }, 200);
});

document.getElementById("addStructureBtn").addEventListener("click", async () => {
  const name = document.getElementById("newStructureName").value.trim();
  const typeName = document.getElementById("newStructureType").value;
  const facilityTax = Number(document.getElementById("newStructureTax").value) || 0;
  if (!name || !newStructureSystem) {
    alert("Укажите название и систему (выберите из выпадающего списка).");
    return;
  }
  const res = await fetch("/api/structures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, systemId: newStructureSystem.solarSystemID, typeName: typeName || null, facilityTax }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`Ошибка: ${err.error ?? res.status}`);
    return;
  }
  document.getElementById("newStructureName").value = "";
  newStructureSystemInput.value = "";
  newStructureSystem = null;
  document.getElementById("newStructureTax").value = "0";
  await refreshStructuresList();
});

// ============ scan panel: best item to produce within a profit range ============

const scanToggleBtn = document.getElementById("scanToggleBtn");
const scanPanel = document.getElementById("scanPanel");
const scanBtn = document.getElementById("scanBtn");
const scanStatusLine = document.getElementById("scanStatusLine");
const scanResultsBody = document.getElementById("scanResultsBody");

scanToggleBtn.addEventListener("click", () => {
  scanPanel.classList.toggle("hidden");
  if (!structuresPanel.classList.contains("hidden")) structuresPanel.classList.add("hidden");
});

// Same production-site params fetchTree() sends — the profit scan should
// evaluate cost at the SAME structure/system the main calculator is set to,
// not always a plain 0%-tax Jita NPC station.
function buildScanSiteParams(params) {
  if (selectedStructureId) {
    params.set("structureId", selectedStructureId);
  } else {
    params.set("systemId", selectedSystem.solarSystemID);
    params.set("facilityTax", Math.max(0, Number(facilityTaxInput.value) || 0));
  }
  return params;
}

scanBtn.addEventListener("click", async () => {
  const minProfit = document.getElementById("scanMinProfit").value;
  const maxProfit = document.getElementById("scanMaxProfit").value;
  const runs = Math.max(1, Number(document.getElementById("scanRuns").value) || 1);
  const shipsOnly = document.getElementById("scanShipsOnly").checked;

  scanBtn.disabled = true;
  scanBtn.textContent = "Сканирую...";
  scanStatusLine.textContent = shipsOnly
    ? "Ищу реальные чертежи и цены для кораблей..."
    : "Ищу реальные чертежи (контракты + рынок The Forge) и цены ESI для ~4000 предметов — при холодном кэше может занять пару минут...";
  scanResultsBody.innerHTML = "";
  try {
    const salesTaxPct = Math.max(0, Number(salesTaxInput.value) || 0);
    const brokerFeePct = Math.max(0, Number(brokerFeeInput.value) || 0);
    const params = buildScanSiteParams(new URLSearchParams({ runs, limit: "100", salesTaxPct, brokerFeePct }));
    if (shipsOnly) params.set("shipsOnly", "1");
    if (minProfit !== "") params.set("minProfit", minProfit);
    if (maxProfit !== "") params.set("maxProfit", maxProfit);
    const res = await fetch(`/api/scan-products?${params.toString()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    scanStatusLine.textContent = `Проверено ${fmt(data.scanned)} предметов${shipsOnly ? " (только корабли)" : ""}, у ${fmt(data.matched)} нашёлся реальный чертёж и прибыль попала в диапазон (показаны первые ${data.results.length}, отсортированы по прибыли Quick Sell).`;
    renderScanResults(data.results);
  } catch (err) {
    scanStatusLine.textContent = `Ошибка: ${err.message}`;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Найти";
  }
});

function renderScanResults(results) {
  scanResultsBody.innerHTML = "";
  if (!results.length) {
    scanResultsBody.innerHTML = `<tr><td colspan="8">Ничего не найдено в этом диапазоне.</td></tr>`;
    return;
  }
  for (const r of results) {
    const tr = document.createElement("tr");
    const quickSellCell = r.profitQuickSell === null
      ? "нет ордеров"
      : `<span class="${r.profitQuickSell >= 0 ? "profit-pos" : "profit-neg"}">${fmt(r.profitQuickSell)} ISK</span>`;
    const bpcCell = !r.bpc
      ? "—"
      : r.bpc.source === "owned"
      ? `свой чертёж, ME${r.bpc.me}`
      : r.bpc.source === "copy"
      ? `копия, ME${r.bpc.me}, ${fmt(r.bpc.pricePerRun)} ISK/ран`
      : r.bpc.source === "original"
      ? `оригинал (контракт), ME${r.bpc.me}, ${fmt(r.bpc.price)} ISK разово`
      : r.bpc.source === "market"
      ? `рынок The Forge, ME${r.bpc.me}, ${fmt(r.bpc.price)} ISK разово`
      : "не найден — строить нельзя";
    tr.innerHTML = `
      <td class="name-cell">${iconImg(r.typeID, 32, "icon")}<span class="name">${r.name}</span></td>
      <td>${fmt(r.quantity)}${r.sellDepth != null ? ` <span class="hint-inline">(спрос на покупку сейчас: ${fmt(r.sellDepth)})</span>` : ""}</td>
      <td>${fmt(r.cost)} ISK</td>
      <td>${fmt(r.revenueSell)} ISK</td>
      <td class="cost-cell">${fmt(r.profitSell)} ISK</td>
      <td>${quickSellCell}</td>
      <td>${bpcCell}</td>
      <td><button class="pick-btn" data-type-id="${r.typeID}">Открыть</button></td>
    `;
    scanResultsBody.appendChild(tr);

    tr.querySelector(".pick-btn").addEventListener("click", async () => {
      scanPanel.classList.add("hidden");
      await selectItem({ typeID: r.typeID, name: r.name, buildable: true });
      quantityInput.value = r.quantity;
      await calculate();
    });
  }
}

