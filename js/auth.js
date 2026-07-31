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
      accessToken = resp.access_token;
      window.gapi.client.setToken({ access_token: accessToken });
      signedIn = true;
      scheduleSilentRefresh(resp.expires_in || 3300);
      notify();
    }
  });

  // Tenta reconectar silenciosamente (sem popup) se já houve consentimento antes.
  tokenClient.requestAccessToken({ prompt: '' });
}

export function signIn() {
  if (!tokenClient) {
    alert('Configure o Google Client ID / API Key em js/config.js primeiro (veja SETUP.md).');
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}
