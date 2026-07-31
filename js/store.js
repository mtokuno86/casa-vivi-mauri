// ============================================================================
// store.js — pequeno observable em cima de uma coleção do db.js.
// Cada módulo de feature usa isso pra manter uma lista em memória sempre
// atualizada (via Firestore realtime, ou localStorage em modo local) e
// notificar a UI quando mudar.
// ============================================================================
import { watchCollection, addItem, setItem, deleteItem } from './db.js';

export function createStore(collectionName) {
  let list = [];
  const subscribers = new Set();

  watchCollection(collectionName, (items) => {
    list = items;
    subscribers.forEach((cb) => cb(list));
  });

  return {
    get list() { return list; },
    subscribe(cb) {
      subscribers.add(cb);
      cb(list);
      return () => subscribers.delete(cb);
    },
    add(data) { return addItem(collectionName, data); },
    set(id, data) { return setItem(collectionName, id, data); },
    remove(id) { return deleteItem(collectionName, id); },
    getById(id) { return list.find((x) => x.id === id) || null; }
  };
}
