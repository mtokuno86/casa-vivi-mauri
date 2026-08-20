// ============================================================================
// app.js — bootstrap: inicializa dados, módulos de cada aba e a navegação.
//
// IMPORTANTE: os módulos de feature (recipes.js, tasks.js, members.js, etc.)
// criam suas "stores" (createStore) assim que são importados — e essa store
// decide, na hora, se vai escutar o Firestore ou o localStorage. Por isso
// eles só podem ser importados DEPOIS que initDb() terminar de configurar o
// Firebase; senão a store nasce presa no modo local mesmo com o Firebase
// configurado (os dados são salvos na nuvem, mas a tela nunca escuta essa
// atualização). Por isso usamos import() dinâmico aqui, dentro de main(),
// em vez de import estático no topo do arquivo.
// ============================================================================
import { initDb, getMode } from './db.js';

// Atualize esta linha a cada nova versão publicada — é o "carimbo" visível
// no topo do app para confirmar se o aparelho já pegou a versão mais nova.
// Formato livre, mas sempre no horário de São Paulo (UTC-3, sem horário de
// verão desde 2019) — não no horário UTC/local de quem estiver editando.
const BUILD_STAMP = '2026-08-20 19:04';

function initTabs(onTabChange) {
  const buttons = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.view');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      views.forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`view-${btn.dataset.tab}`).classList.add('active');
      onTabChange(btn.dataset.tab);
    });
  });
}

// ============================================================================
// Wake Lock — mantém a tela ligada. Pensado pro tablet fixo na tomada, na
// geladeira: sem isso, a tela apagaria sozinha depois de alguns minutos e o
// dashboard perderia a graça. Consome mais bateria, por isso é opt-in (fica
// desligado por padrão e a escolha é lembrada por aparelho).
// ============================================================================
const WAKE_LOCK_STORAGE_KEY = 'casa-vm:wakeLockEnabled';
let wakeLockSentinel = null;

function isWakeLockSupported() {
  return 'wakeLock' in navigator;
}

async function applyWakeLock(enabled) {
  const btn = document.getElementById('wakeLockBtn');
  if (enabled) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
      if (btn) { btn.textContent = '🔆 Tela sempre ligada'; btn.title = 'Toque para voltar a apagar a tela sozinha (economiza bateria)'; }
    } catch (e) {
      console.warn('Não foi possível manter a tela ligada:', e);
      if (btn) btn.textContent = '🔅 Tela sempre ligada (falhou)';
    }
  } else {
    if (wakeLockSentinel) { wakeLockSentinel.release(); wakeLockSentinel = null; }
    if (btn) { btn.textContent = '🔅 Tela sempre ligada'; btn.title = 'Manter a tela ligada (recomendado para o tablet fixo na tomada)'; }
  }
}

function initWakeLock() {
  const btn = document.getElementById('wakeLockBtn');
  if (!btn) return;
  if (!isWakeLockSupported()) {
    btn.style.display = 'none';
    return;
  }
  let enabled = localStorage.getItem(WAKE_LOCK_STORAGE_KEY) === 'true';
  applyWakeLock(enabled);

  btn.addEventListener('click', () => {
    enabled = !enabled;
    localStorage.setItem(WAKE_LOCK_STORAGE_KEY, String(enabled));
    applyWakeLock(enabled);
  });

  // O navegador solta o wake lock sozinho quando a aba perde o foco/fica
  // oculta (ex: tablet apagou a tela antes de a gente conseguir pedir de
  // novo). Ao voltar a ficar visível, reativa se a preferência ainda for "on".
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled && !wakeLockSentinel) {
      applyWakeLock(true);
    }
  });
}

// ============================================================================
// Auto-reload por inatividade — pensado pro tablet fixo na geladeira: se
// alguém mexeu numa aba (Receitas, Compras, um formulário aberto etc.) e
// esqueceu assim, depois de 15 min sem nenhum toque a página recarrega
// sozinha e volta pra aba Início (que é a aba marcada como "active" no
// index.html), deixando o mostrador de volta nas fotos/agenda por padrão.
// Um reload completo também aproveita pra descartar qualquer estado preso
// (modal aberto, filtro esquecido) e conferir se há versão nova publicada.
// ============================================================================
const IDLE_RELOAD_MS = 15 * 60 * 1000;

function initIdleReload() {
  let idleTimer = null;
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      window.location.reload();
    }, IDLE_RELOAD_MS);
  }
  ['click', 'touchstart', 'pointerdown', 'keydown', 'input'].forEach((evt) => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
  });
  resetIdleTimer();
}

// ============================================================================
// Web Share Target — deixa compartilhar um link de receita de dentro de
// QUALQUER app (Chrome, WhatsApp etc.) direto pro nosso app, usando o menu
// nativo de "Compartilhar" do celular. Funciona quando o app está instalado
// na tela inicial (Chrome > menu > "Instalar aplicativo"/"Adicionar à tela
// inicial") — só assim o Android sabe que ele pode aparecer no compartilhar.
// O manifest.json registra o "share_target"; aqui a gente só lê o link que
// veio na URL e abre o formulário de receita já com a importação disparada.
// ============================================================================
function extractSharedUrl() {
  const params = new URLSearchParams(window.location.search);
  const candidates = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean);
  for (const candidate of candidates) {
    const match = candidate.match(/https?:\/\/\S+/);
    if (match) return match[0].replace(/[)>\].,;]+$/, ''); // tira pontuação colada no final do link
  }
  return null;
}

function initSyncStatusIndicator() {
  const el = document.getElementById('syncStatus');
  function update() {
    const online = navigator.onLine;
    el.classList.toggle('offline', !online);
    el.title = online
      ? (getMode() === 'firebase' ? 'Sincronizado (nuvem)' : 'Modo local — configure o Firebase para sincronizar entre aparelhos')
      : 'Sem conexão — as alterações serão sincronizadas quando a internet voltar';
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

async function main() {
  const stampEl = document.getElementById('buildStamp');
  if (stampEl) stampEl.textContent = `· v. ${BUILD_STAMP}`;

  // 1) Firebase (ou modo local) precisa estar pronto ANTES de qualquer
  //    módulo de feature ser carregado.
  await initDb();

  // 2) Só agora carregamos os módulos que criam stores.
  const [
    authMod, membersMod, recipesMod, mealPlannerMod, stockMod,
    shoppingListMod, tasksMod, calendarMod, photosMod, dashboardMod
  ] = await Promise.all([
    import('./auth.js'),
    import('./members.js'),
    import('./recipes.js'),
    import('./mealPlanner.js'),
    import('./stock.js'),
    import('./shoppingList.js'),
    import('./tasks.js'),
    import('./calendar.js'),
    import('./photos.js'),
    import('./dashboard.js')
  ]);

  initSyncStatusIndicator();
  initWakeLock();
  initIdleReload();

  const googleBtn = document.getElementById('googleSignInBtn');
  googleBtn.addEventListener('click', async () => {
    if (authMod.isSignedIn()) {
      if (window.confirm('Desconectar sua conta Google deste aparelho?')) {
        await authMod.disconnectGoogle();
      }
      return;
    }
    authMod.signIn();
  });
  authMod.onAuthChange((signedIn) => {
    googleBtn.textContent = signedIn ? 'Google conectado ✓' : 'Conectar Google';
  });

  membersMod.initMembers();
  recipesMod.initRecipes();
  mealPlannerMod.initMealPlanner();
  stockMod.initStock();
  shoppingListMod.initShoppingList();
  tasksMod.initTasks();
  calendarMod.initCalendar();
  dashboardMod.initDashboard();

  initTabs((tab) => {
    if (tab === 'dashboard') dashboardMod.refreshDashboard();
    if (tab === 'compras') shoppingListMod.refreshShoppingList();
  });

  // Login/Calendar/Drive são opcionais — não travam o resto do app se falharem.
  authMod.initAuth().catch((e) => console.warn('Google não inicializado:', e));
  photosMod.initPhotoGallery();

  // Se o app foi aberto por causa de um "compartilhar" (Web Share Target),
  // pula direto pra Receitas com a importação já em andamento.
  const sharedUrl = extractSharedUrl();
  if (sharedUrl) {
    history.replaceState(null, '', window.location.pathname); // evita reimportar num F5
    const receitasBtn = document.querySelector('.tab-btn[data-tab="receitas"]');
    if (receitasBtn) receitasBtn.click();
    recipesMod.openSharedRecipeImport(sharedUrl);
  }

  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // updateViaCache: 'none' garante que o navegador sempre busque o
  // service-worker.js de verdade na rede para checar se mudou, em vez de
  // usar uma cópia em cache HTTP — é essa checagem "preguiçosa" que fazia
  // o app parecer travado numa versão antiga mesmo depois de publicar uma
  // nova.
  navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' })
    .then((registration) => {
      // Enquanto o app ficar aberto (o tablet da geladeira, por exemplo),
      // verifica de tempos em tempos se há uma versão nova publicada.
      setInterval(() => registration.update(), 60 * 60 * 1000);
    })
    .catch((e) => console.warn('Service worker falhou:', e));

  // Quando uma versão nova do service worker assume o controle da página,
  // recarrega a página automaticamente uma única vez — sem isso, o usuário
  // precisava fechar e abrir o app manualmente (ou limpar dados do site)
  // para ver a atualização.
  let refreshingPage = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshingPage) return;
    refreshingPage = true;
    window.location.reload();
  });
}

main();
