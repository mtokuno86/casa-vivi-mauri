// ============================================================================
// dashboard.js — tela inicial: cardápio de hoje, tarefas de hoje,
// compromissos de hoje e a galeria de fotos (photos.js cuida da galeria).
// ============================================================================
import { mealPlanStore } from './mealPlanner.js';
import { recipesStore } from './recipes.js';
import { getTodayTasks, toggleTodayTask, tasksStore } from './tasks.js';
import { getTodayEvents, getEventsInRange, onEventsChange } from './calendar.js';
import { todayStr, addDaysStr } from './recurrence.js';
import { getMemberName, membersStore } from './members.js';
import { pantryStockStore, houseStockStore, getLowStockItems } from './stock.js';
import { getMenuShoppingItems, shoppingChecksStore } from './shoppingList.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const DIAS_ABREV = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function renderDateHeader() {
  const el = document.getElementById('todayDate');
  if (!el) return;
  const d = new Date();
  el.textContent = `${DIAS[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

function renderTodayMeals() {
  const el = document.getElementById('todayMeals');
  if (!el) return;
  const today = todayStr();
  const doc = mealPlanStore.getById(today) || {};
  const almoco = doc.almoco ? recipesStore.getById(doc.almoco) : null;
  const janta = doc.janta ? recipesStore.getById(doc.janta) : null;
  el.innerHTML = `
    <div class="meal-pill"><strong>Almoço:</strong> ${almoco ? almoco.title : '—'}</div>
    <div class="meal-pill"><strong>Janta:</strong> ${janta ? janta.title : '—'}</div>
  `;
}

function renderTodayTasks() {
  const el = document.getElementById('todayTasks');
  if (!el) return;
  const items = getTodayTasks();
  if (!items.length) {
    el.innerHTML = '<li class="hint">Nada pendente hoje 🎉</li>';
    return;
  }
  el.innerHTML = items.map(({ task, done }) => {
    const assigneeName = getMemberName(task.assignee);
    return `
    <li>
      <input type="checkbox" class="today-task-check" data-id="${task.id}" ${done ? 'checked' : ''}>
      <span style="${done ? 'text-decoration:line-through; opacity:0.5;' : ''}">${task.title}${assigneeName ? ' <span style="color:#999; font-size:0.8rem;">· ' + assigneeName + '</span>' : ''}</span>
    </li>
  `;
  }).join('');
  el.querySelectorAll('.today-task-check').forEach((cb) => {
    cb.addEventListener('change', (e) => toggleTodayTask(cb.dataset.id, e.target.checked));
  });
}

function renderTodayEvents() {
  const el = document.getElementById('todayEvents');
  if (!el) return;
  const events = getTodayEvents();
  el.innerHTML = events.length
    ? events.map((e) => `<li>${e.time ? e.time + ' — ' : ''}${e.title}</li>`).join('')
    : '<li class="hint">Nenhum compromisso hoje.</li>';
}

// Segunda-feira da semana atual — assim o grid sempre começa alinhado com a
// coluna "seg" e termina num domingo, agrupando visualmente os fins de semana.
function mondayOfCurrentWeek() {
  const today = todayStr();
  const dow = new Date(today + 'T12:00:00').getDay(); // 0=domingo .. 6=sábado
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  return addDaysStr(today, diffToMonday);
}

// 4 semanas fechadas (28 dias, seg→dom) em vez de "30 dias corridos" — fica
// um grid retangular e sempre termina num fim de semana completo.
const CAL_WEEKS = 4;

function renderCalendarMonth() {
  const el = document.getElementById('calMiniGrid');
  if (!el) return;
  const today = todayStr();
  const start = mondayOfCurrentWeek();
  const totalDays = CAL_WEEKS * 7;
  const rangeEnd = addDaysStr(start, totalDays - 1);
  const events = getEventsInRange(start, rangeEnd);
  const eventsByDate = new Map();
  events.forEach((e) => {
    if (!eventsByDate.has(e.date)) eventsByDate.set(e.date, []);
    eventsByDate.get(e.date).push(e);
  });

  const MAX_VISIBLE = 3;
  let html = '';
  for (let i = 0; i < totalDays; i++) {
    const date = addDaysStr(start, i);
    const d = new Date(date + 'T12:00:00');
    const dayEvents = eventsByDate.get(date) || [];
    const shown = dayEvents.slice(0, MAX_VISIBLE);
    const extra = dayEvents.length - shown.length;
    const cls = ['cal-mini-cell'];
    if (i < 7) cls.push('this-week');
    if (date === today) cls.push('today');
    if (d.getDay() === 0 || d.getDay() === 6) cls.push('weekend');
    html += `
      <div class="${cls.join(' ')}">
        <div class="cal-mini-day">${DIAS_ABREV[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}</div>
        ${shown.map((e) => `<div class="cal-mini-event" title="${e.title}">${e.time ? e.time + ' ' : ''}${e.title}</div>`).join('')}
        ${extra > 0 ? `<div class="cal-mini-more">+${extra} mais</div>` : ''}
      </div>
    `;
  }
  el.innerHTML = html;
}

function renderMenuShopping() {
  const el = document.getElementById('menuShoppingItems');
  if (!el) return;
  const items = getMenuShoppingItems();
  el.innerHTML = items.length
    ? items.map((item) => `
      <li style="${item.checked ? 'text-decoration:line-through; opacity:0.5;' : ''}">
        ${item.qtyLabel ? item.qtyLabel + ' ' : ''}${item.unit ? item.unit + ' ' : ''}${item.name}
      </li>
    `).join('')
    : '<li class="hint">Cardápio da semana vazio.</li>';
}

function renderLowStock() {
  const card = document.getElementById('lowStockCard');
  const el = document.getElementById('lowStockItems');
  if (!card || !el) return;
  const missing = [
    ...getLowStockItems(pantryStockStore).map((item) => ({ ...item, kind: 'Ingrediente' })),
    ...getLowStockItems(houseStockStore).map((item) => ({ ...item, kind: 'Item da casa' }))
  ];
  if (!missing.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  el.innerHTML = missing.map((item) => `
    <li>
      <span>${item.name} <span style="color:#999; font-size:0.8rem;">· ${item.kind}${item.qty !== undefined ? ' · ' + item.qty + (item.unit ? ' ' + item.unit : '') + ' (mín. ' + item.minQty + ')' : ''}</span></span>
    </li>
  `).join('');
}

export function initDashboard() {
  renderDateHeader();
  mealPlanStore.subscribe(() => { renderTodayMeals(); renderMenuShopping(); });
  recipesStore.subscribe(() => { renderTodayMeals(); renderMenuShopping(); });
  tasksStore.subscribe(renderTodayTasks);
  membersStore.subscribe(renderTodayTasks);
  pantryStockStore.subscribe(renderLowStock);
  houseStockStore.subscribe(renderLowStock);
  shoppingChecksStore.subscribe(renderMenuShopping);
  onEventsChange(renderCalendarMonth);
  refreshDashboard();
  // Tablet fica fixo na geladeira o dia todo — atualiza sozinho de tempos em tempos
  // (troca de dia à meia-noite, novos eventos do Google Calendar, etc.).
  setInterval(refreshDashboard, 60000);
}

export function refreshDashboard() {
  renderDateHeader();
  renderTodayMeals();
  renderTodayTasks();
  renderTodayEvents();
  renderCalendarMonth();
  renderMenuShopping();
  renderLowStock();
}
