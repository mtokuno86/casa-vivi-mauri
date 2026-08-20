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
let slides = []; // { url, dateLabel, cityLabel }
let rotationTimer = null;
let currentIndex = 0;
let slidesGeneration = 0; // incrementa a cada nova galeria carregada — evita que uma busca de cidade "atrasada" de uma carga antiga escreva em cima da carga atual

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

async function fetchFileList() {
  const resp = await window.gapi.client.drive.files.list({
    q: `'${photosDriveFolderId}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: 'files(id, name, createdTime, imageMediaMetadata(time,location))',
    pageSize: 50,
    orderBy: 'modifiedTime desc'
  });
  return resp.result.files || [];
}

// ----------------------------------------------------------------------------
// Cidade onde a foto foi tirada — a partir do EXIF de geolocalização que o
// Drive expõe em imageMediaMetadata.location (nem toda foto tem: depende do
// aparelho/app que tirou a foto e se o compartilhamento manteve o EXIF).
// Usa a Nominatim (OpenStreetMap): é gratuita e não exige chave de API, mas
// pede no máximo ~1 consulta por segundo por app — por isso as consultas
// rodam uma de cada vez (nunca em paralelo) e o resultado fica guardado em
// localStorage por coordenada arredondada, pra nunca repetir a mesma
// consulta duas vezes.
// ----------------------------------------------------------------------------
const GEO_CACHE_KEY = 'casa-vm:photoGeoCache';
let geoCache = null;

function loadGeoCache() {
  if (geoCache) return geoCache;
  try { geoCache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}'); } catch (e) { geoCache = {}; }
  return geoCache;
}

function saveGeoCache() {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache)); } catch (e) { /* ignora se localStorage não disponível */ }
}

// Arredonda pra ~1km de precisão — de sobra pra identificar a cidade, e
// junta consultas de fotos tiradas perto uma da outra num só cache-hit.
function geoCacheKey(lat, lon) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cidade (e estado, se disponível) para uma coordenada, ou null se não achar/tiver metadado. */
async function cityForLocation(loc) {
  if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return null;
  const cache = loadGeoCache();
  const key = geoCacheKey(loc.latitude, loc.longitude);
  if (key in cache) return cache[key];

  let label = null;
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${loc.latitude}&lon=${loc.longitude}&zoom=10&addressdetails=1`);
    if (resp.ok) {
      const data = await resp.json();
      const a = data.address || {};
      const city = a.city || a.town || a.village || a.municipality || a.county || null;
      label = city && a.state ? `${city}, ${a.state}` : city;
    }
  } catch (e) {
    console.warn('Não foi possível identificar a cidade de uma foto:', e);
  }
  cache[key] = label;
  saveGeoCache();
  await sleep(1100); // só espaça quando teve que consultar a Nominatim de verdade (cache-hit acima já retornou antes de chegar aqui)
  return label;
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

function slideCaptionText(s) {
  return [s.dateLabel, s.cityLabel].filter(Boolean).join(' · ');
}

function renderGallery() {
  const gallery = document.getElementById('photoGallery');
  if (!gallery) return;
  // Cada slide tem um fundo desfocado (a própria foto, ampliada e borrada)
  // atrás da foto nítida — assim fotos em pé (retrato) preenchem as laterais
  // de forma elegante em vez de aparecer cortada ou com barras pretas.
  gallery.innerHTML = slides.map((s, i) => {
    const caption = slideCaptionText(s);
    return `
    <div class="photo-slide ${i === 0 ? 'visible' : ''}" data-i="${i}">
      <div class="photo-bg" style="background-image:url('${s.url}')"></div>
      <img src="${s.url}" class="photo-fg">
      ${caption ? `<div class="photo-caption">${escapeHtml(caption)}</div>` : ''}
    </div>
  `;
  }).join('');
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

/** Atualiza (ou cria/remove) a legenda de um slide já na tela, sem re-renderizar a galeria inteira — usado quando a cidade de uma foto chega depois, em segundo plano. */
function updateSlideCaption(i) {
  const gallery = document.getElementById('photoGallery');
  if (!gallery) return;
  const slideEl = gallery.querySelector(`.photo-slide[data-i="${i}"]`);
  const s = slides[i];
  if (!slideEl || !s) return;
  const caption = slideCaptionText(s);
  let capEl = slideEl.querySelector('.photo-caption');
  if (!caption) {
    if (capEl) capEl.remove();
    return;
  }
  if (!capEl) {
    capEl = document.createElement('div');
    capEl.className = 'photo-caption';
    slideEl.appendChild(capEl);
  }
  capEl.textContent = caption;
}

/**
 * Depois que a galeria já apareceu na tela (não atrasa a exibição das
 * fotos), busca em segundo plano a cidade de cada foto que tiver
 * geolocalização, uma de cada vez, e vai atualizando a legenda de cada
 * slide conforme cada resposta chega. Para sozinha se uma nova galeria for
 * carregada no meio do caminho (slidesGeneration muda).
 */
async function enrichCities(files, generation) {
  for (let i = 0; i < files.length; i++) {
    if (generation !== slidesGeneration) return;
    const city = await cityForLocation(files[i].imageMediaMetadata?.location);
    if (generation !== slidesGeneration) return;
    if (city && slides[i]) {
      slides[i].cityLabel = city;
      updateSlideCaption(i);
    }
  }
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
    slides = files.map((f, i) => ({ url: blobUrls[i], dateLabel: formatPhotoDate(f), cityLabel: null }));
    renderGallery();
    // Não espera terminar (as fotos já estão na tela) — a cidade de cada uma
    // vai completando a legenda aos poucos, uma consulta de cada vez.
    const generation = ++slidesGeneration;
    enrichCities(files, generation);
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
