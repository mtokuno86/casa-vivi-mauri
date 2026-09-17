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

// ----------------------------------------------------------------------------
// Casamento aproximado de nome — usado pela leitura de nota fiscal (ver
// purchases.js): o nome que vem da nota costuma ser abreviado/em caixa alta
// e cheio de detalhes da marca/tamanho (ex: "ARROZ TIO JOAO T1 5KG"), bem
// diferente de como a pessoa cadastrou o item no Estoque (ex: "Arroz").
// Em vez de exigir nome idêntico, compara por PALAVRAS em comum: se todas as
// palavras do nome do Estoque aparecem dentro do nome da nota (ou vice
// versa), considera um match. Não é perfeito, mas a tela de revisão sempre
// deixa a pessoa corrigir antes de salvar.
// ----------------------------------------------------------------------------
function wordsOf(name) {
  return normalizeName(name).split(/[^a-zà-ú0-9]+/).filter((w) => w.length > 2);
}

function wordOverlapScore(a, b) {
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (!wa.length || !wb.length) return 0;
  const setB = new Set(wb);
  const shared = wa.filter((w) => setB.has(w)).length;
  return shared / Math.min(wa.length, wb.length);
}

/** Melhor item do Estoque (ingrediente OU casa) pro nome dado, ou null se nada bater bem o bastante. Retorna { item, kind, score }. */
export function findBestStockMatch(name) {
  const candidates = [
    ...pantryStockStore.list.map((item) => ({ item, kind: 'pantry' })),
    ...houseStockStore.list.map((item) => ({ item, kind: 'house' }))
  ];
  let best = null;
  for (const c of candidates) {
    const score = wordOverlapScore(name, c.item.name);
    if (score >= 0.6 && (!best || score > best.score)) best = { item: c.item, kind: c.kind, score };
  }
  return best;
}

export function stockOf(kind) {
  return kind === 'house' ? houseStockStore : pantryStockStore;
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
        <label>Categoria (opcional — usada para sugerir trocas mais baratas em "Compras")</label>
        <input type="text" name="categoria" placeholder="Ex: arroz, leite, sabonete" value="${existing?.categoria ? existing.categoria.replace(/"/g, '&quot;') : ''}">
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
          minQty: Number(fd.get('minQty')) || 0,
          categoria: (fd.get('categoria') || '').trim()
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
        <div class="stock-qty">${item.qty ?? 0} ${item.unit || ''} ${item.minQty ? '· mín. ' + item.minQty : ''} ${item.categoria ? '· ' + item.categoria : ''}</div>
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
