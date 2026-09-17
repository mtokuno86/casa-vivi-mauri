// ============================================================================
// priceInsights.js — a partir do histórico de compras (purchaseItems, criado
// em purchases.js ao escanear notas fiscais), monta:
//  - lista de itens recorrentes com preço médio/mínimo/máximo e tendência;
//  - um "conferir preço agora" (digita o preço que está vendo no mercado e o
//    app diz se está bom, baseado no histórico);
//  - sugestões de troca entre itens da mesma categoria (ver campo
//    "categoria" no Estoque) pelo preço por unidade.
//
// Tudo calculado em memória a partir do que já está sincronizado (sem
// nenhuma Cloud Function nova) — funciona offline também.
// ============================================================================
import { purchaseItemsStore } from './purchases.js';

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function fmtMoney(n) {
  return n == null ? '—' : `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return d && m && y ? `${d}/${m}/${y}` : dateStr;
}

/** Agrupa purchaseItems por nome normalizado — cada grupo é "o mesmo item" ao longo do tempo. */
function groupItems() {
  const groups = new Map(); // normalizedName -> { name, categoria, entries: [{date, unitPrice, unit}] }
  purchaseItemsStore.list
    .filter((i) => i.unitPrice != null && i.normalizedName)
    .forEach((i) => {
      if (!groups.has(i.normalizedName)) {
        groups.set(i.normalizedName, { name: i.name, categoria: i.categoria || '', entries: [] });
      }
      const g = groups.get(i.normalizedName);
      g.entries.push({ date: i.date, unitPrice: i.unitPrice, unit: i.unit });
      // Mantém sempre o nome/categoria da compra mais recente (mais provável de estar atualizado).
      if (!g.entries.__latestDate || i.date >= g.entries.__latestDate) {
        g.name = i.name;
        if (i.categoria) g.categoria = i.categoria;
        g.entries.__latestDate = i.date;
      }
    });
  return groups;
}

function statsFor(entries) {
  const sorted = [...entries].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const prices = sorted.map((e) => e.unitPrice);
  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const last = sorted[sorted.length - 1];
  const prevAvg = prices.length > 1 ? prices.slice(0, -1).reduce((s, p) => s + p, 0) / (prices.length - 1) : avg;
  return { count: prices.length, avg, min, max, last, trendUp: last.unitPrice > prevAvg * 1.03, trendDown: last.unitPrice < prevAvg * 0.97 };
}

function itemRowHtml(normalizedName, g) {
  const s = statsFor(g.entries);
  const trendIcon = s.trendUp ? '📈' : s.trendDown ? '📉' : '➖';
  const goodPrice = s.last.unitPrice <= s.avg * 0.95;
  const badPrice = s.last.unitPrice >= s.avg * 1.1;
  const tag = goodPrice ? '<span style="color:#3a6351;">bom preço ✓</span>' : badPrice ? '<span style="color:#b3492f;">acima da média</span>' : '';
  return `
    <tr data-key="${escapeHtml(normalizedName)}">
      <td>${escapeHtml(g.name)}${g.categoria ? `<div style="font-size:0.72rem; color:#999;">${escapeHtml(g.categoria)}</div>` : ''}</td>
      <td>${s.count}x</td>
      <td>${fmtMoney(s.last.unitPrice)} <span style="font-size:0.75rem; color:#999;">(${fmtDate(s.last.date)})</span></td>
      <td>${fmtMoney(s.avg)}</td>
      <td>${fmtMoney(s.min)} – ${fmtMoney(s.max)}</td>
      <td>${trendIcon} ${tag}</td>
    </tr>
  `;
}

function renderRecurringTable(groups) {
  const entries = [...groups.entries()]
    .filter(([, g]) => g.entries.length >= 1)
    .sort((a, b) => b[1].entries.length - a[1].entries.length || (b[1].entries.__latestDate || '').localeCompare(a[1].entries.__latestDate || ''));

  if (!entries.length) {
    return '<p class="hint">Nenhuma compra registrada ainda — use "📷 Escanear nota" para começar a montar seu histórico de preços.</p>';
  }

  return `
    <div style="overflow-x:auto;">
      <table class="price-history-table" style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="text-align:left; font-size:0.8rem; color:#777;">
            <th>Item</th><th>Vezes</th><th>Última compra</th><th>Média</th><th>Faixa</th><th>Tendência</th>
          </tr>
        </thead>
        <tbody>${entries.map(([key, g]) => itemRowHtml(key, g)).join('')}</tbody>
      </table>
    </div>
  `;
}

// ----------------------------------------------------------------------------
// Sugestões de troca: dentro da mesma "categoria" (campo opcional no
// Estoque), compara o preço médio por unidade de cada item diferente e, se
// houver uma opção claramente mais barata (>10% de diferença) que também foi
// comprada mais de uma vez (pra não sugerir com base numa compra isolada),
// sugere a troca.
// ----------------------------------------------------------------------------
function renderSwapSuggestions(groups) {
  const byCategoria = new Map();
  groups.forEach((g, key) => {
    if (!g.categoria) return;
    if (!byCategoria.has(g.categoria)) byCategoria.set(g.categoria, []);
    byCategoria.get(g.categoria).push({ key, ...g, stats: statsFor(g.entries) });
  });

  const suggestions = [];
  byCategoria.forEach((items, categoria) => {
    if (items.length < 2) return;
    const sorted = [...items].sort((a, b) => a.stats.avg - b.stats.avg);
    const cheapest = sorted[0];
    sorted.slice(1).forEach((other) => {
      if (other.stats.avg > cheapest.stats.avg * 1.1) {
        const savingsPct = Math.round((1 - cheapest.stats.avg / other.stats.avg) * 100);
        suggestions.push({ categoria, from: other, to: cheapest, savingsPct });
      }
    });
  });

  if (!suggestions.length) return '';

  return `
    <div class="card" style="margin-top:14px;">
      <h3>💡 Sugestões de troca</h3>
      <ul class="today-tasks">
        ${suggestions.map((s) => `
          <li>Trocando <strong>${escapeHtml(s.from.name)}</strong> por <strong>${escapeHtml(s.to.name)}</strong> (${escapeHtml(s.categoria)}), a média sai ${s.savingsPct}% mais barata (${fmtMoney(s.to.stats.avg)} vs ${fmtMoney(s.from.stats.avg)}).</li>
        `).join('')}
      </ul>
    </div>
  `;
}

function renderPriceCheckTool(groups) {
  const options = [...groups.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'pt-BR'))
    .map(([key, g]) => `<option value="${escapeHtml(key)}">${escapeHtml(g.name)}</option>`)
    .join('');

  return `
    <div class="card" style="margin-top:14px;">
      <h3>🔍 Conferir preço agora</h3>
      <p class="hint">Está no mercado e quer saber se vale a pena estocar? Escolha o item e digite o preço que está vendo.</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
        <div>
          <label>Item</label>
          <select id="priceCheckItem">${options}</select>
        </div>
        <div>
          <label>Preço visto agora (R$)</label>
          <input type="number" step="any" min="0" id="priceCheckValue" style="width:100px;">
        </div>
        <button type="button" id="priceCheckBtn" class="btn-primary">Conferir</button>
      </div>
      <p id="priceCheckResult" style="margin-top:10px; font-weight:600;"></p>
    </div>
  `;
}

function bindPriceCheckTool(container, groups) {
  const btn = container.querySelector('#priceCheckBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const key = container.querySelector('#priceCheckItem').value;
    const value = Number(container.querySelector('#priceCheckValue').value);
    const resultEl = container.querySelector('#priceCheckResult');
    const g = groups.get(key);
    if (!g || !value) { resultEl.textContent = 'Escolha um item e digite um preço.'; resultEl.style.color = '#777'; return; }
    const s = statsFor(g.entries);
    if (value <= s.min) {
      resultEl.textContent = `🟢 Ótimo preço! É o menor (ou igual ao menor) já visto — média histórica ${fmtMoney(s.avg)}. Vale estocar.`;
      resultEl.style.color = '#3a6351';
    } else if (value <= s.avg * 0.95) {
      resultEl.textContent = `🟢 Bom preço — abaixo da média histórica de ${fmtMoney(s.avg)}.`;
      resultEl.style.color = '#3a6351';
    } else if (value >= s.avg * 1.1) {
      resultEl.textContent = `🔴 Está caro — média histórica é ${fmtMoney(s.avg)} (já visto por até ${fmtMoney(s.min)}). Talvez valha esperar.`;
      resultEl.style.color = '#b3492f';
    } else {
      resultEl.textContent = `🟡 Preço na média histórica (${fmtMoney(s.avg)}). Nem promoção, nem caro.`;
      resultEl.style.color = '#8a6d1f';
    }
  });
}

export function renderPriceInsights() {
  const container = document.getElementById('priceInsights');
  if (!container) return;
  const groups = groupItems();
  container.innerHTML = `
    <div class="card">
      <h3>📊 Histórico de preços</h3>
      ${renderRecurringTable(groups)}
    </div>
    ${groups.size ? renderPriceCheckTool(groups) : ''}
    ${renderSwapSuggestions(groups)}
  `;
  bindPriceCheckTool(container, groups);
}

export function initPriceInsights() {
  purchaseItemsStore.subscribe(renderPriceInsights);
}
