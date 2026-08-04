// ============================================================================
// stock.js — estoque da casa, em duas listas: ingredientes (pantryStock) e
// itens gerais da casa (houseStock). Cada item tem quantidade atual, unidade
// e um mínimo configurável — abaixo do mínimo, o item "está em falta" e
// entra sozinho na lista de compras (ver shoppingList.js).
// ============================================================================
import { createStore } from './store.js';
import { openModal } from './modal.js';

export const pantryStockStore = createStore('pantryStock'); // { name, qty, unit, minQty }
export const houseStockStore = createStore('houseStock');   // { name, qty, unit, minQty }

export function isLowStock(item) {
  return (item.minQty || 0) > 0 && (item.qty || 0) <= item.minQty;
}

export function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

/** Busca um item do estoque de ingredientes pelo nome (normalizado). */
export function findPantryItemByName(name) {
  const key = normalizeName(name);
  return pantryStockStore.list.find((i) => normalizeName(i.name) === key) || null;
}

export function getLowStockItems(store) {
  return store.list.filter(isLowStock);
}

export function openItemForm(store, existing) {
  openModal({
    title: existing ? 'Editar item' : 'Novo item de estoque',
    bodyHtml: `
      <form id="stockForm">
        <label>Nome</label>
        <input type="text" name="name" required value="${existing?.name ? existing.name.replace(/"/g, '&quot;') : ''}">
        <label>Quantidade atual</label>
        <input type="number" step="any" name="qty" min="0" value="${existing?.qty ?? 0}">
        <label>Unidade (opcional)</label>
        <input type="text" name="unit" placeholder="Ex: kg, un, pacote" value="${existing?.unit || ''}">
        <label>Mínimo (abaixo disso, entra na lista de compras)</label>
        <input type="number" step="any" name="minQty" min="0" value="${existing?.minQty ?? 0}">
        <div class="modal-actions">
          ${existing ? '<button type="button" id="deleteStockBtn" class="btn-secondary" style="color:#b3492f;">Excluir</button>' : ''}
          <button type="button" class="btn-secondary" id="cancelStockBtn">Cancelar</button>
          <button type="submit" class="btn-primary">Salvar</button>
        </div>
      </form>
    `,
    onMount: (modalEl, close) => {
      modalEl.querySelector('#cancelStockBtn').addEventListener('click', close);
      const delBtn = modalEl.querySelector('#deleteStockBtn');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (window.confirm('Excluir este item do estoque?')) {
            await store.remove(existing.id);
            close();
          }
        });
      }
      modalEl.querySelector('#stockForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const data = {
          name: fd.get('name').trim(),
          qty: Number(fd.get('qty')) || 0,
          unit: fd.get('unit').trim(),
          minQty: Number(fd.get('minQty')) || 0
        };
        if (existing) await store.set(existing.id, data);
        else await store.add(data);
        close();
      });
    }
  });
}

async function bumpQty(store, item, delta) {
  const next = Math.max(0, (item.qty || 0) + delta);
  await store.set(item.id, { qty: next });
}

function itemRowHtml(item) {
  const low = isLowStock(item);
  return `
    <div class="stock-row ${low ? 'low' : ''}" data-id="${item.id}">
      <div class="stock-info">
        <div class="stock-name">${item.name} ${low ? '<span class="low-tag">em falta</span>' : ''}</div>
        <div class="stock-qty">${item.qty ?? 0} ${item.unit || ''} ${item.minQty ? '· mín. ' + item.minQty : ''}</div>
      </div>
      <div class="stock-actions">
        <button type="button" class="stepper minus">−</button>
        <button type="button" class="stepper plus">+</button>
        <button type="button" class="btn-secondary edit-stock">✎</button>
      </div>
    </div>
  `;
}

function renderStockList(store, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = [...store.list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  container.innerHTML = items.length
    ? items.map(itemRowHtml).join('')
    : '<p class="hint">Nenhum item cadastrado ainda.</p>';

  container.querySelectorAll('.stock-row').forEach((row) => {
    const item = store.getById(row.dataset.id);
    row.querySelector('.minus').addEventListener('click', () => bumpQty(store, item, -1));
    row.querySelector('.plus').addEventListener('click', () => bumpQty(store, item, 1));
    row.querySelector('.edit-stock').addEventListener('click', () => openItemForm(store, item));
  });
}

export function initStock() {
  pantryStockStore.subscribe(() => renderStockList(pantryStockStore, 'pantryStockList'));
  houseStockStore.subscribe(() => renderStockList(houseStockStore, 'houseStockList'));

  document.getElementById('addPantryItemBtn').addEventListener('click', () => openItemForm(pantryStockStore, null));
  document.getElementById('addHouseItemBtn').addEventListener('click', () => openItemForm(houseStockStore, null));
}
