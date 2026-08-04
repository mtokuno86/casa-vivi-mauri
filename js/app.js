// ============================================================================
// app.js — bootstrap: inicializa dados, módulos de cada aba e a navegação.
// ============================================================================
import { initDb, getMode } from './db.js';
import { initAuth, signIn, onAuthChange } from './auth.js';
import { initMembers } from './members.js';
import { initRecipes } from './recipes.js';
import { initMealPlanner } from './mealPlanner.js';
import { initStock } from './stock.js';
import { initShoppingList, refreshShoppingList } from './shoppingList.js';
import { initTasks } from './tasks.js';
import { initCalendar } from './calendar.js';
import { initPhotoGallery } from './photos.js';
import { initDashboard, refreshDashboard } from './dashboard.js';

function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.view');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      views.forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`view-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'dashboard') refreshDashboard();
      if (btn.dataset.tab === 'compras') refreshShoppingList();
    });
  });
}

function initGoogleButton() {
  const btn = document.getElementById('googleSignInBtn');
  btn.addEventListener('click', signIn);
  onAuthChange((signedIn) => {
    btn.textContent = signedIn ? 'Google conectado ✓' : 'Conectar Google';
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
  await initDb();

  initTabs();
  initSyncStatusIndicator();
  initGoogleButton();

  initMembers();
  initRecipes();
  initMealPlanner();
  initStock();
  initShoppingList();
  initTasks();
  initCalendar();
  initDashboard();

  // Login/Calendar/Drive são opcionais — não travam o resto do app se falharem.
  initAuth().catch((e) => console.warn('Google não inicializado:', e));
  initPhotoGallery();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('Service worker falhou:', e));
  }
}

main();
