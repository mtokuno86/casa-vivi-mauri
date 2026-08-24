// ============================================================================
// auth.js — login Google (Identity Services) + inicialização do cliente
// gapi, usado por calendar.js (Google Calendar) e photos.js (Drive).
//
// Dois modos de conexão, um por cima do outro:
//
// 1) MODO PERSISTENTE (recomendado, precisa de configuração extra — ver
//    SETUP.md): quando googleOAuthCallbackUrl/getGoogleAccessTokenUrl estão
//    preenchidas em config.js, a primeira conexão pede um "refresh token" ao
//    Google (guardado no Firestore por uma Cloud Function, nunca no
//    navegador) e, a partir daí, o app renova o acesso sozinho pra sempre —
//    sem popup, sem expirar por tempo — até a pessoa desconectar de
//    propósito (botão "Google conectado ✓" → confirma desconectar).
//
// 2) MODO ANTIGO (sempre funciona, é o padrão até configurar o modo acima):
//    usa o Google Identity Services direto no navegador. O token expira em
//    ~1h; o app tenta reconectar sozinho 1x por sessão de aba (não a cada
//    reload automático — ver comentário em scheduleExpiry) e, se isso
//    falhar, volta pro estado "desconectado" até um clique manual.
// ============================================================================
import { googleClientId, googleApiKey, googleOAuthCallbackUrl, getGoogleAccessTokenUrl, disconnectGoogleUrl } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

let tokenClient = null;
let gapiReady = false;
let signedIn = false;
let accessToken = null;
let refreshTimer = null;
let userInfo = null; // { email, name, picture } — carregado após login
const listeners = new Set();

const TOKEN_STORAGE_KEY = 'casa-vm:googleToken';
const DEVICE_ID_KEY = 'casa-vm:googleDeviceId';
// sessionStorage (não localStorage!) — existe só enquanto a aba/janela do
// navegador continua aberta, mesmo sobrevivendo a um location.reload(). É
// isso que permite "tentar reconectar 1x por sessão de aba", sem repetir a
// cada reload automático (ver initIdleReload em app.js, que recarrega a
// página a cada 15 min de inatividade) — só usado no modo antigo, o modo
// persistente não precisa dessa cautela (ver mais abaixo).
const SILENT_RECONNECT_KEY = 'casa-vm:silentReconnectTried';

function isPersistentAuthConfigured() {
  return !!(googleOAuthCallbackUrl && getGoogleAccessTokenUrl);
}

function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (window.crypto?.randomUUID)
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) { /* ignora */ }
  }
  return id;
}

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

/** Retorna { email, name, picture } da conta Google logada, ou null. */
export function getUserInfo() {
  return userInfo;
}

async function fetchUserInfo() {
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    userInfo = { email: data.email || null, name: data.name || null, picture: data.picture || null };
    notify();
  } catch (e) {
    console.warn('Não foi possível obter dados do perfil Google:', e);
  }
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

// ----------------------------------------------------------------------------
// Modo persistente — pede um access token novo à nossa Cloud Function
// (getGoogleAccessToken), que usa o refresh_token guardado no Firestore.
// Nunca abre nada visível: ou funciona em silêncio, ou falha com um status
// que diz exatamente o que fazer.
//
// fetchAccessTokenForDevice é a chamada "crua", sem side-effects — usada
// tanto pela renovação em segundo plano quanto pelo polling logo após abrir
// a popup de conexão. Importante: durante o polling, um 404 é NORMAL (a
// popup ainda não terminou de trocar o código pelo token), não significa
// "conexão revogada" — por isso quem decide o que fazer com um 404 é cada
// chamador, não essa função.
//
// TIMEOUT (aprendido testando de verdade): o fetch() do navegador não tem
// limite de tempo por padrão — se a rede cair de um jeito "silencioso" (sem
// fechar a conexão de forma limpa, comum quando o celular troca de wifi pra
// dados móveis, ou a tela apaga no meio da requisição), essa promise pode
// nunca resolver. Isso é grave porque forceRefresh() usa uma única promise
// compartilhada (forceRefreshInFlight) pra nunca disparar duas renovações ao
// mesmo tempo — se ELA travar pra sempre, TODA tentativa futura de renovar
// (inclusive depois de horas) fica presa esperando essa mesma promise morta,
// e o app nunca mais consegue se recuperar sozinho (foi exatamente esse o
// sintoma: um loop de 401 que nunca chegava a chamar nosso servidor de
// verdade). O AbortController abaixo garante que, no máximo em 10s, a
// chamada desiste e cai no "catch" como falha de rede normal — liberando o
// cadeado pra próxima tentativa.
// ----------------------------------------------------------------------------
const FETCH_TOKEN_TIMEOUT_MS = 10000;

async function fetchAccessTokenForDevice(deviceId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TOKEN_TIMEOUT_MS);
  try {
    const resp = await fetch(`${getGoogleAccessTokenUrl}?deviceId=${encodeURIComponent(deviceId)}`, { signal: controller.signal });
    if (resp.ok) return { ok: true, data: await resp.json() };
    return { ok: false, status: resp.status };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Retorna: 'ok' (conectado), 'revoked' (precisa reconectar manualmente),
// 'no-device' (esse aparelho nunca fez a conexão persistente) ou 'error'
// (falha de rede/servidor — vale tentar de novo em breve).
//
// Usada só pra renovação de uma conexão JÁ ESTABELECIDA (scheduleExpiry,
// initAuth) — aqui um 404/401 realmente significa "essa conexão não existe
// mais" (revogada, ou o registro sumiu), então faz sentido limpar o
// deviceId local. NÃO é usada durante o polling pós-popup (ver
// pollAfterPopup), justamente porque lá um 404 é esperado e não deve
// apagar nada.
async function silentRefreshViaBackend() {
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) return 'no-device';
  try {
    const result = await fetchAccessTokenForDevice(deviceId);
    if (result.ok) {
      applyToken(result.data.accessToken, result.data.expiresIn);
      return 'ok';
    }
    if (result.status === 401 || result.status === 404) {
      try { localStorage.removeItem(DEVICE_ID_KEY); } catch (e) { /* ignora */ }
      return 'revoked';
    }
    return 'error';
  } catch (e) {
    console.warn('Falha de rede ao renovar a conexão persistente com o Google:', e);
    return 'error';
  }
}

// Força uma renovação AGORA, ignorando qualquer timer agendado — usada por
// calendar.js/photos.js quando uma chamada de verdade à API do Google volta
// com 401 mesmo com o app mostrando "conectado". Isso significa que o token
// em uso está desatualizado por algum motivo (aparelho ficou muito tempo
// suspenso/em segundo plano e o timer de renovação não rodou na hora certa,
// por exemplo) — em vez de esperar o próximo ciclo agendado (que pode estar
// horas longe), pede um token novo na hora e corrige a tela sozinha.
//
// CUIDADO (aprendido testando de verdade): applyToken() chama notify() a
// cada renovação bem-sucedida — e notify() acorda TODOS os módulos
// inscritos (calendar.js E photos.js), não só quem pediu a renovação. Se o
// token que o backend devolve continuar sendo recusado pelo Google (ex: a
// conexão em si está com problema, não só o token local desatualizado),
// cada um desses módulos bate de novo, cada 401 pede outra renovação, cada
// renovação chama notify() de novo — um loop que se multiplica a cada
// rodada. Por isso forceRefresh() tem um intervalo mínimo entre tentativas
// de verdade ao backend (não adianta martelar se a resposta continua ruim)
// e nunca deixa duas chamadas simultâneas dispararem duas requisições.
let lastForceRefreshAttemptMs = 0;
let forceRefreshInFlight = null;
const FORCE_REFRESH_COOLDOWN_MS = 20000;

export async function forceRefresh() {
  if (!isPersistentAuthConfigured()) return false;
  if (forceRefreshInFlight) return forceRefreshInFlight;
  if (Date.now() - lastForceRefreshAttemptMs < FORCE_REFRESH_COOLDOWN_MS) return false;
  lastForceRefreshAttemptMs = Date.now();
  forceRefreshInFlight = silentRefreshViaBackend()
    .then((result) => {
      // 'revoked'/'no-device': a conexão morreu de vez (não é só token
      // vencido) — avisa a tela agora, em vez de deixar o badge preso em
      // "conectado" enquanto tudo continua falhando por trás.
      if (result === 'revoked' || result === 'no-device') forceSignOutLocally();
      return result === 'ok';
    })
    .finally(() => { forceRefreshInFlight = null; });
  return forceRefreshInFlight;
}

// Antes, isso tentava renovar o token sozinho a cada ~1h chamando
// requestAccessToken({prompt:''}) em segundo plano. Na teoria é "silencioso",
// mas na prática — quando o navegador não consegue completar sem interação
// — o Google acaba abrindo uma janela/aba de login mesmo assim. Com o app
// aberto o dia todo, isso gerava várias abas de login empilhadas.
//
// Agora, se o modo persistente estiver configurado, a renovação passa a ser
// pela nossa própria Cloud Function (sem NENHUMA interação possível do lado
// do Google) — é isso que permite ficar conectado "para sempre". Só cai pro
// comportamento antigo (desconectar e exigir clique manual) se o modo
// persistente não estiver configurado, ou se a conexão persistente falhar
// de vez (revogada).
function scheduleExpiry(expiresInSec) {
  clearTimeout(refreshTimer);
  const expiresInMs = Math.max((expiresInSec || 0) * 1000, 30000);
  // Renova com 5 min de folga antes de expirar de vez — assim o app nunca
  // chega a ficar sem token válido no meio do uso.
  const renewInMs = Math.max(expiresInMs - 5 * 60 * 1000, 30000);
  refreshTimer = setTimeout(async () => {
    if (isPersistentAuthConfigured()) {
      const result = await silentRefreshViaBackend();
      if (result === 'ok') return;
      if (result === 'error') { scheduleExpiry(60); return; } // problema passageiro — tenta de novo em 1 min
      // 'revoked' ou 'no-device': cai pro estado desconectado abaixo.
    }
    forceSignOutLocally();
  }, renewInMs);
}

function applyToken(token, expiresInSec) {
  accessToken = token;
  window.gapi.client.setToken({ access_token: accessToken });
  signedIn = true;
  const expiresAtMs = Date.now() + (expiresInSec || 3300) * 1000;
  saveTokenToStorage(token, expiresAtMs);
  scheduleExpiry(expiresInSec || 3300);
  notify();
  fetchUserInfo();
}

// Desliga de vez o estado "conectado" NESTE aparelho e avisa a tela (botão
// volta a mostrar "Conectar Google"). Usada quando descobrimos que a conexão
// persistente morreu de verdade (revogada no Google, ou o registro sumiu do
// nosso banco) — sem isso, o app ficava preso mostrando "Google conectado ✓"
// pra sempre enquanto Agenda/Fotos silenciosamente continuavam falhando por
// trás, porque nada nunca avisava a tela que a conexão tinha acabado. Foi
// exatamente esse o sintoma relatado no celular/tablet: badge "conectado"
// junto com erro constante ao carregar Agenda/Fotos.
function forceSignOutLocally() {
  clearTimeout(refreshTimer);
  signedIn = false;
  accessToken = null;
  userInfo = null;
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (e) { /* ignora */ }
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

  // Esse aparelho já fez a conexão persistente antes? Renova em silêncio
  // pela nossa Cloud Function — sem popup, sem depender do Google Identity
  // Services, e sem limite de 1x por sessão (não tem risco de popup aqui).
  if (isPersistentAuthConfigured() && localStorage.getItem(DEVICE_ID_KEY)) {
    const result = await silentRefreshViaBackend();
    if (result === 'ok') return;
    // 'revoked'/'no-device'/'error': cai pro modo antigo abaixo como último recurso.
  }

  // Modo antigo: tenta reconectar silenciosamente (sem popup) via Google
  // Identity Services, mas só 1x por sessão de aba (sessionStorage). Motivo:
  // app.js recarrega a página sozinho a cada 15 min de inatividade
  // (initIdleReload), e cada reload chama initAuth() de novo. Sem esse
  // limite, um computador/tablet que fica ligado a noite toda dispara essa
  // tentativa a cada 15 min — e quando o Google não consegue completar 100%
  // em silêncio, ele abre uma aba/janela de login em vez de falhar quieto.
  // Foi exatamente isso que gerou "dezenas de abas" pedindo login de um dia
  // pro outro, antes de existir o modo persistente acima.
  let alreadyTried = false;
  try { alreadyTried = sessionStorage.getItem(SILENT_RECONNECT_KEY) === 'true'; } catch (e) { /* ignora */ }
  if (alreadyTried) return;
  try { sessionStorage.setItem(SILENT_RECONNECT_KEY, 'true'); } catch (e) { /* ignora */ }

  tokenClient.requestAccessToken({ prompt: '' });
}

// Abre a tela de permissão de verdade do Google numa janela popup, pedindo
// acesso "offline" (dá origem a um refresh_token) — só precisa acontecer
// uma vez por aparelho. O popup fecha sozinho quando termina (ver a página
// de retorno em functions/index.js, googleOAuthCallback).
function signInPersistent() {
  const deviceId = getOrCreateDeviceId();
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: googleOAuthCallbackUrl,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: deviceId
  });
  const popup = window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 'googleAuthPopup', 'width=500,height=680');
  if (!popup) {
    alert('Não foi possível abrir a janela de login do Google — verifique se pop-ups estão bloqueados para este site.');
    return;
  }
  pollAfterPopup(deviceId, 0);
}

// Fica checando se a conexão terminou, a cada 1.5s, por até ~1min e meio.
//
// Dois cuidados importantes aqui (aprendidos testando de verdade):
//  1. NÃO usamos silentRefreshViaBackend() nesse polling — ela apaga o
//     deviceId do navegador ao receber um 404, mas um 404 AQUI é normal
//     (a popup ainda não terminou de trocar o código pelo token). Usamos
//     fetchAccessTokenForDevice() direto, que não tem esse efeito colateral.
//  2. NÃO usamos popup.closed pra decidir desistir cedo. O Chrome, por uma
//     política de isolamento entre origens (COOP) que o próprio
//     accounts.google.com ativa assim que a popup navega pra lá, faz esse
//     valor ficar não-confiável — reportou "fechada" nos testes mesmo com a
//     popup ainda aberta na tela de permissão, fazendo o app desistir bem
//     antes da conexão terminar (mesmo ela dando certo do lado do Google).
//     Por isso agora só paramos ao ter sucesso ou ao esgotar as tentativas.
function pollAfterPopup(deviceId, attempt) {
  if (attempt > 60) return; // ~1min e meio de tentativas — desiste em silêncio se a pessoa não terminou
  setTimeout(async () => {
    try {
      const result = await fetchAccessTokenForDevice(deviceId);
      if (result.ok) {
        applyToken(result.data.accessToken, result.data.expiresIn);
        return; // conectou!
      }
    } catch (e) {
      // falha de rede passageira — tenta de novo no próximo ciclo
    }
    pollAfterPopup(deviceId, attempt + 1);
  }, 1500);
}

export function signIn() {
  if (isPersistentAuthConfigured()) {
    signInPersistent();
    return;
  }
  if (!tokenClient) {
    alert('Configure o Google Client ID / API Key em js/config.js primeiro (veja SETUP.md).');
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

/** Desconecta de verdade: revoga a conexão persistente no Google (se houver) e limpa tudo neste aparelho. */
export async function disconnectGoogle() {
  const deviceId = localStorage.getItem(DEVICE_ID_KEY);
  clearTimeout(refreshTimer);
  signedIn = false;
  accessToken = null;
  userInfo = null;
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch (e) { /* ignora */ }
  try { localStorage.removeItem(DEVICE_ID_KEY); } catch (e) { /* ignora */ }
  notify();
  if (deviceId && disconnectGoogleUrl) {
    try {
      await fetch(`${disconnectGoogleUrl}?deviceId=${encodeURIComponent(deviceId)}`, { method: 'POST' });
    } catch (e) {
      console.warn('Falha ao revogar a conexão no servidor (já desconectado neste aparelho):', e);
    }
  }
}
