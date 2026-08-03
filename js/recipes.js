// ============================================================================
// recipes.js — CRUD de receitas (título, link opcional, ingredientes, modo de
// preparo). Ingredientes são cadastrados manualmente (mais confiável que
// tentar importar automaticamente de qualquer site de receitas).
// ============================================================================
import { createStore } from './store.js';
import { openModal } from './modal.js';

export const recipesStore = createStore('recipes');

function ingredientRowHtml(ing = { qty: '', unit: '', name: '' }) {
  return `
    <div class="ingredient-row" style="display:flex; gap:6px; margin-bottom:6px;">
      <input type="text" class="ing-qty" placeholder="Qtd" value="${ing.qty || ''}" style="width:60px;">
      <input type="text" class="ing-unit" placeholder="Unid." value="${ing.unit || ''}" style="width:70px;">
      <input type="text" class="ing-name" placeholder="Ingrediente" value="${(ing.name || '').replace(/"/g, '&quot;')}" style="flex:1;">
      <button type="button" class="btn-secondary remove-ing" style="padding:6px 10px;">✕</button>
    </div>
  `;
}

function openRecipeForm(existing) {
  const ingredients = existing?.ingredients?.length ? existing.ingredients : [{ qty: '', unit: '', name: '' }];

  openModal({
    title: existing ? 'Editar receita' : 'Nova receita',
    bodyHtml: `
      <form id="recipeForm">
        <label>Título</label>
        <input type="text" name="title" required value="${existing?.title ? existing.title.replace(/"/g, '&quot;') : ''}">

        <label>Link (opcional)</label>
        <input type="url" name="url" placeholder="https://..." value="${existing?.url || ''}">

        <label>Ingredientes</label>
        <div id="ingredientsWrap">${ingredients.map(ingredientRowHtml).join('')}</div>
        <button type="button" id="addIngredientBtn" class="btn-secondary" style="margin-top:4px;">+ ingrediente</button>

        <label>Modo de preparo (opcional)</label>
        <textarea name="instructions">${existing?.instructions || ''}</textarea>

        <div class="modal-actions">
          ${existing ? '<button type="button" id="deleteRecipeBtn" class="btn-secondary" style="color:#b3492f;">Excluir</button>' : ''}
          <button type="button" id="cancelBtn" class="btn-secondary">Cancelar</button>
          <button type="submit" class="btn-primary">Salvar</button>
        </div>
      </form>
    `,
    onMount: (modalEl, close) => {
      const wrap = modalEl.querySelector('#ingredientsWrap');
      modalEl.querySelector('#addIngredientBtn').addEventListener('click', () => {
        wrap.insertAdjacentHTML('beforeend', ingredientRowHtml());
      });
      wrap.addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-ing')) {
          e.target.closest('.ingredient-row').remove();
        }
      });
      modalEl.querySelector('#cancelBtn').addEventListener('click', close);

      const delBtn = modalEl.querySelector('#deleteRecipeBtn');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (window.confirm('Excluir esta receita?')) {
            await recipesStore.remove(existing.id);
            close();
          }
        });
      }

      modalEl.querySelector('#recipeForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const rows = [...wrap.querySelectorAll('.ingredient-row')];
        const ingredients = rows.map((row) => ({
          qty: row.querySelector('.ing-qty').value.trim(),
          unit: row.querySelector('.ing-unit').value.trim(),
          name: row.querySelector('.ing-name').value.trim()
        })).filter((i) => i.name);

        const data = {
          title: fd.get('title').trim(),
          url: fd.get('url').trim(),
          instructions: fd.get('instructions').trim(),
          ingredients
        };

        if (existing) {
          await recipesStore.set(existing.id, data);
        } else {
          await recipesStore.add(data);
        }
        close();
      });
    }
  });
}

function renderRecipeList(container) {
  recipesStore.subscribe((recipes) => {
    if (!recipes.length) {
      container.innerHTML = '<p class="hint">Nenhuma receita ainda. Toque em "+ Nova receita" para cadastrar.</p>';
      return;
    }
    container.innerHTML = recipes.map((r) => `
      <div class="recipe-card" data-id="${r.id}">
        <h3>${r.title}</h3>
        ${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">Ver receita original ↗</a>` : ''}
        <div class="ingredients">${(r.ingredients || []).map((i) => `${i.qty || ''} ${i.unit || ''} ${i.name}`).join(' · ')}</div>
      </div>
    `).join('');

    container.querySelectorAll('.recipe-card').forEach((card) => {
      card.addEventListener('click', () => {
        const recipe = recipesStore.getById(card.dataset.id);
        openRecipeForm(recipe);
      });
    });
  });
}

export function initRecipes() {
  const listContainer = document.getElementById('recipeList');
  renderRecipeList(listContainer);
  document.getElementById('addRecipeBtn').addEventListener('click', () => openRecipeForm(null));
}

/** Abre um seletor simples de receita (usado pelo cardápio semanal). */
export function openRecipePicker(onPick) {
  const recipes = recipesStore.list;
  openModal({
    title: 'Escolher receita',
    bodyHtml: `
      <div id="pickerList" style="display:flex; flex-direction:column; gap:8px; max-height:50vh; overflow-y:auto;">
        ${recipes.length ? recipes.map((r) => `
          <button type="button" class="btn-secondary pick-recipe" data-id="${r.id}" style="text-align:left;">${r.title}</button>
        `).join('') : '<p class="hint">Nenhuma receita cadastrada. Cadastre em "Receitas" primeiro.</p>'}
      </div>
      <div class="modal-actions">
        <button type="button" id="clearSlotBtn" class="btn-secondary">Limpar refeição</button>
        <button type="button" id="cancelPickBtn" class="btn-secondary">Cancelar</button>
      </div>
    `,
    onMount: (modalEl, close) => {
      modalEl.querySelectorAll('.pick-recipe').forEach((btn) => {
        btn.addEventListener('click', () => {
          onPick(btn.dataset.id);
          close();
        });
      });
      modalEl.querySelector('#clearSlotBtn').addEventListener('click', () => {
        onPick(null);
        close();
      });
      modalEl.querySelector('#cancelPickBtn').addEventListener('click', close);
    }
  });
}
