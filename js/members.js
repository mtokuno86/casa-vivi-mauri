// ============================================================================
// members.js — membros da casa (lista editável), usados para atribuir
// responsável nas tarefas. Sem login/senha — é só uma lista de nomes
// compartilhada entre os aparelhos.
// ============================================================================
import { createStore } from './store.js';
import { openModal } from './modal.js';

export const membersStore = createStore('members'); // { name }

function renderManageModal() {
  let unsubscribe = null;
  openModal({
    title: 'Membros da casa',
    bodyHtml: `
      <div id="membersListWrap" style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;"></div>
      <form id="addMemberForm" style="display:flex; gap:8px;">
        <input type="text" name="name" placeholder="Nome" required style="flex:1;">
        <button type="submit" class="btn-primary">Adicionar</button>
      </form>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="closeMembersBtn">Fechar</button>
      </div>
    `,
    onMount: (modalEl, close) => {
      const wrap = modalEl.querySelector('#membersListWrap');

      function renderList() {
        const members = membersStore.list;
        wrap.innerHTML = members.length
          ? members.map((m) => `
              <div style="display:flex; align-items:center; gap:8px; background:var(--cream); padding:8px 10px; border-radius:8px;">
                <span style="flex:1;">${m.name}</span>
                <button type="button" class="remove-member" data-id="${m.id}" style="background:none; border:none; color:#b3492f;">✕</button>
              </div>
            `).join('')
          : '<p class="hint">Nenhum membro cadastrado ainda.</p>';

        wrap.querySelectorAll('.remove-member').forEach((btn) => {
          btn.addEventListener('click', () => membersStore.remove(btn.dataset.id));
        });
      }

      unsubscribe = membersStore.subscribe(renderList);

      modalEl.querySelector('#addMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = new FormData(e.target).get('name').trim();
        if (name) {
          await membersStore.add({ name });
          e.target.reset();
        }
      });

      modalEl.querySelector('#closeMembersBtn').addEventListener('click', close);
    },
    onClose: () => {
      if (unsubscribe) unsubscribe();
    }
  });
}

export function initMembers() {
  document.getElementById('membersBtn').addEventListener('click', renderManageModal);
}

/** Opções <option> prontas para selects de responsável (com "Sem responsável" no topo). */
export function memberOptionsHtml(selectedId) {
  const opts = ['<option value="">Sem responsável</option>'];
  membersStore.list.forEach((m) => {
    opts.push(`<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${m.name}</option>`);
  });
  return opts.join('');
}

export function getMemberName(id) {
  if (!id) return null;
  const m = membersStore.getById(id);
  return m ? m.name : null;
}
