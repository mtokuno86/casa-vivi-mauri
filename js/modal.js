// ============================================================================
// modal.js — helper genérico de modal, usado por receitas, tarefas, eventos
// e pelo seletor de receita do cardápio.
// ============================================================================

export function openModal({ title, bodyHtml, onMount, onClose }) {
  const root = document.getElementById('modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      <div class="modal-body">${bodyHtml}</div>
    </div>
  `;
  root.appendChild(backdrop);

  function close() {
    backdrop.remove();
    if (onClose) onClose();
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const modalEl = backdrop.querySelector('.modal');
  if (onMount) onMount(modalEl, close);

  return close;
}

export function confirmDialog(message) {
  return window.confirm(message);
}
