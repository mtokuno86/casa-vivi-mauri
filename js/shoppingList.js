// ============================================================================
// shoppingList.js — lista de compras gerada a partir dos ingredientes das
// receitas do cardápio da semana selecionada, mais itens avulsos manuais.
// ============================================================================
import { createStore } from './store.js';
import { recipesStore } from './recipes.js';
import { getRecipeIdsForWeek, getCurrentWeekStart, mealPlanStore } from './mealPlanner.js';
import { openModal } from './modal.js';
import { pantryStockStore, houseStockStore, findPantryItemByName, getLowStockItems, openItemForm as openStockItemForm } from './stock.js';

export const shoppingExtrasStore = createStore('shoppingExtras'); // itens avulsos: { name, checked }
export const shoppingChecksStore = createStore('shoppingChecks'); // marcação de itens auto-gerados por semana: id = `${weekStart}:${key}`, { checked: true }

function normalizeName(name) {
  return name.trim().toLowerCase();
}

function aggregateIngredients(weekStart) {
  const recipeIds = getRecipeIdsForWeek(weekStart);
  const groups = new Map(); // key -> { name, unit, qtys: [], recipes: Set }

  recipeIds.forEach((rid) => {
    const recipe = recipesStore.getById(rid);
    if (!recipe) return;
    (recipe.ingredients || []).forEach((ing) => {
      const key = `${normalizeName(ing.name)}|${(ing.unit || '').trim().toLowerCase()}`;
      if (!groups.has(key)) {
        groups.set(key, { name: ing.name, unit: ing.unit, qtys: [], recipes: new Set() });
      }
      const g = groups.get(key);
      if (ing.qty) g.qtys.push(ing.qty);
      g.recipes.add(recipe.title);
    });
  });

  return [...groups.entries()].map(([key, g]) => {
    const numericQtys = g.qtys.map(Number).filter((n) => !Number.isNaN(n));
    let qtyLabel;
    if (numericQtys.length === g.qtys.length && numericQtys.length > 0) {
      qtyLabel = String(numericQtys.reduce((a, b) => a + b, 0));
    } else {
      qtyLabel = g.qtys.join(' + ');
    }
    return {
      key,
      name: g.name,
      unit: g.unit,
      qtyLabel,
      recipes: [...g.recipes]
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function render() {
  const container = document.getElementById('shoppingList');
  if (!container) return;

  const weekStart = getCurrentWeekStart();
  const items = aggregateIngredients(weekStart);

  const autoHtml = items.length ? items.map((item) => {
    const checkId = `${weekStart}:${item.key}`;
    const checked = !!shoppingChecksStore.getById(checkId)?.checked;
    const pantryMatch = findPantryItemByName(item.name);
    const stockTag = pantryMatch && pantryMatch.qty > 0
      ? `<span style="margin-left:6px; font-size:0.72rem; color:#3a6351;" title="Já tem em estoque">✓ tem ${pantryMatch.qty} ${pantryMatch.unit || ''}</span>`
      : '';
    return `
      <div class="shopping-item ${checked ? 'checked' : ''}" data-check-id="${checkId}" data-source="auto">
        <input type="checkbox" ${checked ? 'checked' : ''}>
        <span>${item.qtyLabel ? item.qtyLabel + ' ' : ''}${item.unit ? item.unit + ' ' : ''}${item.name}${stockTag}</span>
        <span style="margin-left:auto; font-size:0.75rem; color:#999;" title="${item.recipes.join(', ')}">🍽️</span>
      </div>
    `;
  }).join('') : '<p class="hint">Nenhum ingrediente — preencha o cardápio da semana em "Cardápio".</p>';

  // Itens básicos: ingredientes ou itens da casa que ficaram abaixo do mínimo
  // configurado no Estoque.
  const lowPantry = getLowStockItems(pantryStockStore).map((i) => ({ ...i, kind: 'ingrediente' }));
  const lowHouse = getLowStockItems(houseStockStore).map((i) => ({ ...i, kind: 'casa' }));
  const lowItems = [...lowPantry, ...lowHouse].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const basicsHtml = lowItems.length ? lowItems.map((item) => {
    const checkId = `basic:${item.kind}:${item.id}`;
    const checked = !!shoppingChecksStore.getById(checkId)?.checked;
    return `
      <div class="shopping-item ${checked ? 'checked' : ''}" data-check-id="${checkId}" data-source="basic" data-kind="${item.kind}" data-item-id="${item.id}">
        <input type="checkbox" ${checked ? 'checked' : ''}>
        <span>${item.name} <span style="font-size:0.75rem; color:#999;">(${item.qty} ${item.unit || ''}, mín. ${item.minQty})</span></span>
        <button type="button" class="restock-btn" style="margin-left:auto; background:none; border:none; color:var(--green);" title="Atualizar estoque após comprar">↻ repor</button>
      </div>
    `;
  }).join('') : '<p class="hint">Nada em falta no estoque básico da casa 👍</p>';

  const extras = shoppingExtrasStore.list;
  const extrasHtml = extras.map((item) => `
    <div class="shopping-item ${item.checked ? 'checked' : ''}" data-id="${item.id}" data-source="extra">
      <input type="checkbox" ${item.checked ? 'checked' : ''}>
      <span>${item.name}</span>
      <button type="button" class="remove-extra" style="margin-left:auto; background:none; border:none; color:#b3492f;">✕</button>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="shopping-group">
      <h4>Do cardápio da semana</h4>
      ${autoHtml}
    </div>
    <div class="shopping-group">
      <h4>Itens básicos da casa (estoque em falta)</h4>
      ${basicsHtml}
    </div>
    <div class="shopping-group">
      <h4>Outros / wishlist</h4>
      ${extrasHtml || '<p class="hint">Nenhum item avulso.</p>'}
    </div>
  `;

  container.querySelectorAll('.shopping-item[data-source="auto"]').forEach((row) => {
    row.querySelector('input').addEventListener('change', (e) => {
      shoppingChecksStore.set(row.dataset.checkId, { checked: e.target.checked });
    });
  });

  container.querySelectorAll('.shopping-item[data-source="basic"]').forEach((row) => {
    row.querySelector('input').addEventListener('change', (e) => {
      shoppingChecksStore.set(row.dataset.checkId, { checked: e.target.checked });
    });
    row.querySelector('.restock-btn').addEventListener('click', () => {
      const store = row.dataset.kind === 'ingrediente' ? pantryStockStore : houseStockStore;
      const item = store.getById(row.dataset.itemId);
      if (item) openStockItemForm(store, item);
    });
  });

  container.querySelectorAll('.shopping-item[data-source="extra"]').forEach((row) => {
    row.querySelector('input').addEventListener('change', (e) => {
      shoppingExtrasStore.set(row.dataset.id, { checked: e.target.checked });
    });
    row.querySelector('.remove-extra').addEventListener('click', () => {
      shoppingExtrasStore.remove(row.dataset.id);
    });
  });
}

function openAddExtraModal() {
  openModal({
    title: 'Novo item avulso',
    bodyHtml: `
      <form id="extraForm">
        <label>Item</label>
        <input type="text" name="name" required placeholder="Ex: sabão em pó">
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="cancelExtraBtn">Cancelar</button>
          <button type="submit" class="btn-primary">Adicionar</button>
        </div>
      </form>
    `,
    onMount: (modalEl, close) => {
      modalEl.querySelector('#cancelExtraBtn').addEventListener('click', close);
      modalEl.querySelector('#extraForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = new FormData(e.target).get('name').trim();
        if (name) await shoppingExtrasStore.add({ name, checked: false });
        close();
      });
    }
  });
}

export function initShoppingList() {
  shoppingExtrasStore.subscribe(render);
  shoppingChecksStore.subscribe(render);
  recipesStore.subscribe(render);
  mealPlanStore.subscribe(render);
  pantryStockStore.subscribe(render);
  houseStockStore.subscribe(render);
  document.getElementById('addShoppingItemBtn').addEventListener('click', openAddExtraModal);

  // Re-renderiza também quando o usuário troca de semana no cardápio.
  ['prevWeekBtn', 'nextWeekBtn'].forEach((id) => {
    document.getElementById(id).addEventListener('click', () => setTimeout(render, 0));
  });

  render();
}

export function refreshShoppingList() {
  render();
}
