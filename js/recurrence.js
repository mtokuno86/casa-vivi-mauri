// ============================================================================
// recurrence.js — motor de recorrência de tarefas.
//
// Corrige os bugs do Cozi:
//  - Mesma lógica roda em celular e tablet (é o mesmo código), então não há
//    "opção quinzenal só no tablet".
//  - Semanal e quinzenal (e a cada N semanas) são o MESMO mecanismo
//    (weekInterval), então nenhum dia da semana fica "travado".
//
// Modelo de recorrência (task.recurrence):
//   { freq: 'none' | 'daily' | 'weekly' | 'monthly' | 'custom',
//     startDate: 'YYYY-MM-DD',   // âncora, primeira ocorrência possível
//     weekInterval: 1|2|3...,    // usado em 'weekly' (1=toda semana, 2=quinzenal, ...)
//     daysOfWeek: [0..6],        // usado em 'weekly' (0=domingo ... 6=sábado)
//     dayOfMonth: 1..31,         // usado em 'monthly'
//     everyNDays: n              // usado em 'custom'
//   }
// ============================================================================

const MS_DAY = 24 * 60 * 60 * 1000;

/** Converte 'YYYY-MM-DD' em Date em UTC-meio-dia (evita bug de fuso/DST). */
export function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

export function formatDateStr(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayStr() {
  return formatDateStr(new Date());
}

export function addDaysStr(dateStr, days) {
  const d = parseDateStr(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateStr(d);
}

function daysBetween(aStr, bStr) {
  return Math.round((parseDateStr(bStr) - parseDateStr(aStr)) / MS_DAY);
}

/** Segunda-feira (ISO) da semana que contém dateStr, como string. */
function mondayOfWeek(dateStr) {
  const d = parseDateStr(dateStr);
  const dow = d.getUTCDay(); // 0=domingo
  const diffToMonday = (dow === 0 ? -6 : 1 - dow);
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return formatDateStr(d);
}

/**
 * Retorna true se a tarefa tem ocorrência no dia `dateStr`.
 */
export function isDueOn(task, dateStr) {
  const rec = task.recurrence;
  if (!rec || rec.freq === 'none') {
    return task.dueDate === dateStr;
  }

  if (dateStr < rec.startDate) return false;

  switch (rec.freq) {
    case 'daily':
      return true;

    case 'weekly': {
      const days = rec.daysOfWeek && rec.daysOfWeek.length ? rec.daysOfWeek : [parseDateStr(rec.startDate).getUTCDay()];
      const dow = parseDateStr(dateStr).getUTCDay();
      if (!days.includes(dow)) return false;
      const interval = rec.weekInterval || 1;
      if (interval === 1) return true;
      const startMonday = mondayOfWeek(rec.startDate);
      const targetMonday = mondayOfWeek(dateStr);
      const weeksElapsed = Math.round(daysBetween(startMonday, targetMonday) / 7);
      return weeksElapsed % interval === 0;
    }

    case 'monthly': {
      const day = parseDateStr(dateStr).getUTCDate();
      return day === (rec.dayOfMonth || parseDateStr(rec.startDate).getUTCDate());
    }

    case 'custom': {
      const n = rec.everyNDays || 1;
      const diff = daysBetween(rec.startDate, dateStr);
      return diff >= 0 && diff % n === 0;
    }

    default:
      return false;
  }
}

/** Próxima ocorrência a partir de (e incluindo) fromDateStr, buscando até `maxDays`. */
export function nextOccurrence(task, fromDateStr, maxDays = 400) {
  for (let i = 0; i < maxDays; i++) {
    const d = addDaysStr(fromDateStr, i);
    if (isDueOn(task, d)) return d;
  }
  return null;
}

/** Todas as ocorrências entre duas datas (inclusive), útil para telas de semana. */
export function occurrencesBetween(task, startStr, endStr) {
  const out = [];
  let cur = startStr;
  while (cur <= endStr) {
    if (isDueOn(task, cur)) out.push(cur);
    cur = addDaysStr(cur, 1);
  }
  return out;
}

/** Rótulo legível da recorrência, em português. */
export function describeRecurrence(rec) {
  if (!rec || rec.freq === 'none') return 'Não repete';
  const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  switch (rec.freq) {
    case 'daily':
      return 'Todos os dias';
    case 'weekly': {
      const interval = rec.weekInterval || 1;
      const dias = (rec.daysOfWeek || []).map((d) => DIAS[d]).join(', ');
      if (interval === 1) return `Toda semana (${dias})`;
      if (interval === 2) return `Quinzenal (${dias})`;
      return `A cada ${interval} semanas (${dias})`;
    }
    case 'monthly':
      return `Todo mês, dia ${rec.dayOfMonth}`;
    case 'custom':
      return `A cada ${rec.everyNDays} dias`;
    default:
      return '';
  }
}
