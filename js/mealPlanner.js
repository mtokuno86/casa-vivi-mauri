// ============================================================================
// mealPlanner.js — cardápio semanal (almoço/janta x 7 dias).
//
// Corrige o bug do Cozi: trocar duas refeições já preenchidas é uma TROCA
// (swap) direta, sem precisar apagar uma antes de preencher a outra.
// ============================================================================
import { createStore } from './store.js';
import { recipesStore, openRecipePicker } from './recipes.js';
import { openModal } from './modal.js';
import { formatDateStr, addDaysStr } from './recurrence.js';

export const mealPlanStore = createStore('mealPlan');

const DIAS_SEMANA = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

let currentWeekStart = mondayOf(new Date());
let selectedForSwap = null; // { date, meal }

function mondayOf(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return formatDateStr(d);
}

function weekDates(weekStartStr) {
  return Array.from({ length: 7 }, (_, i) => addDaysStr(weekStartStr, i));
}

function formatWeekLabel(weekStartStr) {
  const dates = weekDates(weekStartStr);
  const first = dates[0], last = dates[6];
  const [, m1, d1] = first.split('-');
  const [, m2, d2] = last.split('-');
  return `${d1} ${MESES[+m1 - 1]} – ${d2} ${MESES[+m2 - 1]}`;
}

export function getRecipeIdsForWeek(weekStartStr) {
  const ids = new Set();
  weekDates(weekStartStr).forEach((date) => {
    const doc = mealPlanStore.getById(date);
    if (doc?.almoco) ids.add(doc.almoco);
    if (doc?.janta) ids.add(doc.janta);
  });
  return [...ids];
}

function slotCellHtml(date, meal, recipe) {
  const isSwapSelected = selectedForSwap && selectedForSwap.date === date && selectedForSwap.meal === meal;
  const cls = ['meal-cell'];
  if (!recipe) cls.push('empty');
  if (isSwapSelected) cls.push('selected-for-swap');
  return `
    <div class="${cls.join(' ')}" data-date="${date}" data-meal="${meal}">
      ${recipe ? `<div class="recipe-title">${recipe.title}</div>` : '<div>+ adicionar</div>'}
    </div>
  `;
}

async function performSwap(a, b) {
  const docA = mealPlanStore.getById(a.date) || {};
  const docB = mealPlanStore.getById(b.date) || {};
  const valA = docA[a.meal] || null;
  const valB = docB[b.meal] || null;

  if (a.date === b.date) {
    await mealPlanStore.set(a.date, { [a.meal]: valB, [b.meal]: valA });
  } else {
    await mealPlanStore.set(a.date, { [a.meal]: valB });
    await mealPlanStore.set(b.date, { [b.meal]: valA });
  }
}

function openCellActions(date, meal) {
  const doc = mealPlanStore.getById(date) || {};
  const recipeId = doc[meal];
  const recipe = recipeId ? recipesStore.getById(recipeId) : null;

  openModal({
    title: `${meal === 'almoco' ? 'Almoço' : 'Janta'} — ${date.split('-').reverse().join('/')}`,
    bodyHtml: `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <button type="button" class="btn-primary" id="pickBtn">${recipe ? 'Trocar receita' : 'Escolher receita'}</button>
        ${recipe ? '<button type="button" class="btn-secondary" id="swapBtn">🔄 Trocar de lugar com outra refeição</button>' : ''}
        ${recipe ? '<button type="button" class="btn-secondary" id="clearBtn" style="color:#b3492f;">Remover</button>' : ''}
        <button type="button" class="btn-secondary" id="closeBtn">Fechar</button>
      </div>
    `,
    onMount: (modalEl, close) => {
      modalEl.querySelector('#pickBtn').addEventListener('click', () => {
        close();
        openRecipePicker(async (pickedId) => {
          await mealPlanStore.set(date, { [meal]: pickedId });
        });
      });
      const swapBtn = modalEl.querySelector('#swapBtn');
      if (swapBtn) {
        swapBtn.addEventListener('click', () => {
          selectedForSwap = { date, meal };
          close();
          renderGrid();
        });
      }
      const clearBtn = modalEl.querySelector('#clearBtn');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          await mealPlanStore.set(date, { [meal]: null });
          close();
        });
      }
      modalEl.querySelector('#closeBtn').addEventListener('click', close);
    }
  });
}

function renderGrid() {
  const grid = document.getElementById('mealGrid');
  if (!grid) return;
  const dates = weekDates(currentWeekStart);

  let html = '<div class="head"></div>';
  dates.forEach((date, i) => {
    const [, m, d] = date.split('-');
    html += `<div class="head">${DIAS_SEMANA[i]}<br>${d}/${m}</div>`;
  });

  html += '<div class="head" style="text-align:left;">Almoço</div>';
  dates.forEach((date) => {
    const doc = mealPlanStore.getById(date) || {};
    const recipe = doc.almoco ? recipesStore.getById(doc.almoco) : null;
    html += slotCellHtml(date, 'almoco', recipe);
  });

  html += '<div class="head" style="text-align:left;">Janta</div>';
  dates.forEach((date) => {
    const doc = mealPlanStore.getById(date) || {};
    const recipe = doc.janta ? recipesStore.getById(doc.janta) : null;
    html += slotCellHtml(date, 'janta', recipe);
  });

  grid.innerHTML = html;
  document.getElementById('weekLabel').textContent = formatWeekLabel(currentWeekStart);

  grid.querySelectorAll('.meal-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const date = cell.dataset.date;
      const meal = cell.dataset.meal;

      if (selectedForSwap) {
        if (selectedForSwap.date === date && selectedForSwap.meal === meal) {
          selectedForSwap = null;
          renderGrid();
          return;
        }
        performSwap(selectedForSwap, { date, meal });
        selectedForSwap = null;
        return; // renderGrid vai disparar via subscribe do store após o swap
      }

      openCellActions(date, meal);
    });
  });
}

export function initMealPlanner() {
  mealPlanStore.subscribe(() => renderGrid());
  recipesStore.subscribe(() => renderGrid());

  document.getElementById('prevWeekBtn').addEventListener('click', () => {
    currentWeekStart = addDaysStr(currentWeekStart, -7);
    renderGrid();
  });
  document.getElementById('nextWeekBtn').addEventListener('click', () => {
    currentWeekStart = addDaysStr(currentWeekStart, 7);
    renderGrid();
  });

  renderGrid();
}

export function getCurrentWeekStart() {
  return currentWeekStart;
}
