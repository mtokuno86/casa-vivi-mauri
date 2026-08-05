// ============================================================================
// members.js — membros da casa (lista editável), usados para atribuir
// responsável nas tarefas. Sem login/senha — é só uma lista de nomes
// compartilhada entre os aparelhos. Evita nomes duplicados e, quando há
// login Google ativo, permite vincular o membro ao e-mail da conta.
// ============================================================================
import { createStore } from './store.js';
import { openModal } from './modal.js';
import { isSignedIn, getUserInfo, onAuthChange } from './auth.js';

export const membersStore = createStore('members'); // { name, email? }

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

function isDuplicateName(name, ignoreId) {
  const key = normalizeName(name);
  return membersStore.list.some((m) => m.id !== ignoreId && normalizeName(m.name) === key);
}

function renderManageModal() {
  let unsubscribe = null;
  let unsubscribeAuth = null;
  let pendingEmail = '';

  openModal({
    title: 'Membros da casa',
    bodyHtml: `
      <div id="membersListWrap" style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;"></div>
      <div id="useGoogleWrap" style="margin-bottom:8px;"></div>
      <form id="addMemberForm" style="display:flex; gap:8px;">
        <input type="text" name="name" placeholder="Nome" required style="flex:1;">
        <button type="submit" class="btn-primary">Adicionar</button>
      </form>
      <div id="addMemberHint" class="hint" style="margin-top:4px;"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="closeMembersBtn">Fechar</button>
      </div>
    `,
    onMount: (modalEl, close) => {
      const wrap = modalEl.querySelector('#membersListWrap');
      const nameInput = modalEl.querySelector('[name="name"]');
      const hint = modalEl.querySelector('#addMemberHint');
      const googleWrap = modalEl.querySelector('#useGoogleWrap');

      function renderList() {
        const members = membersStore.list;
        wrap.innerHTML = members.length
          ? members.map((m) => `
              <div style="display:flex; align-items:center; gap:8px; background:var(--cream); padding:8px 10px; border-radius:8px;">
                <div style="flex:1;">
                  <div>${m.name}</div>
                  ${m.email ? `<div style="font-size:0.72rem; color:#888;">${m.email}</div>` : ''}
                </div>
                <button type="button" class="remove-member" data-id="${m.id}" style="background:none; border:none; color:#b3492f;">✕</button>
              </div>
            `).join('')
          : '<p class="hint">Nenhum membro cadastrado ainda.</p>';

        wrap.querySelectorAll('.remove-member').forEach((btn) => {
          btn.addEventListener('click', () => membersStore.remove(btn.dataset.id));
        });
      }

      function renderGoogleButton() {
        const info = getUserInfo();
        if (isSignedIn() && info?.email) {
          googleWrap.innerHTML = `
            <button type="button" id="useGoogleBtn" class="btn-secondary">
              👤 Usar conta Google conectada (${info.name || info.email})
            </button>
          `;
          googleWrap.querySelector('#useGoogleBtn').addEventListener('click', () => {
            nameInput.value = info.name || info.email;
            pendingEmail = info.email;
          });
        } else {
          googleWrap.innerHTML = '';
        }
      }

      unsubscribe = membersStore.subscribe(renderList);
      unsubscribeAuth = onAuthChange(renderGoogleButton);
      renderGoogleButton();

      // Se o nome digitado deixar de bater com o da conta Google usada,
      // não vincula o e-mail por engano.
      nameInput.addEventListener('input', () => {
        const info = getUserInfo();
        if (!info || nameInput.value.trim() !== (info.name || info.email)) {
          pendingEmail = '';
        }
      });

      modalEl.querySelector('#addMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = new FormData(e.target).get('name').trim();
        if (!name) return;

        if (isDuplicateName(name)) {
          hint.textContent = `Já existe um membro chamado "${name}". Escolha outro nome.`;
          hint.style.color = '#b3492f';
          return;
        }

        await membersStore.add({ name, email: pendingEmail || null });
        pendingEmail = '';
        hint.textContent = '';
        hint.style.color = '';
        e.target.reset();
      });

      modalEl.querySelector('#closeMembersBtn').addEventListener('click', close);
    },
    onClose: () => {
      if (unsubscribe) unsubscribe();
      if (unsubscribeAuth) unsubscribeAuth();
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
