const searchInput = document.getElementById("search");
const browseListEl = document.getElementById("browseList");
const emptyState = document.getElementById("emptyState");
const itemView = document.getElementById("itemView");
const itemIcon = document.getElementById("itemIcon");
const itemName = document.getElementById("itemName");
const itemBadge = document.getElementById("itemBadge");
const sellOrdersBody = document.getElementById("sellOrdersBody");
const buyOrdersBody = document.getElementById("buyOrdersBody");
const quantityInput = document.getElementById("quantity");
const meInput = document.getElementById("me");
const facilityTaxInput = document.getElementById("facilityTax");
const systemSearchInput = document.getElementById("systemSearch");
const systemResultsEl = document.getElementById("systemResults");
const sellSystemSearchInput = document.getElementById("sellSystemSearch");
const sellSystemResultsEl = document.getElementById("sellSystemResults");
const calcBtn = document.getElementById("calcBtn");
const treePanel = document.getElementById("treePanel");
const treeBody = document.getElementById("tree");
const resultsPanel = document.getElementById("resultsPanel");

let selected = null; // { typeID, name, buildable }
let currentTree = null;
let decisions = {}; // typeID -> 'build' | 'buy' (sent to the server as overrides)
let selectedSystem = { solarSystemID: 30000142, name: "Jita" }; // production system — job cost
let sellSystem = { solarSystemID: 30000142, name: "Jita" }; // where the finished product is sold — revenue only
let lastTreeData = null; // full last /api/tree response: totals + shoppingList, server-computed

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
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
  row.innerHTML = `<span class="toggle">▸</span><span class="icon folder-icon">📁</span><span class="label">${group.name}</span>`;
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
  row.addEventListener("click", () => selectItem(item));
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

  treePanel.hidden = true;
  resultsPanel.hidden = true;
  currentTree = null;

  sellOrdersBody.innerHTML = `<tr class="empty-row"><td colspan="2">Загрузка...</td></tr>`;
  buyOrdersBody.innerHTML = `<tr class="empty-row"><td colspan="2">Загрузка...</td></tr>`;
  const res = await fetch(`/api/orderbook?typeId=${item.typeID}`);
  const book = await res.json();
  renderOrderTable(sellOrdersBody, book.sell);
  renderOrderTable(buyOrdersBody, book.buy);
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
  const me = Math.min(10, Math.max(0, Number(meInput.value) || 0));
  const facilityTax = Math.max(0, Number(facilityTaxInput.value) || 0);
  const systemId = selectedSystem.solarSystemID;
  const sellSystemId = sellSystem.solarSystemID;
  const salesTaxPct = Math.max(0, Number(salesTaxInput.value) || 0);
  const brokerFeePct = Math.max(0, Number(brokerFeeInput.value) || 0);
  const params = new URLSearchParams({ typeId: selected.typeID, quantity, me, systemId, facilityTax, sellSystemId, salesTaxPct, brokerFeePct });
  if (Object.keys(decisions).length) params.set("overrides", JSON.stringify(decisions));

  const res = await fetch(`/api/tree?${params.toString()}`);
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function calculate() {
  if (!selected) return;
  decisions = {}; // fresh calculation always starts from server defaults

  calcBtn.disabled = true;
  calcBtn.textContent = "Загрузка цен...";
  try {
    const data = await fetchTree();
    lastTreeData = data;
    currentTree = data.tree;
    treePanel.hidden = false;
    resultsPanel.hidden = false;
    renderTree();
    renderResults();
  } catch (err) {
    alert(`Ошибка: ${err.message}`);
  } finally {
    calcBtn.disabled = false;
    calcBtn.textContent = "Рассчитать производство";
  }
}

calcBtn.addEventListener("click", calculate);

document.getElementById("optimizeBtn").addEventListener("click", async () => {
  if (!currentTree) return;
  decisions = {}; // clears any manual overrides, restoring the server's optimum
  const btn = document.getElementById("optimizeBtn");
  btn.disabled = true;
  try {
    const data = await fetchTree();
    lastTreeData = data;
    currentTree = data.tree;
    renderTree();
    renderResults();
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
  const me = Math.min(10, Math.max(0, Number(meInput.value) || 0));
  const facilityTax = Math.max(0, Number(facilityTaxInput.value) || 0);

  findSystemBtn.disabled = true;
  findSystemBtn.textContent = "Ищу...";
  try {
    const params = new URLSearchParams({ typeId: selected.typeID, quantity, me, facilityTax, maxJumps: 10, limit: 10 });
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

  const priceLabel = isLeaf ? `${fmt(node.unitCost)} ISK` : `${node.runs} runs`;
  const jobCostLabel = !isLeaf && node.buildable ? `${fmt(node.jobCost)} ISK` : "—";

  tr.innerHTML = `
    <td class="name-cell" style="padding-left:${8 + depth * 18}px">
      ${iconImg(node.typeID, 32, "icon")}<span class="name">${node.name}</span>
    </td>
    <td>${fmt(node.quantity)}</td>
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
        const data = await fetchTree();
        lastTreeData = data;
        currentTree = data.tree;
        renderTree();
        renderResults();
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
  const { totalCost, totalJobCost, totalMaterialsCost, allBuildCost, revenueSell, revenueQuickSell, sellSystemName } = lastTreeData;

  document.getElementById("totalCost").textContent = `${fmt(totalCost)} ISK`;
  document.getElementById("costBreakdown").textContent = `материалы ${fmt(totalMaterialsCost)} + job cost ${fmt(totalJobCost)} ISK (${selectedSystem.name})`;

  const savings = allBuildCost - totalCost;
  const savingsEl = document.getElementById("costSavings");
  savingsEl.textContent = savings > 1 ? `оптимизация экономит ${fmt(savings)} ISK vs постройка всего вручную` : "";

  const sellLocationLabel = `(${sellSystemName})`;
  document.getElementById("sellLocationLabelQuick").textContent = sellLocationLabel;
  document.getElementById("sellLocationLabelSell").textContent = sellLocationLabel;

  document.getElementById("revenueQuickSell").textContent = revenueQuickSell === null ? "нет ордеров" : `${fmt(revenueQuickSell)} ISK`;
  document.getElementById("revenueSell").textContent = revenueSell === null ? "нет ордеров" : `${fmt(revenueSell)} ISK`;

  setProfit("profitQuickSell", revenueQuickSell, totalCost);
  setProfit("profitSell", revenueSell, totalCost);

  document.getElementById("appraiseNote").textContent = "";
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

let structuresLoaded = false;

structuresToggleBtn.addEventListener("click", async () => {
  structuresPanel.classList.toggle("hidden");
  if (!scanPanel.classList.contains("hidden")) scanPanel.classList.add("hidden");
  if (!lpPanel.classList.contains("hidden")) lpPanel.classList.add("hidden");
  if (!structuresPanel.classList.contains("hidden") && !structuresLoaded) {
    structuresLoaded = true;
    await Promise.all([refreshOauthConfigStatus(), refreshAuthStatus(), refreshStructuresList()]);
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
  if (data.loggedIn) {
    document.getElementById("characterNameLabel").textContent = data.characterName;
    await fetchTaxRates();
  }
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  await refreshAuthStatus();
});

// ============ personal Sales Tax / Broker's Fee (from skills + standings) ============

const salesTaxInput = document.getElementById("salesTaxInput");
const brokerFeeInput = document.getElementById("brokerFeeInput");
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
    taxRatesStatus.textContent = `Accounting ${data.accountingLevel}, Broker Relations ${data.brokerRelationsLevel}, репутация к фракции ${data.factionStanding.toFixed(1)}, к корпорации ${data.corpStanding.toFixed(1)}.`;
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
  const list = await res.json();
  structuresBody.innerHTML = "";
  if (!list.length) {
    structuresBody.innerHTML = `<tr><td colspan="6">Пока пусто.</td></tr>`;
    return;
  }
  for (const s of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.name}</td>
      <td>${s.systemName}</td>
      <td>${s.typeName ?? "—"}</td>
      <td><input type="number" min="0" max="100" step="0.1" value="${s.facilityTax}" class="structure-tax-input" style="width:70px" /></td>
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
  if (!lpPanel.classList.contains("hidden")) lpPanel.classList.add("hidden");
});

scanBtn.addEventListener("click", async () => {
  const minProfit = document.getElementById("scanMinProfit").value;
  const maxProfit = document.getElementById("scanMaxProfit").value;
  const me = Math.min(10, Math.max(0, Number(document.getElementById("scanMe").value) || 0));

  scanBtn.disabled = true;
  scanBtn.textContent = "Сканирую...";
  scanStatusLine.textContent = "Перебираю ~5000 предметов и цены ESI — при холодном кэше может занять пару минут...";
  scanResultsBody.innerHTML = "";
  try {
    const salesTaxPct = Math.max(0, Number(salesTaxInput.value) || 0);
    const brokerFeePct = Math.max(0, Number(brokerFeeInput.value) || 0);
    const params = new URLSearchParams({ me, limit: "100", salesTaxPct, brokerFeePct });
    if (minProfit !== "") params.set("minProfit", minProfit);
    if (maxProfit !== "") params.set("maxProfit", maxProfit);
    const res = await fetch(`/api/scan-products?${params.toString()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    scanStatusLine.textContent = `Проверено ${fmt(data.scanned)} предметов, в диапазон попало ${fmt(data.matched)} (показаны первые ${data.results.length}, отсортированы по прибыли Sell).`;
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
    scanResultsBody.innerHTML = `<tr><td colspan="7">Ничего не найдено в этом диапазоне.</td></tr>`;
    return;
  }
  for (const r of results) {
    const tr = document.createElement("tr");
    const quickSellCell = r.profitQuickSell === null
      ? "нет ордеров"
      : `<span class="${r.profitQuickSell >= 0 ? "profit-pos" : "profit-neg"}">${fmt(r.profitQuickSell)} ISK</span>`;
    tr.innerHTML = `
      <td class="name-cell">${iconImg(r.typeID, 32, "icon")}<span class="name">${r.name}</span></td>
      <td>${fmt(r.quantity)}</td>
      <td>${fmt(r.cost)} ISK</td>
      <td>${fmt(r.revenueSell)} ISK</td>
      <td class="cost-cell">${fmt(r.profitSell)} ISK</td>
      <td>${quickSellCell}</td>
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

// ============ LP store panel: Guristas / State Protectorate offer profit ============

const lpToggleBtn = document.getElementById("lpToggleBtn");
const lpPanel = document.getElementById("lpPanel");
const lpBtn = document.getElementById("lpBtn");
const lpStatusLine = document.getElementById("lpStatusLine");
const lpResultsBody = document.getElementById("lpResultsBody");

lpToggleBtn.addEventListener("click", () => {
  lpPanel.classList.toggle("hidden");
  if (!scanPanel.classList.contains("hidden")) scanPanel.classList.add("hidden");
  if (!structuresPanel.classList.contains("hidden")) structuresPanel.classList.add("hidden");
});

lpBtn.addEventListener("click", async () => {
  const corps = [];
  if (document.getElementById("lpCorpGuristas").checked) corps.push("guristas");
  if (document.getElementById("lpCorpState").checked) corps.push("state_protectorate");
  if (!corps.length) {
    lpStatusLine.textContent = "Выберите хотя бы одну корпорацию.";
    return;
  }
  const me = Math.min(10, Math.max(0, Number(document.getElementById("lpMe").value) || 0));

  lpBtn.disabled = true;
  lpBtn.textContent = "Ищу...";
  lpStatusLine.textContent = "Загружаю офферы LP-стора и цены ESI...";
  lpResultsBody.innerHTML = "";
  try {
    const params = new URLSearchParams({ me, corp: corps.join(",") });
    const res = await fetch(`/api/lp-offers?${params.toString()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    lpStatusLine.textContent = `Оценено ${fmt(data.priced)} из ${fmt(data.scanned)} офферов (остальные пропущены — нет рыночных цен), отсортировано по ISK/LP.`;
    renderLpResults(data.results);
  } catch (err) {
    lpStatusLine.textContent = `Ошибка: ${err.message}`;
  } finally {
    lpBtn.disabled = false;
    lpBtn.textContent = "Найти";
  }
});

function renderLpResults(results) {
  lpResultsBody.innerHTML = "";
  if (!results.length) {
    lpResultsBody.innerHTML = `<tr><td colspan="11">Ничего не удалось оценить.</td></tr>`;
    return;
  }
  for (const r of results) {
    const tr = document.createElement("tr");
    const nameLabel = r.isBlueprint ? `${r.name} <span class="leaf-tag">чертёж → ${r.productName}</span>` : r.name;
    const reqItemsLabel = r.requiredItems.length
      ? r.requiredItems.map((ri) => `${fmt(ri.quantity)}× ${ri.name}`).join(", ")
      : "—";
    const profitClass = r.netProfit >= 0 ? "profit-pos" : "profit-neg";
    const iskPerLpLabel = r.iskPerLp === null ? "—" : fmt(r.iskPerLp);
    tr.innerHTML = `
      <td>${r.corp}</td>
      <td class="name-cell">${iconImg(r.typeID, 32, "icon")}<span class="name">${nameLabel}</span></td>
      <td>${fmt(r.quantity)}</td>
      <td>${fmt(r.lpCost)}</td>
      <td>${fmt(r.iskCost)} ISK</td>
      <td class="stations-cell">${reqItemsLabel}</td>
      <td>${fmt(r.totalCost)} ISK</td>
      <td>${fmt(r.itemValue)} ISK</td>
      <td class="${profitClass}">${fmt(r.netProfit)} ISK</td>
      <td class="${profitClass}">${iskPerLpLabel}</td>
      <td><button class="pick-btn" data-type-id="${r.isBlueprint ? r.productTypeId : r.typeID}">Открыть</button></td>
    `;
    lpResultsBody.appendChild(tr);

    const openBtn = tr.querySelector(".pick-btn");
    if (r.isBlueprint && !r.productTypeId) {
      openBtn.disabled = true;
    } else {
      openBtn.addEventListener("click", async () => {
        lpPanel.classList.add("hidden");
        const typeID = r.isBlueprint ? r.productTypeId : r.typeID;
        const name = r.isBlueprint ? r.productName : r.name;
        await selectItem({ typeID, name, buildable: true });
        quantityInput.value = r.isBlueprint ? r.runQuantity ?? 1 : r.quantity;
        await calculate();
      });
    }
  }
}
