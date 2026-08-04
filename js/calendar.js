// ============================================================================
// calendar.js — compromissos (aniversários, festas, passeios). Integra com o
// Google Calendar quando conectado; enquanto isso, usa uma agenda local (só
// neste aparelho) para dar pra testar antes de configurar o Google.
// ============================================================================
import { createStore } from './store.js';
import { onAuthChange, isSignedIn, isConfigured } from './auth.js';
import { openModal } from './modal.js';
import { todayStr } from './recurrence.js';
import { googleCalendarIds } from './config.js';

const localEventsStore = createStore('localEvents'); // { title, date, time, allDay }

let connected = false;
let googleEventsCache = [];

const CALENDAR_IDS = (googleCalendarIds && googleCalendarIds.length) ? googleCalendarIds : ['primary'];

onAuthChange((signedIn) => {
  connected = signedIn;
  refreshFromGoogle();
});

async function refreshFromGoogle() {
  if (!connected || !window.gapi?.client?.calendar) {
    render();
    return;
  }
  try {
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 60).toISOString();

    // Busca em paralelo em todos os calendários configurados (o próprio +
    // quaisquer outros que tenham sido compartilhados com essa conta).
    const results = await Promise.all(
      CALENDAR_IDS.map((calId) =>
        window.gapi.client.calendar.events.list({
          calendarId: calId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 100
        }).then((resp) => ({ calId, items: resp.result.items || [] }))
          .catch((e) => {
            console.warn(`Não foi possível ler o calendário "${calId}" (verifique se foi compartilhado com essa conta):`, e);
            return { calId, items: [] };
          })
      )
    );

    googleEventsCache = results.flatMap(({ calId, items }) =>
      items.map((ev) => ({
        id: `${calId}:${ev.id}`,
        calendarId: calId,
        title: ev.summary || '(sem título)',
        date: (ev.start.date || ev.start.dateTime || '').slice(0, 10),
        time: ev.start.dateTime ? ev.start.dateTime.slice(11, 16) : null,
        allDay: !!ev.start.date,
        source: 'google'
      }))
    );
  } catch (e) {
    console.error('Erro ao ler Google Calendar:', e);
  }
  render();
}

function getAllEvents() {
  if (connected) return googleEventsCache;
  return localEventsStore.list.map((e) => ({ ...e, source: 'local' }));
}

export function getTodayEvents() {
  const today = todayStr();
  return getAllEvents().filter((e) => e.date === today);
}

async function addEvent({ title, date, time, calendarId }) {
  if (connected && window.gapi?.client?.calendar) {
    const event = time
      ? { summary: title, start: { dateTime: `${date}T${time}:00` }, end: { dateTime: `${date}T${time}:00` } }
      : { summary: title, start: { date }, end: { date } };
    await window.gapi.client.calendar.events.insert({ calendarId: calendarId || 'primary', resource: event });
    await refreshFromGoogle();
  } else {
    await localEventsStore.add({ title, date, time: time || null, allDay: !time });
    render();
  }
}

function openEventForm() {
  const showCalendarPicker = connected && CALENDAR_IDS.length > 1;
  openModal({
    title: 'Novo compromisso',
    bodyHtml: `
      <form id="eventForm">
        <label>Título</label>
        <input type="text" name="title" required placeholder="Ex: Aniversário da Vivi">
        <label>Data</label>
        <input type="date" name="date" required value="${todayStr()}">
        <label>Horário (opcional)</label>
        <input type="time" name="time">
        ${showCalendarPicker ? `
          <label>Adicionar no calendário de</label>
          <select name="calendarId">
            ${CALENDAR_IDS.map((id) => `<option value="${id}">${id === 'primary' ? 'Meu calendário' : id}</option>`).join('')}
          </select>
        ` : ''}
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="cancelEventBtn">Cancelar</button>
          <button type="submit" class="btn-primary">Salvar</button>
        </div>
      </form>
    `,
    onMount: (modalEl, close) => {
      modalEl.querySelector('#cancelEventBtn').addEventListener('click', close);
      modalEl.querySelector('#eventForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        await addEvent({
          title: fd.get('title').trim(),
          date: fd.get('date'),
          time: fd.get('time') || null,
          calendarId: fd.get('calendarId') || 'primary'
        });
        close();
      });
    }
  });
}

function render() {
  const list = document.getElementById('eventList');
  const hint = document.getElementById('calendarHint');
  if (hint) {
    if (!isConfigured()) {
      hint.textContent = 'Google não configurado ainda — usando agenda local neste aparelho (veja SETUP.md para conectar o Google Calendar).';
    } else if (connected) {
      hint.textContent = 'Sincronizado com o Google Calendar. ✓';
    } else {
      hint.textContent = 'Conecte sua conta Google (botão no topo) para sincronizar com o Google Calendar.';
    }
  }
  if (!list) return;
  const events = getAllEvents().sort((a, b) => a.date.localeCompare(b.date));
  if (!events.length) {
    list.innerHTML = '<li class="hint">Nenhum compromisso cadastrado.</li>';
    return;
  }
  list.innerHTML = events.map((e) => `
    <li>
      <strong>${e.date.split('-').reverse().join('/')}</strong>
      ${e.time ? e.time : ''}
      — ${e.title}
      ${e.calendarId && e.calendarId !== 'primary' ? `<span style="margin-left:auto; font-size:0.75rem; color:#999;">${e.calendarId}</span>` : ''}
    </li>
  `).join('');
}

export function initCalendar() {
  localEventsStore.subscribe(() => { if (!connected) render(); });
  document.getElementById('addEventBtn').addEventListener('click', openEventForm);
  render();
}
