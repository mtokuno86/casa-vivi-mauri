// ============================================================================
// tasks.js — tarefas/pendências avulsas + rotina da casa com repetição
// automática (usa recurrence.js, o mesmo motor em celular e tablet).
// ============================================================================
import { createStore } from './store.js';
import { openModal } from './modal.js';
import { isDueOn, nextOccurrence, describeRecurrence, todayStr } from './recurrence.js';

export const tasksStore = createStore('tasks');

const DIAS = [
  { v: 1, l: 'Seg' }, { v: 2, l: 'Ter' }, { v: 3, l: 'Qua' }, { v: 4, l: 'Qui' },
  { v: 5, l: 'Sex' }, { v: 6, l: 'Sáb' }, { v: 0, l: 'Dom' }
];

function dayCheckboxesHtml(selected = []) {
  return DIAS.map((d) => `
    <label><input type="checkbox" class="dow-check" value="${d.v}" ${selected.includes(d.v) ? 'checked' : ''}> ${d.l}</label>
  `).join('');
}

function openTaskForm(existing) {
  const rec = existing?.recurrence || { freq: 'none' };

  openModal({
    title: existing ? 'Editar tarefa' : 'Nova tarefa',
    bodyHtml: `
      <form id="taskForm">
        <label>Título</label>
        <input type="text" name="title" required value="${existing?.title ? existing.title.replace(/"/g, '&quot;') : ''}">

        <label>Repetição</label>
        <select name="freq" id="freqSelect">
          <option value="none" ${rec.freq === 'none' ? 'selected' : ''}>Não repete (data única)</option>
          <option value="daily" ${rec.freq === 'daily' ? 'selected' : ''}>Todos os dias</option>
          <option value="weekly" ${rec.freq === 'weekly' ? 'selected' : ''}>Semanal / quinzenal / a cada N semanas</option>
          <option value="monthly" ${rec.freq === 'monthly' ? 'selected' : ''}>Mensal</option>
          <option value="custom" ${rec.freq === 'custom' ? 'selected' : ''}>A cada N dias</option>
        </select>

        <div id="fieldsNone" style="display:${rec.freq === 'none' ? 'block' : 'none'}">
          <label>Data</label>
          <input type="date" name="dueDate" value="${existing?.dueDate || todayStr()}">
        </div>

        <div id="fieldsStart" style="display:${rec.freq !== 'none' ? 'block' : 'none'}">
          <label>A partir de</label>
          <input type="date" name="startDate" value="${rec.startDate || todayStr()}">
        </div>

        <div id="fieldsWeekly" style="display:${rec.freq === 'weekly' ? 'block' : 'none'}">
          <label>Dias da semana</label>
          <div class="day-checks">${dayCheckboxesHtml(rec.daysOfWeek || [])}</div>
          <label>A cada quantas semanas</label>
          <input type="number" name="weekInterval" min="1" value="${rec.weekInterval || 1}">
          <div class="hint">1 = toda semana, 2 = quinzenal, 3 = a cada 3 semanas...</div>
        </div>

        <div id="fieldsMonthly" style="display:${rec.freq === 'monthly' ? 'block' : 'none'}">
          <label>Dia do mês</label>
          <input type="number" name="dayOfMonth" min="1" max="31" value="${rec.dayOfMonth || 1}">
        </div>

        <div id="fieldsCustom" style="display:${rec.freq === 'custom' ? 'block' : 'none'}">
          <label>A cada quantos dias</label>
          <input type="number" name="everyNDays" min="1" value="${rec.everyNDays || 2}">
        </div>

        <div class="modal-actions">
          ${existing ? '<button type="button" id="deleteTaskBtn" class="btn-secondary" style="color:#b3492f;">Excluir</button>' : ''}
          <button type="button" id="cancelTaskBtn" class="btn-secondary">Cancelar</button>
          <button type="submit" class="btn-primary">Salvar</button>
        </div>
      </form>
    `,
    onMount: (modalEl, close) => {
      const freqSelect = modalEl.querySelector('#freqSelect');
      const groups = {
        none: modalEl.querySelector('#fieldsNone'),
        start: modalEl.querySelector('#fieldsStart'),
        weekly: modalEl.querySelector('#fieldsWeekly'),
        monthly: modalEl.querySelector('#fieldsMonthly'),
        custom: modalEl.querySelector('#fieldsCustom')
      };

      function syncFields() {
        const f = freqSelect.value;
        groups.none.style.display = f === 'none' ? 'block' : 'none';
        groups.start.style.display = f !== 'none' ? 'block' : 'none';
        groups.weekly.style.display = f === 'weekly' ? 'block' : 'none';
        groups.monthly.style.display = f === 'monthly' ? 'block' : 'none';
        groups.custom.style.display = f === 'custom' ? 'block' : 'none';
      }
      freqSelect.addEventListener('change', syncFields);

      modalEl.querySelector('#cancelTaskBtn').addEventListener('click', close);

      const delBtn = modalEl.querySelector('#deleteTaskBtn');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (window.confirm('Excluir esta tarefa?')) {
            await tasksStore.remove(existing.id);
            close();
          }
        });
      }

      modalEl.querySelector('#taskForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const freq = fd.get('freq');
        const title = fd.get('title').trim();

        let data = { title, completedDates: existing?.completedDates || [] };

        if (freq === 'none') {
          data.dueDate = fd.get('dueDate');
          data.recurrence = { freq: 'none' };
        } else {
          const startDate = fd.get('startDate');
          const recurrence = { freq, startDate };
          if (freq === 'weekly') {
            recurrence.daysOfWeek = [...modalEl.querySelectorAll('.dow-check:checked')].map((c) => Number(c.value));
            recurrence.weekInterval = Math.max(1, Number(fd.get('weekInterval')) || 1);
            if (!recurrence.daysOfWeek.length) {
              alert('Selecione ao menos um dia da semana.');
              return;
            }
          } else if (freq === 'monthly') {
            recurrence.dayOfMonth = Math.min(31, Math.max(1, Number(fd.get('dayOfMonth')) || 1));
          } else if (freq === 'custom') {
            recurrence.everyNDays = Math.max(1, Number(fd.get('everyNDays')) || 1);
          }
          data.recurrence = recurrence;
          data.dueDate = null;
        }

        if (existing) {
          await tasksStore.set(existing.id, data);
        } else {
          await tasksStore.add(data);
        }
        close();
      });
    }
  });
}

function isCompletedForOccurrence(task, dateStr) {
  return (task.completedDates || []).includes(dateStr);
}

async function toggleOccurrence(task, dateStr, checked) {
  const set = new Set(task.completedDates || []);
  if (checked) set.add(dateStr); else set.delete(dateStr);
  await tasksStore.set(task.id, { completedDates: [...set] });
}

function render() {
  const container = document.getElementById('taskList');
  if (!container) return;
  const today = todayStr();
  const tasks = [...tasksStore.list].sort((a, b) => {
    const na = nextOccurrence(a, today) || '9999-99-99';
    const nb = nextOccurrence(b, today) || '9999-99-99';
    return na.localeCompare(nb);
  });

  if (!tasks.length) {
    container.innerHTML = '<p class="hint">Nenhuma tarefa cadastrada.</p>';
    return;
  }

  container.innerHTML = tasks.map((task) => {
    const occ = nextOccurrence(task, today) || task.dueDate;
    const done = occ ? isCompletedForOccurrence(task, occ) : false;
    const label = describeRecurrence(task.recurrence);
    const dateLabel = occ ? occ.split('-').reverse().join('/') : '';
    return `
      <div class="task-row ${done ? 'done' : ''}" data-id="${task.id}" data-occ="${occ || ''}">
        <input type="checkbox" class="task-check" ${done ? 'checked' : ''}>
        <div class="task-info">
          <div>${task.title}</div>
          <div class="task-recur">${label}${dateLabel ? ' · próxima: ' + dateLabel : ''}</div>
        </div>
        <button type="button" class="btn-secondary edit-task">✎</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.task-row').forEach((row) => {
    const task = tasksStore.getById(row.dataset.id);
    row.querySelector('.task-check').addEventListener('change', (e) => {
      toggleOccurrence(task, row.dataset.occ, e.target.checked);
    });
    row.querySelector('.edit-task').addEventListener('click', () => openTaskForm(task));
  });
}

export function initTasks() {
  tasksStore.subscribe(render);
  document.getElementById('addTaskBtn').addEventListener('click', () => openTaskForm(null));
}

/** Tarefas com ocorrência hoje, não concluídas — usado no dashboard. */
export function getTodayTasks() {
  const today = todayStr();
  return tasksStore.list
    .filter((t) => isDueOn(t, today))
    .map((t) => ({ task: t, done: isCompletedForOccurrence(t, today) }));
}

export function toggleTodayTask(taskId, checked) {
  const task = tasksStore.getById(taskId);
  if (task) toggleOccurrence(task, todayStr(), checked);
}
