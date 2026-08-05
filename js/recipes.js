// ============================================================================
// recipes.js — CRUD de receitas (título, link opcional, ingredientes, modo de
// preparo, tempo de preparo/rendimento/dificuldade). Ingredientes podem ser
// digitados manualmente ou pré-preenchidos por "Importar de link" (quando
// a página da receita tiver dados estruturados — ver functions/index.js).
// De qualquer forma, o usuário sempre revisa/edita antes de salvar.
// ============================================================================
import { createStore } from './store.js';
import { openModal } from './modal.js';
import { recipeImportFunctionUrl } from './config.js';

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
        ${recipeImportFunctionUrl ? `
          <div style="background:var(--cream); border-radius:10px; padding:10px; margin-bottom:10px;">
            <label style="margin-top:0;">Importar de um link (opcional)</label>
            <div style="display:flex; gap:6px;">
              <input type="url" id="importUrlInput" placeholder="Cole o link da receita">
              <button type="button" id="importBtn" class="btn-secondary">Importar</button>
            </div>
            <div id="importStatus" class="hint" style="margin:4px 0 0;"></div>
          </div>
        ` : ''}

        <label>Título</label>
        <input type="text" name="title" required value="${existing?.title ? existing.title.replace(/"/g, '&quot;') : ''}">

        <label>Link (opcional)</label>
        <input type="url" name="url" placeholder="https://..." value="${existing?.url || ''}">

        <div style="display:flex; gap:8px;">
          <div style="flex:1;">
            <label>Tempo de preparo</label>
            <input type="text" name="prepTime" placeholder="Ex: 30 min" value="${existing?.prepTime || ''}">
          </div>
          <div style="flex:1;">
            <label>Rendimento</label>
            <input type="text" name="yieldInfo" placeholder="Ex: 4 porções" value="${existing?.yieldInfo || ''}">
          </div>
          <div style="flex:1;">
            <label>Dificuldade</label>
            <select name="difficulty">
              <option value="" ${!existing?.difficulty ? 'selected' : ''}>—</option>
              <option value="facil" ${existing?.difficulty === 'facil' ? 'selected' : ''}>Fácil</option>
              <option value="media" ${existing?.difficulty === 'media' ? 'selected' : ''}>Média</option>
              <option value="dificil" ${existing?.difficulty === 'dificil' ? 'selected' : ''}>Difícil</option>
            </select>
          </div>
        </div>

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

      const importBtn = modalEl.querySelector('#importBtn');
      if (importBtn) {
        importBtn.addEventListener('click', async () => {
          const urlInput = modalEl.querySelector('#importUrlInput');
          const status = modalEl.querySelector('#importStatus');
          const url = urlInput.value.trim();
          if (!url) return;
          status.textContent = 'Buscando dados da receita…';
          importBtn.disabled = true;
          try {
            const resp = await fetch(`${recipeImportFunctionUrl}?url=${encodeURIComponent(url)}`);
            const data = await resp.json();
            if (!resp.ok) {
              status.textContent = data.error || 'Não foi possível importar essa receita — cadastre manualmente.';
              return;
            }
            if (data.title) modalEl.querySelector('[name="title"]').value = data.title;
            modalEl.querySelector('[name="url"]').value = data.sourceUrl || url;
            if (data.prepTime || data.totalTime) modalEl.querySelector('[name="prepTime"]').value = data.prepTime || data.totalTime;
            if (data.yield) modalEl.querySelector('[name="yieldInfo"]').value = data.yield;
            if (data.instructions) modalEl.querySelector('[name="instructions"]').value = data.instructions;
            if (data.ingredients?.length) {
              wrap.innerHTML = data.ingredients.map((i) => ingredientRowHtml(i)).join('');
            }
            status.textContent = 'Importado — revise os campos antes de salvar (a extração automática pode não ser 100% exata).';
          } catch (e) {
            console.error(e);
            status.textContent = 'Erro ao importar. Cadastre manualmente.';
          } finally {
            importBtn.disabled = false;
          }
        });
      }

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
          prepTime: fd.get('prepTime').trim(),
          yieldInfo: fd.get('yieldInfo').trim(),
          difficulty: fd.get('difficulty'),
          instructions: fd.get('instructions').trim(),
          ingredients
        };

        if (!existing) {
          const key = data.title.trim().toLowerCase();
          const dup = recipesStore.list.find((r) => (r.title || '').trim().toLowerCase() === key);
          if (dup && !window.confirm(`Já existe uma receita chamada "${dup.title}". Cadastrar mesmo assim?`)) {
            return;
          }
        }

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

const DIFFICULTY_LABELS = { facil: 'Fácil', media: 'Média', dificil: 'Difícil' };

function renderRecipeList(container) {
  recipesStore.subscribe((recipes) => {
    if (!recipes.length) {
      container.innerHTML = '<p class="hint">Nenhuma receita ainda. Toque em "+ Nova receita" para cadastrar.</p>';
      return;
    }
    container.innerHTML = recipes.map((r) => {
      const metaParts = [];
      if (r.prepTime) metaParts.push(`⏱️ ${r.prepTime}`);
      if (r.yieldInfo) metaParts.push(`🍽️ ${r.yieldInfo}`);
      if (r.difficulty) metaParts.push(`📊 ${DIFFICULTY_LABELS[r.difficulty] || r.difficulty}`);
      return `
      <div class="recipe-card" data-id="${r.id}">
        <h3>${r.title}</h3>
        ${metaParts.length ? `<div style="font-size:0.8rem; color:#776; margin-bottom:4px;">${metaParts.join(' · ')}</div>` : ''}
        ${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">Ver receita original ↗</a>` : ''}
        <div class="ingredients">${(r.ingredients || []).map((i) => `${i.qty || ''} ${i.unit || ''} ${i.name}`).join(' · ')}</div>
      </div>
    `;
    }).join('');

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
