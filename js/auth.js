// ============================================================================
// auth.js — login Google (Identity Services) + inicialização do cliente
// gapi, usado por calendar.js (Google Calendar) e photos.js (Drive).
// ============================================================================
import { googleClientId, googleApiKey } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly'
].join(' ');

let tokenClient = null;
let gapiReady = false;
let signedIn = false;
let accessToken = null;
let refreshTimer = null;
const listeners = new Set();

const TOKEN_STORAGE_KEY = 'casa-vm:googleToken';

function saveTokenToStorage(token, expiresAtMs) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, expiresAtMs }));
  } catch (e) { /* ignora se localStorage não disponível */ }
}

function loadTokenFromStorage() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data.token || !data.expiresAtMs) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function notify() {
  listeners.forEach((cb) => cb(signedIn));
}

export function onAuthChange(cb) {
  listeners.add(cb);
  cb(signedIn);
  return () => listeners.delete(cb);
}

export function isConfigured() {
  return !!(googleClientId && googleApiKey);
}

export function isSignedIn() {
  return signedIn;
}

export function getAccessToken() {
  return accessToken;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.defer = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensureGapiClient() {
  if (gapiReady) return;
  await new Promise((resolve) => window.gapi.load('client', resolve));
  await window.gapi.client.init({
    apiKey: googleApiKey,
    discoveryDocs: [
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
      'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'
    ]
  });
  gapiReady = true;
}

function scheduleSilentRefresh(expiresInSec) {
  clearTimeout(refreshTimer);
  const refreshInMs = Math.max((expiresInSec - 120) * 1000, 30000); // 2 min antes de expirar
  refreshTimer = setTimeout(() => {
    if (tokenClient) tokenClient.requestAccessToken({ prompt: '' });
  }, refreshInMs);
}

function applyToken(token, expiresInSec) {
  accessToken = token;
  window.gapi.client.setToken({ access_token: accessToken });
  signedIn = true;
  const expiresAtMs = Date.now() + (expiresInSec || 3300) * 1000;
  saveTokenToStorage(token, expiresAtMs);
  scheduleSilentRefresh(expiresInSec || 3300);
  notify();
}

export async function initAuth() {
  if (!isConfigured()) {
    console.warn('Google Client ID / API Key não configurados em js/config.js — login Google desativado.');
    return;
  }
  await Promise.all([
    loadScript('https://apis.google.com/js/api.js'),
    loadScript('https://accounts.google.com/gsi/client')
  ]);
  await ensureGapiClient();

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: googleClientId,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) {
        console.error('Erro no login Google:', resp);
        return;
      }
      applyToken(resp.access_token, resp.expires_in);
    }
  });

  // Se já temos um token salvo e ainda válido (por ~1h), usa direto — evita
  // reabrir o popup de conexão a cada vez que o app é aberto.
  const cached = loadTokenFromStorage();
  if (cached && cached.expiresAtMs > Date.now() + 60000) {
    const remainingSec = Math.round((cached.expiresAtMs - Date.now()) / 1000);
    applyToken(cached.token, remainingSec);
    return;
  }

  // Sem token válido em cache: tenta reconectar silenciosamente (sem popup)
  // se já houve consentimento antes. Em navegadores mobile/PWA isso nem
  // sempre é 100% silencioso — é uma limitação do próprio Google Identity
  // Services, não do app.
  tokenClient.requestAccessToken({ prompt: '' });
}

export function signIn() {
  if (!tokenClient) {
    alert('Configure o Google Client ID / API Key em js/config.js primeiro (veja SETUP.md).');
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}
