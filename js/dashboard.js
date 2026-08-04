// ============================================================================
// dashboard.js — tela inicial: cardápio de hoje, tarefas de hoje,
// compromissos de hoje e a galeria de fotos (photos.js cuida da galeria).
// ============================================================================
import { mealPlanStore } from './mealPlanner.js';
import { recipesStore } from './recipes.js';
import { getTodayTasks, toggleTodayTask, tasksStore } from './tasks.js';
import { getTodayEvents } from './calendar.js';
import { todayStr } from './recurrence.js';
import { getMemberName, membersStore } from './members.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

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

export function initDashboard() {
  renderDateHeader();
  mealPlanStore.subscribe(renderTodayMeals);
  recipesStore.subscribe(renderTodayMeals);
  tasksStore.subscribe(renderTodayTasks);
  membersStore.subscribe(renderTodayTasks);
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
}
