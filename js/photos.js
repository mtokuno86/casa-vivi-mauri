// ============================================================================
// photos.js — galeria de fotos do dashboard, lida de uma pasta do Google
// Drive (mesmo login usado pelo Google Calendar). Pensada pro tablet fixo
// na geladeira: pré-carrega as fotos e vai revezando sozinha.
// ============================================================================
import { photosDriveFolderId, photoRotationMs } from './config.js';
import { onAuthChange, getAccessToken, isConfigured } from './auth.js';

let blobUrls = [];
let rotationTimer = null;
let currentIndex = 0;

async function fetchFileList() {
  const resp = await window.gapi.client.drive.files.list({
    q: `'${photosDriveFolderId}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 50,
    orderBy: 'modifiedTime desc'
  });
  return resp.result.files || [];
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
  gallery.innerHTML = blobUrls.map((url, i) => `<img src="${url}" class="${i === 0 ? 'visible' : ''}" data-i="${i}">`).join('');
  currentIndex = 0;
  clearInterval(rotationTimer);
  rotationTimer = setInterval(() => {
    const imgs = gallery.querySelectorAll('img');
    if (!imgs.length) return;
    imgs[currentIndex].classList.remove('visible');
    currentIndex = (currentIndex + 1) % imgs.length;
    imgs[currentIndex].classList.add('visible');
  }, photoRotationMs);
}

async function loadGallery() {
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

  renderEmpty('Carregando fotos…');
  try {
    const files = await fetchFileList();
    if (!files.length) {
      renderEmpty('Nenhuma foto encontrada na pasta configurada do Google Drive.');
      return;
    }
    revokeAll();
    blobUrls = await Promise.all(files.map((f) => fetchImageBlobUrl(f.id)));
    renderGallery();
  } catch (e) {
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
