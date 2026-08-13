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
import { PROTEINS, CUISINES, EQUIPMENT_OPTIONS, guessFacets } from './recipeFacets.js';

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

function openRecipeForm(existing, prefillImportUrl) {
  const ingredients = existing?.ingredients?.length ? existing.ingredients : [{ qty: '', unit: '', name: '' }];

  openModal({
    title: existing ? 'Editar receita' : 'Nova receita',
    bodyHtml: `
      <form id="recipeForm">
        ${recipeImportFunctionUrl ? `
          <div style="background:var(--cream); border-radius:10px; padding:10px; margin-bottom:10px;">
            <label style="margin-top:0;">Importar de um link (opcional)</label>
            <div style="display:flex; gap:6px;">
              <input type="url" id="importUrlInput" placeholder="Cole o link da receita" value="${prefillImportUrl ? prefillImportUrl.replace(/"/g, '&quot;') : ''}">
              <button type="button" id="importBtn" class="btn-secondary">Importar</button>
            </div>
            <div id="importStatus" class="hint" style="margin:4px 0 0;"></div>
          </div>
        ` : ''}

        <label>Título</label>
        <input type="text" name="title" required value="${existing?.title ? existing.title.replace(/"/g, '&quot;') : ''}">

        <label>Link (opcional)</label>
        <input type="url" name="url" placeholder="https://..." value="${existing?.url || (!recipeImportFunctionUrl && prefillImportUrl ? prefillImportUrl : '')}">

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

        <div style="background:var(--cream); border-radius:10px; padding:10px; margin-top:10px;">
          <div style="display:flex; align-items:center; justify-content:space-between;">
            <strong style="font-size:0.85rem;">Filtros de busca</strong>
            <button type="button" id="guessFacetsBtn" class="btn-secondary" style="padding:4px 10px; font-size:0.8rem;">🎲 Sugerir automaticamente</button>
          </div>
          <p class="hint" style="margin:4px 0 8px;">Chute a partir dos ingredientes/modo de preparo — revise antes de salvar.</p>

          <div style="display:flex; gap:8px;">
            <div style="flex:1;">
              <label>Proteína principal</label>
              <select name="protein">
                <option value="">—</option>
                ${PROTEINS.map((p) => `<option value="${p}" ${existing?.protein === p ? 'selected' : ''}>${p}</option>`).join('')}
              </select>
            </div>
            <div style="flex:1;">
              <label>Culinária / país</label>
              <select name="cuisine">
                <option value="">—</option>
                ${CUISINES.map((c) => `<option value="${c}" ${existing?.cuisine === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </div>
          </div>

          <label>Utensílios necessários</label>
          <div class="day-checks">
            ${EQUIPMENT_OPTIONS.map((eq) => `
              <label><input type="checkbox" name="equipment" value="${eq}" ${(existing?.equipment || []).includes(eq) ? 'checked' : ''}> ${eq}</label>
            `).join('')}
          </div>
        </div>

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

      // Lê os campos atuais do formulário (não só do "existing"), pra sugerir
      // com base no que está na tela agora — útil logo após importar um link
      // ou depois de o usuário mexer nos ingredientes manualmente.
      function readFormForGuess() {
        const rows = [...wrap.querySelectorAll('.ingredient-row')];
        return {
          title: modalEl.querySelector('[name="title"]').value,
          instructions: modalEl.querySelector('[name="instructions"]').value,
          ingredients: rows.map((row) => ({ name: row.querySelector('.ing-name').value }))
        };
      }

      function applyGuess(onlyIfEmpty) {
        const guess = guessFacets(readFormForGuess());
        const proteinSel = modalEl.querySelector('[name="protein"]');
        const cuisineSel = modalEl.querySelector('[name="cuisine"]');
        if (guess.protein && (!onlyIfEmpty || !proteinSel.value)) proteinSel.value = guess.protein;
        if (guess.cuisine && (!onlyIfEmpty || !cuisineSel.value)) cuisineSel.value = guess.cuisine;
        if (guess.equipment.length) {
          modalEl.querySelectorAll('[name="equipment"]').forEach((cb) => {
            if (guess.equipment.includes(cb.value) && (!onlyIfEmpty || !cb.checked)) cb.checked = true;
          });
        }
      }

      modalEl.querySelector('#guessFacetsBtn').addEventListener('click', () => applyGuess(false));

      const importBtn = modalEl.querySelector('#importBtn');
      if (importBtn) {
        const urlInput = modalEl.querySelector('#importUrlInput');
        const status = modalEl.querySelector('#importStatus');

        async function runImport(url) {
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
            applyGuess(true);
            status.textContent = 'Importado — revise os campos (inclusive os filtros de busca sugeridos) antes de salvar. A extração automática pode não ser 100% exata.';
          } catch (e) {
            console.error(e);
            status.textContent = 'Erro ao importar. Cadastre manualmente.';
          } finally {
            importBtn.disabled = false;
          }
        }

        importBtn.addEventListener('click', () => runImport(urlInput.value.trim()));

        // Veio de um "compartilhar" no celular (Web Share Target) com o link
        // já preenchido — importa sozinho, sem precisar tocar em "Importar".
        if (prefillImportUrl) runImport(prefillImportUrl);
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

        const equipment = [...modalEl.querySelectorAll('[name="equipment"]:checked')].map((cb) => cb.value);

        const data = {
          title: fd.get('title').trim(),
          url: fd.get('url').trim(),
          prepTime: fd.get('prepTime').trim(),
          yieldInfo: fd.get('yieldInfo').trim(),
          difficulty: fd.get('difficulty'),
          instructions: fd.get('instructions').trim(),
          protein: fd.get('protein') || '',
          cuisine: fd.get('cuisine') || '',
          equipment,
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

const TIME_FILTER_OPTIONS = [
  ['', 'Qualquer tempo'],
  ['30', 'Até 30 min'],
  ['60', 'Até 1h'],
  ['120', 'Até 2h']
];

// Estado dos filtros da tela de Receitas (só em memória — não precisa
// persistir entre sessões, é só pra facilitar a busca no momento).
const filterState = { protein: '', cuisine: '', difficulty: '', maxMinutes: '', equipment: new Set() };

/** Extrai um número aproximado de minutos de um texto livre como "30 min" ou "1h30". */
function parseMinutes(str) {
  if (!str) return null;
  let total = 0;
  let found = false;
  const h = str.match(/(\d+)\s*h/i);
  const min = str.match(/(\d+)\s*m(?:in)?\b/i);
  if (h) { total += parseInt(h[1], 10) * 60; found = true; }
  if (min) { total += parseInt(min[1], 10); found = true; }
  if (!found) {
    const anyNum = str.match(/(\d+)/);
    if (anyNum) { total = parseInt(anyNum[1], 10); found = true; }
  }
  return found ? total : null;
}

function recipeMatchesFilters(r) {
  if (filterState.protein && r.protein !== filterState.protein) return false;
  if (filterState.cuisine && r.cuisine !== filterState.cuisine) return false;
  if (filterState.difficulty && r.difficulty !== filterState.difficulty) return false;
  if (filterState.maxMinutes) {
    const mins = parseMinutes(r.prepTime);
    if (mins !== null && mins > Number(filterState.maxMinutes)) return false;
  }
  if (filterState.equipment.size) {
    const needed = r.equipment || [];
    // A receita só passa se TODOS os utensílios que ela exige estiverem
    // marcados como "disponíveis" — ou seja, filtra fora o que você não tem.
    const missing = needed.some((eq) => !filterState.equipment.has(eq));
    if (missing) return false;
  }
  return true;
}

function renderFilterBar(container, onChange) {
  container.innerHTML = `
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <div style="flex:1; min-width:140px;">
        <label>Proteína</label>
        <select id="filterProtein">
          <option value="">Todas</option>
          ${PROTEINS.map((p) => `<option value="${p}">${p}</option>`).join('')}
        </select>
      </div>
      <div style="flex:1; min-width:140px;">
        <label>Culinária</label>
        <select id="filterCuisine">
          <option value="">Todas</option>
          ${CUISINES.map((c) => `<option value="${c}">${c}</option>`).join('')}
        </select>
      </div>
      <div style="flex:1; min-width:120px;">
        <label>Dificuldade</label>
        <select id="filterDifficulty">
          <option value="">Todas</option>
          <option value="facil">Fácil</option>
          <option value="media">Média</option>
          <option value="dificil">Difícil</option>
        </select>
      </div>
      <div style="flex:1; min-width:120px;">
        <label>Tempo</label>
        <select id="filterTime">
          ${TIME_FILTER_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </div>
    </div>
    <label style="margin-top:10px;">Utensílios que você tem disponíveis (deixe tudo desmarcado pra não filtrar por isso)</label>
    <div class="day-checks">
      ${EQUIPMENT_OPTIONS.map((eq) => `<label><input type="checkbox" class="filter-equipment" value="${eq}"> ${eq}</label>`).join('')}
    </div>
    <button type="button" id="clearFiltersBtn" class="btn-secondary" style="margin-top:10px;">Limpar filtros</button>
  `;

  const proteinSel = container.querySelector('#filterProtein');
  const cuisineSel = container.querySelector('#filterCuisine');
  const difficultySel = container.querySelector('#filterDifficulty');
  const timeSel = container.querySelector('#filterTime');

  proteinSel.addEventListener('change', () => { filterState.protein = proteinSel.value; onChange(); });
  cuisineSel.addEventListener('change', () => { filterState.cuisine = cuisineSel.value; onChange(); });
  difficultySel.addEventListener('change', () => { filterState.difficulty = difficultySel.value; onChange(); });
  timeSel.addEventListener('change', () => { filterState.maxMinutes = timeSel.value; onChange(); });

  container.querySelectorAll('.filter-equipment').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) filterState.equipment.add(cb.value);
      else filterState.equipment.delete(cb.value);
      onChange();
    });
  });

  container.querySelector('#clearFiltersBtn').addEventListener('click', () => {
    filterState.protein = '';
    filterState.cuisine = '';
    filterState.difficulty = '';
    filterState.maxMinutes = '';
    filterState.equipment.clear();
    proteinSel.value = '';
    cuisineSel.value = '';
    difficultySel.value = '';
    timeSel.value = '';
    container.querySelectorAll('.filter-equipment').forEach((cb) => { cb.checked = false; });
    onChange();
  });
}

function recipeCardHtml(r) {
  const metaParts = [];
  if (r.prepTime) metaParts.push(`⏱️ ${r.prepTime}`);
  if (r.yieldInfo) metaParts.push(`🍽️ ${r.yieldInfo}`);
  if (r.difficulty) metaParts.push(`📊 ${DIFFICULTY_LABELS[r.difficulty] || r.difficulty}`);

  const tags = [];
  if (r.protein) tags.push(r.protein);
  if (r.cuisine) tags.push(r.cuisine);
  (r.equipment || []).forEach((eq) => tags.push(eq));

  return `
    <div class="recipe-card" data-id="${r.id}">
      <h3>${r.title}</h3>
      ${metaParts.length ? `<div style="font-size:0.8rem; color:#776; margin-bottom:4px;">${metaParts.join(' · ')}</div>` : ''}
      ${tags.length ? `<div class="recipe-tags">${tags.map((t) => `<span class="recipe-tag">${t}</span>`).join('')}</div>` : ''}
      ${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">Ver receita original ↗</a>` : ''}
      <div class="ingredients">${(r.ingredients || []).map((i) => `${i.qty || ''} ${i.unit || ''} ${i.name}`).join(' · ')}</div>
    </div>
  `;
}

/** Renderiza a lista AGORA, com o estado atual dos filtros — não assina nada. */
function renderRecipeListNow(container) {
  const recipes = recipesStore.list;
  if (!recipes.length) {
    container.innerHTML = '<p class="hint">Nenhuma receita ainda. Toque em "+ Nova receita" para cadastrar.</p>';
    return;
  }
  const filtered = recipes.filter(recipeMatchesFilters);
  container.innerHTML = filtered.length
    ? filtered.map(recipeCardHtml).join('')
    : '<p class="hint">Nenhuma receita bate com esses filtros. Tente afrouxar algum critério.</p>';

  container.querySelectorAll('.recipe-card').forEach((card) => {
    card.addEventListener('click', () => {
      const recipe = recipesStore.getById(card.dataset.id);
      openRecipeForm(recipe);
    });
  });
}

export function initRecipes() {
  const listContainer = document.getElementById('recipeList');
  const filtersContainer = document.getElementById('recipeFilters');
  renderFilterBar(filtersContainer, () => renderRecipeListNow(listContainer));
  // Uma única assinatura pro ciclo de vida do app — reage a mudanças vindas
  // do Firestore (nova receita salva, importada, editada em outro aparelho).
  recipesStore.subscribe(() => renderRecipeListNow(listContainer));
  document.getElementById('addRecipeBtn').addEventListener('click', () => openRecipeForm(null));
}

/**
 * Abre "Nova receita" já com o link preenchido e a importação disparada
 * sozinha — usado quando o link chega por "compartilhar" de outro app
 * (Chrome, WhatsApp etc.), via Web Share Target (ver app.js).
 */
export function openSharedRecipeImport(url) {
  openRecipeForm(null, url);
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
