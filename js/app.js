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

  const googleBtn = document.getElementById('googleSignInBtn');
  googleBtn.addEventListener('click', authMod.signIn);
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('Service worker falhou:', e));
  }
}

main();
