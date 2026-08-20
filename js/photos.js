// ============================================================================
// photos.js — galeria de fotos do dashboard, lida de uma pasta do Google
// Drive (mesmo login usado pelo Google Calendar). Pensada pro tablet fixo
// na geladeira: pré-carrega as fotos e vai revezando sozinha.
// ============================================================================
import { photosDriveFolderId, photoRotationMs } from './config.js';
import { onAuthChange, getAccessToken, isConfigured, forceRefresh } from './auth.js';

/** Detecta um 401 tanto no formato de erro do gapi (Drive) quanto do fetch cru (download da foto). */
function isAuthError(e) {
  const status = e?.status || e?.result?.error?.code;
  if (status === 401) return true;
  return typeof e?.message === 'string' && /:\s*401$/.test(e.message);
}

let blobUrls = [];
let slides = []; // { url, dateLabel }
let rotationTimer = null;
let currentIndex = 0;

async function fetchFileList() {
  const resp = await window.gapi.client.drive.files.list({
    q: `'${photosDriveFolderId}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: 'files(id, name, createdTime, imageMediaMetadata)',
    pageSize: 50,
    orderBy: 'modifiedTime desc'
  });
  return resp.result.files || [];
}

/**
 * Data em que a foto foi tirada, formatada em pt-BR (dd/mm/aaaa).
 * Prioriza o metadado EXIF (imageMediaMetadata.time, no formato
 * "AAAA:MM:DD HH:MM:SS") — é a data real da foto. Se a foto não tiver esse
 * metadado (ex: veio de print/edição), usa a data de criação no Drive como
 * aproximação.
 */
function formatPhotoDate(file) {
  const raw = file.imageMediaMetadata?.time || file.createdTime;
  if (!raw) return null;
  let d;
  if (raw.includes('T')) {
    d = new Date(raw); // createdTime, formato ISO
  } else {
    const [datePart, timePart] = raw.split(' ');
    const [y, m, day] = (datePart || '').split(':');
    if (!y || !m || !day) return null;
    d = new Date(`${y}-${m}-${day}T${timePart || '00:00:00'}`);
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR');
}

async function fetchImageBlobUrl(fileId) {
  const token = getAccessToken();
  const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Falha ao baixar foto ${fileId}: ${resp.status}`);
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

function revokeAll() {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls = [];
}

function renderEmpty(message) {
  const gallery = document.getElementById('photoGallery');
  if (gallery) gallery.innerHTML = `<div class="photo-empty">${message}</div>`;
}

function renderGallery() {
  const gallery = document.getElementById('photoGallery');
  if (!gallery) return;
  // Cada slide tem um fundo desfocado (a própria foto, ampliada e borrada)
  // atrás da foto nítida — assim fotos em pé (retrato) preenchem as laterais
  // de forma elegante em vez de aparecer cortada ou com barras pretas.
  gallery.innerHTML = slides.map((s, i) => `
    <div class="photo-slide ${i === 0 ? 'visible' : ''}" data-i="${i}">
      <div class="photo-bg" style="background-image:url('${s.url}')"></div>
      <img src="${s.url}" class="photo-fg">
      ${s.dateLabel ? `<div class="photo-caption">${s.dateLabel}</div>` : ''}
    </div>
  `).join('');
  currentIndex = 0;
  clearInterval(rotationTimer);
  rotationTimer = setInterval(() => {
    const slides = gallery.querySelectorAll('.photo-slide');
    if (!slides.length) return;
    slides[currentIndex].classList.remove('visible');
    currentIndex = (currentIndex + 1) % slides.length;
    slides[currentIndex].classList.add('visible');
  }, photoRotationMs);
}

async function loadGallery(isRetryAfterRefresh) {
  if (!photosDriveFolderId) {
    renderEmpty('Configure <code>photosDriveFolderId</code> em js/config.js (ID da pasta do Google Drive) para ver as fotos aqui.');
    return;
  }
  if (!isConfigured()) {
    renderEmpty('Configure o Google Client ID / API Key em js/config.js para habilitar a galeria (veja SETUP.md).');
    return;
  }
  if (!getAccessToken()) {
    renderEmpty('Conecte sua conta Google (botão no topo) para carregar as fotos da geladeira.');
    return;
  }

  if (!isRetryAfterRefresh) renderEmpty('Carregando fotos…');
  try {
    const files = await fetchFileList();
    if (!files.length) {
      renderEmpty('Nenhuma foto encontrada na pasta configurada do Google Drive.');
      return;
    }
    revokeAll();
    blobUrls = await Promise.all(files.map((f) => fetchImageBlobUrl(f.id)));
    slides = files.map((f, i) => ({ url: blobUrls[i], dateLabel: formatPhotoDate(f) }));
    renderGallery();
  } catch (e) {
    // O Google recusou o token mesmo com o app "conectado" — provavelmente a
    // renovação automática agendada ainda não rodou (aparelho ficou muito
    // tempo suspenso/em segundo plano, por exemplo). Força uma renovação de
    // verdade e tenta essa mesma carga de novo, 1x só, antes de desistir.
    if (isAuthError(e) && !isRetryAfterRefresh) {
      const renewed = await forceRefresh();
      if (renewed) { await loadGallery(true); return; }
    }
    console.error('Erro carregando galeria de fotos:', e);
    renderEmpty('Não foi possível carregar as fotos agora. Tentando de novo mais tarde.');
    setTimeout(loadGallery, 60000);
  }
}

export function initPhotoGallery() {
  onAuthChange((signedIn) => {
    if (signedIn) loadGallery();
  });
  loadGallery();
}
