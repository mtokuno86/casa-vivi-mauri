// ============================================================================
// calendar.js — compromissos (aniversários, festas, passeios). Integra com o
// Google Calendar quando conectado; enquanto isso, usa uma agenda local (só
// neste aparelho) para dar pra testar antes de configurar o Google.
// ============================================================================
import { createStore } from './store.js';
import { onAuthChange, isSignedIn, isConfigured } from './auth.js';
import { openModal } from './modal.js';
import { todayStr } from './recurrence.js';

const localEventsStore = createStore('localEvents'); // { title, date, time, allDay }

let connected = false;
let googleEventsCache = [];

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
    const resp = await window.gapi.client.calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });
    googleEventsCache = (resp.result.items || []).map((ev) => ({
      id: ev.id,
      title: ev.summary || '(sem título)',
      date: (ev.start.date || ev.start.dateTime || '').slice(0, 10),
      time: ev.start.dateTime ? ev.start.dateTime.slice(11, 16) : null,
      allDay: !!ev.start.date,
      source: 'google'
    }));
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

async function addEvent({ title, date, time }) {
  if (connected && window.gapi?.client?.calendar) {
    const event = time
      ? { summary: title, start: { dateTime: `${date}T${time}:00` }, end: { dateTime: `${date}T${time}:00` } }
      : { summary: title, start: { date }, end: { date } };
    await window.gapi.client.calendar.events.insert({ calendarId: 'primary', resource: event });
    await refreshFromGoogle();
  } else {
    await localEventsStore.add({ title, date, time: time || null, allDay: !time });
    render();
  }
}

function openEventForm() {
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
        await addEvent({ title: fd.get('title').trim(), date: fd.get('date'), time: fd.get('time') || null });
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
    </li>
  `).join('');
}

export function initCalendar() {
  localEventsStore.subscribe(() => { if (!connected) render(); });
  document.getElementById('addEventBtn').addEventListener('click', openEventForm);
  render();
}
