// ============================================================================
// calendar.js — compromissos (aniversários, festas, passeios). Integra com o
// Google Calendar quando conectado; enquanto isso, usa uma agenda local (só
// neste aparelho) para dar pra testar antes de configurar o Google.
//
// Tela de Calendário com 3 visões (Dia / Semana / Mês), como um app de
// calendário de verdade:
//  - Mês: visão geral, com até 3 compromissos por dia + "+N mais" clicável
//    (abre um modal com a lista completa daquele dia).
//  - Semana: 7 colunas com TODOS os compromissos de cada dia (sem corte) —
//    boa pro curto prazo, pra ver a semana inteira em detalhe.
//  - Dia: lista cheia de um único dia, o mais detalhado.
// ============================================================================
import { createStore } from './store.js';
import { onAuthChange, isSignedIn, isConfigured, forceRefresh } from './auth.js';
import { openModal } from './modal.js';
import { todayStr, addDaysStr, parseDateStr, formatDateStr } from './recurrence.js';
import { googleCalendarIds } from './config.js';

const localEventsStore = createStore('localEvents'); // { title, date, time, allDay }

let connected = false;
let googleEventsCache = [];
const eventsChangeListeners = new Set();

const CALENDAR_IDS = (googleCalendarIds && googleCalendarIds.length) ? googleCalendarIds : ['primary'];

// Calendários públicos (ex: feriados) são só para leitura — não faz sentido
// oferecê-los como destino ao criar um novo compromisso (a gente não tem
// permissão de escrever neles, a chamada de insert falharia).
const isReadOnlyCalendar = (id) => id.includes('#holiday@');
const WRITABLE_CALENDAR_IDS = CALENDAR_IDS.filter((id) => !isReadOnlyCalendar(id));

// Nomes amigáveis para os IDs de calendário mais comuns, já que o ID bruto
// de um calendário público (ex: "en.brazilian.official#holiday@...") não é
// legível na tela.
function calendarLabel(id) {
  if (!id || id === 'primary') return 'Meu calendário';
  if (id.includes('brazilian') && id.includes('#holiday@')) return '🇧🇷 Feriados nacionais';
  if (id.includes('#holiday@')) return '📅 Feriados';
  return id;
}

// ----------------------------------------------------------------------------
// Estado da visão (Dia/Semana/Mês) + data de referência ("âncora"). O modo
// fica lembrado entre aberturas do app (localStorage); a data âncora sempre
// volta para "hoje" quando o app recarrega — é o esperado num tablet fixo.
// ----------------------------------------------------------------------------
const VIEW_MODE_KEY = 'casa-vm:calendarView';
let viewMode = ['day', 'week', 'month'].includes(localStorage.getItem(VIEW_MODE_KEY))
  ? localStorage.getItem(VIEW_MODE_KEY)
  : 'month';
let anchorDateStr = todayStr();

function persistViewMode() {
  try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch (e) { /* ignora */ }
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const DIAS_ABREV = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// ----------------------------------------------------------------------------
// Helpers de data (sobre strings 'YYYY-MM-DD', reaproveitando parseDateStr/
// formatDateStr do recurrence.js, que já evitam bug de fuso horário/DST).
// ----------------------------------------------------------------------------
function mondayOfWeekStr(dateStr) {
  const d = parseDateStr(dateStr);
  const dow = d.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return formatDateStr(d);
}

function firstOfMonthStr(dateStr) {
  const d = parseDateStr(dateStr);
  return formatDateStr(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12)));
}

function lastOfMonthStr(dateStr) {
  const d = parseDateStr(dateStr);
  return formatDateStr(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)));
}

function addMonthsStr(dateStr, n) {
  const d = parseDateStr(dateStr);
  const day = d.getUTCDate();
  const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
  const lastDay = new Date(Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0, 12)).getUTCDate();
  candidate.setUTCDate(Math.min(day, lastDay));
  return formatDateStr(candidate);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function groupByDate(events) {
  const map = new Map();
  events.forEach((e) => {
    if (!map.has(e.date)) map.set(e.date, []);
    map.get(e.date).push(e);
  });
  return map;
}

function sortByTime(a, b) {
  return (a.time || '').localeCompare(b.time || '');
}

/** Meia-noite/fim-do-dia LOCAL (fuso do aparelho) de uma data 'YYYY-MM-DD', em ISO — é o que a API do Google Calendar espera em timeMin/timeMax. */
function localDayBoundaryISO(dateStr, endOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
  return dt.toISOString();
}

// ----------------------------------------------------------------------------
// Busca no Google Calendar por um intervalo de datas específico — usado tanto
// pela recarga "padrão" (ao conectar) quanto pela recarga sob demanda quando
// a pessoa navega (Semana/Mês/Dia) para fora do intervalo já carregado.
//
// Precisa vir ANTES do onAuthChange(...) logo abaixo: onAuthChange chama o
// callback imediatamente, de forma síncrona, no momento do registro — e se
// isso acontecer durante a própria avaliação deste módulo (o caso normal,
// já que auth.js e calendar.js são carregados juntos), um `let` declarado
// só depois ainda estaria na "zona morta" e um "refreshFromGoogle()"
// disparado nesse instante bateria em "Cannot access 'loadedRange' before
// initialization". Foi exatamente esse erro visto no console — inofensivo
// na prática (o valor final é o mesmo, null), mas evitável só invertendo a
// ordem das declarações.
// ----------------------------------------------------------------------------
let loadedRange = null; // { start, end } — só é significativo quando connected

onAuthChange((signedIn) => {
  connected = signedIn;
  refreshFromGoogle();
});

async function fetchGoogleEventsRange(fetchStartStr, fetchEndStr, isRetryAfterRefresh) {
  if (!connected || !window.gapi?.client?.calendar) return;
  try {
    const timeMin = localDayBoundaryISO(fetchStartStr, false);
    const timeMax = localDayBoundaryISO(fetchEndStr, true);

    // Busca em paralelo em todos os calendários configurados (o próprio +
    // quaisquer outros que tenham sido compartilhados com essa conta).
    let sawAuthError = false;
    const results = await Promise.all(
      CALENDAR_IDS.map((calId) =>
        window.gapi.client.calendar.events.list({
          calendarId: calId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250
        }).then((resp) => ({ calId, items: resp.result.items || [] }))
          .catch((e) => {
            if ((e?.status || e?.result?.error?.code) === 401) sawAuthError = true;
            console.warn(`Não foi possível ler o calendário "${calId}" (verifique se foi compartilhado com essa conta):`, e);
            return { calId, items: [] };
          })
      )
    );

    // O Google recusou o token mesmo com o app "conectado" na tela — geralmente
    // porque a renovação automática agendada ainda não rodou (aparelho ficou
    // muito tempo suspenso/em segundo plano, por exemplo). Força uma renovação
    // de verdade agora e tenta essa mesma busca de novo, 1x só, antes de
    // desistir — assim a tela se corrige sozinha sem precisar de F5.
    if (sawAuthError && !isRetryAfterRefresh) {
      const renewed = await forceRefresh();
      if (renewed) {
        await fetchGoogleEventsRange(fetchStartStr, fetchEndStr, true);
        return;
      }
    }

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
    loadedRange = { start: fetchStartStr, end: fetchEndStr };
  } catch (e) {
    console.error('Erro ao ler Google Calendar:', e);
  }
  render();
}

/** Recarga padrão ao conectar — cobre ~5 semanas passadas e ~6 meses futuros, o bastante pra abrir o app e já navegar um pouco sem esperar rede. */
async function refreshFromGoogle() {
  if (!connected || !window.gapi?.client?.calendar) {
    loadedRange = null;
    render();
    return;
  }
  const today = todayStr();
  await fetchGoogleEventsRange(addDaysStr(today, -35), addDaysStr(today, 180));
}

/** Garante que o intervalo [startStr, endStr] já foi carregado do Google — se a pessoa navegou pra fora do que já tem em cache, busca de novo (intervalo maior, com folga, pra não ficar buscando a cada clique). */
async function ensureRangeLoaded(startStr, endStr) {
  if (!connected || !window.gapi?.client?.calendar) return;
  if (loadedRange && startStr >= loadedRange.start && endStr <= loadedRange.end) return;
  const unionStart = loadedRange && loadedRange.start < startStr ? loadedRange.start : startStr;
  const unionEnd = loadedRange && loadedRange.end > endStr ? loadedRange.end : endStr;
  await fetchGoogleEventsRange(addDaysStr(unionStart, -60), addDaysStr(unionEnd, 60));
}

function getAllEvents() {
  if (connected) return googleEventsCache;
  return localEventsStore.list.map((e) => ({ ...e, source: 'local' }));
}

export function getTodayEvents() {
  const today = todayStr();
  return getAllEvents().filter((e) => e.date === today);
}

/** Eventos entre duas datas 'YYYY-MM-DD', inclusive (comparação por string funciona por ser ISO). */
export function getEventsInRange(startDate, endDate) {
  return getAllEvents()
    .filter((e) => e.date >= startDate && e.date <= endDate)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

/** Registra um callback pra re-render quando os eventos mudarem (Google ou local). */
export function onEventsChange(cb) {
  eventsChangeListeners.add(cb);
  return () => eventsChangeListeners.delete(cb);
}

async function addEvent({ title, date, time, calendarId }) {
  if (connected && window.gapi?.client?.calendar) {
    const event = time
      ? { summary: title, start: { dateTime: `${date}T${time}:00` }, end: { dateTime: `${date}T${time}:00` } }
      : { summary: title, start: { date }, end: { date } };
    await window.gapi.client.calendar.events.insert({ calendarId: calendarId || 'primary', resource: event });
    // Garante que o dia recém-criado está dentro do intervalo carregado antes
    // de recarregar — evita o evento novo "sumir" se ele caiu fora do cache.
    loadedRange = null;
    await refreshFromGoogle();
  } else {
    await localEventsStore.add({ title, date, time: time || null, allDay: !time });
    render();
  }
}

/** @param {string} [prefillDate] data 'YYYY-MM-DD' pré-selecionada (ex: veio de um clique num dia específico) */
function openEventForm(prefillDate) {
  const showCalendarPicker = connected && WRITABLE_CALENDAR_IDS.length > 1;
  openModal({
    title: 'Novo compromisso',
    bodyHtml: `
      <form id="eventForm">
        <label>Título</label>
        <input type="text" name="title" required placeholder="Ex: Aniversário da Vivi">
        <label>Data</label>
        <input type="date" name="date" required value="${prefillDate || todayStr()}">
        <label>Horário (opcional)</label>
        <input type="time" name="time">
        ${showCalendarPicker ? `
          <label>Adicionar no calendário de</label>
          <select name="calendarId">
            ${WRITABLE_CALENDAR_IDS.map((id) => `<option value="${id}">${calendarLabel(id)}</option>`).join('')}
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

/** Linha de um compromisso — usada na visão Dia, nas colunas da Semana e no modal de detalhe do dia. */
function eventRowHtml(e) {
  const timeHtml = e.time
    ? `<span class="cal-event-time">${e.time}</span>`
    : `<span class="cal-event-time cal-event-allday">dia todo</span>`;
  const sourceHtml = (e.calendarId && e.calendarId !== 'primary')
    ? `<span class="cal-event-source">${escapeHtml(calendarLabel(e.calendarId))}</span>`
    : '';
  return `<div class="cal-event-row">${timeHtml}<span class="cal-event-title">${escapeHtml(e.title)}</span>${sourceHtml}</div>`;
}

/** Modal com a lista completa de compromissos de um dia — aberto ao clicar numa célula da visão Mês. */
function openDayDetail(dateStr) {
  const events = getEventsInRange(dateStr, dateStr).sort(sortByTime);
  const d = parseDateStr(dateStr);
  openModal({
    title: `${DIAS[d.getUTCDay()]}, ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`,
    bodyHtml: `
      <div class="cal-day-list">
        ${events.length ? events.map(eventRowHtml).join('') : '<p class="hint">Nenhum compromisso nesse dia.</p>'}
      </div>
      <div class="modal-actions">
        <button type="button" id="dayDetailAddBtn" class="btn-secondary">+ Compromisso</button>
        <button type="button" id="dayDetailCloseBtn" class="btn-primary">Fechar</button>
      </div>
    `,
    onMount: (modalEl, close) => {
      modalEl.querySelector('#dayDetailCloseBtn').addEventListener('click', close);
      modalEl.querySelector('#dayDetailAddBtn').addEventListener('click', () => { close(); openEventForm(dateStr); });
    }
  });
}

// ----------------------------------------------------------------------------
// Intervalo de datas coberto pela visão atual (usado tanto pra render quanto
// pra saber o que precisa estar carregado do Google).
// ----------------------------------------------------------------------------
function currentViewRange() {
  if (viewMode === 'day') return { start: anchorDateStr, end: anchorDateStr };
  if (viewMode === 'week') {
    const start = mondayOfWeekStr(anchorDateStr);
    return { start, end: addDaysStr(start, 6) };
  }
  // month — sempre um grid fechado de semanas completas (seg→dom), como a
  // maioria dos apps de calendário mostra.
  const start = mondayOfWeekStr(firstOfMonthStr(anchorDateStr));
  const end = addDaysStr(mondayOfWeekStr(lastOfMonthStr(anchorDateStr)), 6);
  return { start, end };
}

function viewTitle() {
  const d = parseDateStr(anchorDateStr);
  if (viewMode === 'month') return `${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
  if (viewMode === 'week') {
    const { start, end } = currentViewRange();
    const s = parseDateStr(start);
    const en = parseDateStr(end);
    return s.getUTCMonth() === en.getUTCMonth()
      ? `${s.getUTCDate()} – ${en.getUTCDate()} de ${MESES[en.getUTCMonth()]} de ${en.getUTCFullYear()}`
      : `${s.getUTCDate()} ${MESES_ABREV[s.getUTCMonth()]} – ${en.getUTCDate()} ${MESES_ABREV[en.getUTCMonth()]} de ${en.getUTCFullYear()}`;
  }
  return `${DIAS[d.getUTCDay()]}, ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

function goPrev() {
  if (viewMode === 'day') anchorDateStr = addDaysStr(anchorDateStr, -1);
  else if (viewMode === 'week') anchorDateStr = addDaysStr(anchorDateStr, -7);
  else anchorDateStr = addMonthsStr(anchorDateStr, -1);
  refreshView();
}

function goNext() {
  if (viewMode === 'day') anchorDateStr = addDaysStr(anchorDateStr, 1);
  else if (viewMode === 'week') anchorDateStr = addDaysStr(anchorDateStr, 7);
  else anchorDateStr = addMonthsStr(anchorDateStr, 1);
  refreshView();
}

function goToday() {
  anchorDateStr = todayStr();
  refreshView();
}

function goToDay(dateStr) {
  viewMode = 'day';
  anchorDateStr = dateStr;
  persistViewMode();
  refreshView();
}

// ----------------------------------------------------------------------------
// Render — 3 visões + toolbar (Dia/Semana/Mês + navegação).
// ----------------------------------------------------------------------------
function renderMonthGrid(container) {
  const { start, end } = currentViewRange();
  const totalDays = Math.round((parseDateStr(end) - parseDateStr(start)) / 86400000) + 1;
  const eventsByDate = groupByDate(getEventsInRange(start, end));
  const today = todayStr();
  const anchorMonth = parseDateStr(anchorDateStr).getUTCMonth();
  const MAX_VISIBLE = 3;

  let html = `<div class="cal-weekday-row">${DIAS_ABREV.slice(1).concat(DIAS_ABREV[0]).map((d) => `<div>${d}</div>`).join('')}</div>`;
  html += '<div class="cal-month-grid">';
  for (let i = 0; i < totalDays; i++) {
    const date = addDaysStr(start, i);
    const d = parseDateStr(date);
    const dayEvents = (eventsByDate.get(date) || []).sort(sortByTime);
    const shown = dayEvents.slice(0, MAX_VISIBLE);
    const extra = dayEvents.length - shown.length;
    const cls = ['cal-month-cell'];
    if (date === today) cls.push('today');
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) cls.push('weekend');
    if (d.getUTCMonth() !== anchorMonth) cls.push('other-month');
    html += `
      <button type="button" class="${cls.join(' ')}" data-date="${date}">
        <div class="cal-month-daynum">${d.getUTCDate()}</div>
        <div class="cal-month-events">
          ${shown.map((e) => `<div class="cal-month-event">${e.time ? e.time + ' ' : ''}${escapeHtml(e.title)}</div>`).join('')}
          ${extra > 0 ? `<div class="cal-month-more">+${extra} mais</div>` : ''}
        </div>
      </button>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
  container.querySelectorAll('.cal-month-cell').forEach((cell) => {
    cell.addEventListener('click', () => openDayDetail(cell.dataset.date));
  });
}

function renderWeekGrid(container) {
  const { start } = currentViewRange();
  const eventsByDate = groupByDate(getEventsInRange(start, addDaysStr(start, 6)));
  const today = todayStr();

  let html = '<div class="cal-week-grid">';
  for (let i = 0; i < 7; i++) {
    const date = addDaysStr(start, i);
    const d = parseDateStr(date);
    const dayEvents = (eventsByDate.get(date) || []).sort(sortByTime);
    const cls = ['cal-week-col'];
    if (date === today) cls.push('today');
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) cls.push('weekend');
    html += `
      <div class="${cls.join(' ')}">
        <button type="button" class="cal-week-daybtn" data-date="${date}">
          <span class="cal-week-dayname">${DIAS_ABREV[d.getUTCDay()]}</span>
          <span class="cal-week-daynum">${d.getUTCDate()}</span>
        </button>
        <div class="cal-week-events">
          ${dayEvents.length ? dayEvents.map(eventRowHtml).join('') : '<div class="hint" style="margin:6px 0 0;">—</div>'}
        </div>
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
  container.querySelectorAll('.cal-week-daybtn').forEach((btn) => {
    btn.addEventListener('click', () => goToDay(btn.dataset.date));
  });
}

function renderDayList(container) {
  const events = getEventsInRange(anchorDateStr, anchorDateStr).sort(sortByTime);
  container.innerHTML = `
    <div class="cal-day-list">
      ${events.length ? events.map(eventRowHtml).join('') : '<p class="hint">Nenhum compromisso nesse dia.</p>'}
    </div>
    <button type="button" id="calAddForDayBtn" class="btn-secondary" style="margin-top:12px;">+ Compromisso nesse dia</button>
  `;
  container.querySelector('#calAddForDayBtn').addEventListener('click', () => openEventForm(anchorDateStr));
}

function renderCalendarBody() {
  const container = document.getElementById('calendarBody');
  if (!container) return;
  if (viewMode === 'day') renderDayList(container);
  else if (viewMode === 'week') renderWeekGrid(container);
  else renderMonthGrid(container);
}

function renderToolbar() {
  const el = document.getElementById('calendarToolbar');
  if (!el) return;
  el.innerHTML = `
    <div class="cal-view-switch">
      <button type="button" class="cal-view-btn" data-mode="day">Dia</button>
      <button type="button" class="cal-view-btn" data-mode="week">Semana</button>
      <button type="button" class="cal-view-btn" data-mode="month">Mês</button>
    </div>
    <div class="week-nav">
      <button type="button" id="calPrevBtn">‹</button>
      <button type="button" id="calTodayBtn" class="cal-today-btn">Hoje</button>
      <button type="button" id="calNextBtn">›</button>
    </div>
    <div class="cal-period-label">${viewTitle()}</div>
  `;
  el.querySelectorAll('.cal-view-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === viewMode);
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.mode;
      persistViewMode();
      refreshView();
    });
  });
  el.querySelector('#calPrevBtn').addEventListener('click', goPrev);
  el.querySelector('#calNextBtn').addEventListener('click', goNext);
  el.querySelector('#calTodayBtn').addEventListener('click', goToday);
}

/** Navegação (troca de visão, dia/semana/mês anterior-próximo, "Hoje"): renderiza otimista com o que já tem em cache e busca mais dados do Google se a nova visão for além do que já foi carregado. */
async function refreshView() {
  renderToolbar();
  renderCalendarBody();
  const { start, end } = currentViewRange();
  await ensureRangeLoaded(start, end);
  // ensureRangeLoaded já chama render() (que re-renderiza tudo) quando busca
  // dados novos — mas se o intervalo já estava coberto (nada foi buscado),
  // garante que a tela fique consistente mesmo assim.
  renderToolbar();
  renderCalendarBody();
}

function render() {
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
  renderToolbar();
  renderCalendarBody();
  eventsChangeListeners.forEach((cb) => cb());
}

export function initCalendar() {
  localEventsStore.subscribe(() => { if (!connected) render(); });
  document.getElementById('addEventBtn').addEventListener('click', () => openEventForm());
  render();
}
