// ============================================================================
// db.js — camada de dados. Usa Firestore (sincroniza celular <-> tablet) se
// js/config.js tiver firebaseConfig preenchido; caso contrário cai em modo
// local (localStorage), útil para testar a interface antes do setup.
// ============================================================================
import { firebaseConfig } from './config.js';

let mode = firebaseConfig && firebaseConfig.apiKey ? 'firebase' : 'local';
let firestore = null;
let fsApi = null; // funções modulares do firestore (doc, setDoc, onSnapshot, ...)

const localListeners = {}; // { collectionName: Set(callback) }

export function getMode() {
  return mode;
}

export async function initDb() {
  if (mode !== 'firebase') return;
  try {
    const [{ initializeApp }, fs] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
    ]);
    fsApi = fs;
    const app = initializeApp(firebaseConfig);
    firestore = fs.getFirestore(app);
    // Sobrevive a quedas de conexão wifi e sincroniza quando a rede volta.
    try {
      await fs.enableIndexedDbPersistence(firestore);
    } catch (e) {
      console.warn('Persistência offline não habilitada:', e.message);
    }
  } catch (e) {
    console.error('Falha ao iniciar Firebase, caindo para modo local:', e);
    mode = 'local';
  }
}

function localKey(collectionName) {
  return `casa-vm:${collectionName}`;
}

function localRead(collectionName) {
  try {
    return JSON.parse(localStorage.getItem(localKey(collectionName))) || {};
  } catch (e) {
    return {};
  }
}

function localWrite(collectionName, dataById) {
  localStorage.setItem(localKey(collectionName), JSON.stringify(dataById));
  const listeners = localListeners[collectionName];
  if (listeners) {
    const items = Object.entries(dataById).map(([id, v]) => ({ id, ...v }));
    listeners.forEach((cb) => cb(items));
  }
}

function uid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/**
 * Escuta uma coleção em tempo real.
 * callback recebe um array de { id, ...campos }
 * retorna função de unsubscribe.
 */
export function watchCollection(collectionName, callback) {
  if (mode === 'firebase' && firestore) {
    const colRef = fsApi.collection(firestore, collectionName);
    return fsApi.onSnapshot(colRef, (snap) => {
      const items = [];
      snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
      callback(items);
    }, (err) => console.error(`Erro sincronizando ${collectionName}:`, err));
  }

  // modo local
  if (!localListeners[collectionName]) localListeners[collectionName] = new Set();
  localListeners[collectionName].add(callback);
  // dispara valor inicial
  const initial = localRead(collectionName);
  callback(Object.entries(initial).map(([id, v]) => ({ id, ...v })));

  return () => localListeners[collectionName].delete(callback);
}

/** Cria um documento com id automático. Retorna o id. */
export async function addItem(collectionName, data) {
  if (mode === 'firebase' && firestore) {
    const colRef = fsApi.collection(firestore, collectionName);
    const ref = await fsApi.addDoc(colRef, data);
    return ref.id;
  }
  const all = localRead(collectionName);
  const id = uid();
  all[id] = data;
  localWrite(collectionName, all);
  return id;
}

/** Cria/atualiza um documento com id específico (merge). */
export async function setItem(collectionName, id, data) {
  if (mode === 'firebase' && firestore) {
    const ref = fsApi.doc(firestore, collectionName, id);
    await fsApi.setDoc(ref, data, { merge: true });
    return;
  }
  const all = localRead(collectionName);
  all[id] = { ...(all[id] || {}), ...data };
  localWrite(collectionName, all);
}

export async function deleteItem(collectionName, id) {
  if (mode === 'firebase' && firestore) {
    const ref = fsApi.doc(firestore, collectionName, id);
    await fsApi.deleteDoc(ref);
    return;
  }
  const all = localRead(collectionName);
  delete all[id];
  localWrite(collectionName, all);
}
