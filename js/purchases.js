// ============================================================================
// purchases.js — escaneia uma nota fiscal (foto) e registra a compra: itens,
// preços e data, atualizando o Estoque automaticamente. Base do histórico de
// preços usado por priceInsights.js.
//
// Como funciona, em ordem de preferência:
//  1. QR CODE (melhor): a nota fiscal (NFC-e) quase sempre tem um QR code
//     impresso que aponta pro site da Sefaz do estado, com os itens e preços
//     EXATOS. Lemos esse QR direto da foto no navegador (biblioteca jsQR,
//     carregada via CDN só quando necessário) e mandamos a URL pra nossa
//     Cloud Function "parseNfce", que busca a página no servidor (evita
//     bloqueio de CORS) e devolve os itens já estruturados.
//  2. OCR (fallback): se o QR não saiu legível na foto (borrada, mal
//     enquadrada, nota antiga sem QR), manda a foto pra Cloud Function
//     "ocrReceipt" (Cloud Vision) e tenta achar os itens no texto lido.
//     Menos confiável — o resultado sempre pede revisão.
//  3. MANUAL (último caso): tela em branco, a pessoa digita os itens.
//
// Em TODOS os casos, antes de salvar aparece uma tela de revisão — nunca
// grava direto sem a pessoa conferir, porque tanto o QR quanto (principalmente)
// o OCR podem errar nomes/preços.
// ============================================================================
import { createStore } from './store.js';
import { openModal } from './modal.js';
import { parseNfceFunctionUrl, ocrReceiptFunctionUrl } from './config.js';
import { pantryStockStore, houseStockStore, findBestStockMatch, stockOf, normalizeName } from './stock.js';

export const purchasesStore = createStore('purchases');         // { date, store, total, itemCount, source }
export const purchaseItemsStore = createStore('purchaseItems'); // { purchaseId, date, name, normalizedName, categoria, qty, unit, unitPrice, totalPrice, stockItemId, stockKind }

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// jsQR carregado via CDN só na hora de usar (a maioria das visitas ao app
// nunca abre o scanner, não faz sentido carregar isso sempre).
// ----------------------------------------------------------------------------
let jsQRPromise = null;
function ensureJsQR() {
  if (window.jsQR) return Promise.resolve();
  if (jsQRPromise) return jsQRPromise;
  jsQRPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Falha ao carregar leitor de QR code.'));
    document.head.appendChild(s);
  });
  return jsQRPromise;
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/** Tenta achar e decodificar um QR code na foto. Retorna a URL/texto decodificado, ou null se não achar. */
async function decodeQrFromImage(img) {
  await ensureJsQR();
  const canvas = document.createElement('canvas');
  // Reduz um pouco fotos gigantes (celular moderno tira fotos enormes) —
  // acelera o processamento sem perder resolução suficiente pra ler o QR.
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = window.jsQR(imageData.data, imageData.width, imageData.height);
  return result ? result.data : null;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `Erro (HTTP ${resp.status})`);
  return data;
}

/** Ponto de entrada: escolher/tirar uma foto e seguir o fluxo QR → OCR → manual. */
export function startReceiptScan() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    document.body.removeChild(input);
    if (!file) return;
    await handleReceiptPhoto(file);
  });

  input.click();
}

async function handleReceiptPhoto(file) {
  const closeLoading = openModal({
    title: 'Lendo a nota…',
    bodyHtml: `<p class="hint" id="scanStatus">Procurando o QR code na foto…</p>`
  });

  try {
    const img = await loadImageFile(file);
    let result = null;
    let source = 'manual';

    // 1) QR code
    try {
      const qrText = await decodeQrFromImage(img);
      if (qrText && /^https?:\/\//i.test(qrText) && parseNfceFunctionUrl) {
        const statusEl = document.getElementById('scanStatus');
        if (statusEl) statusEl.textContent = 'QR code encontrado — buscando os itens da nota…';
        result = await fetchJson(`${parseNfceFunctionUrl}?url=${encodeURIComponent(qrText)}`);
        source = 'nfce';
      }
    } catch (e) {
      console.warn('Falha lendo QR code / buscando NFC-e:', e);
    }

    // 2) OCR fallback
    if ((!result || !result.items || !result.items.length) && ocrReceiptFunctionUrl) {
      const statusEl = document.getElementById('scanStatus');
      if (statusEl) statusEl.textContent = 'QR code não encontrado — tentando ler o texto da foto…';
      try {
        const imageBase64 = await fileToBase64(file);
        result = await fetchJson(ocrReceiptFunctionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64 })
        });
        source = 'ocr';
      } catch (e) {
        console.warn('Falha no OCR da nota:', e);
      }
    }

    closeLoading();
    openReviewModal(result || { items: [], store: '', date: '', total: null, warning: 'Não foi possível ler a nota automaticamente — preencha os itens manualmente.' }, source);
  } catch (e) {
    closeLoading();
    console.error('Erro processando foto da nota:', e);
    openReviewModal({ items: [], store: '', date: '', total: null, warning: 'Não foi possível processar essa foto — preencha os itens manualmente.' }, 'manual');
  }
}

function parseNfceDateToStr(raw) {
  // "dd/mm/aaaa hh:mm:ss" -> "aaaa-mm-dd"
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(raw || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : todayStr();
}

function itemRowHtml(item, i) {
  const match = item.name ? findBestStockMatch(item.name) : null;
  const matchNote = match
    ? `<option value="${match.kind}:${match.item.id}" selected>↳ ${escapeHtml(match.item.name)} (${match.kind === 'house' ? 'casa' : 'ingrediente'})</option>`
    : '';
  return `
    <tr class="receipt-item-row" data-i="${i}">
      <td><input type="text" class="ri-name" value="${escapeHtml(item.name || '')}" placeholder="Nome do item"></td>
      <td><input type="number" step="any" min="0" class="ri-qty" value="${item.qty ?? 1}" style="width:64px;"></td>
      <td><input type="text" class="ri-unit" value="${escapeHtml(item.unit || '')}" style="width:56px;" placeholder="un"></td>
      <td><input type="number" step="any" min="0" class="ri-price" value="${item.unitPrice ?? ''}" style="width:80px;" placeholder="0,00"></td>
      <td>
        <select class="ri-match">
          <option value="">— criar/ignorar —</option>
          ${matchNote}
        </select>
      </td>
      <td><button type="button" class="remove-ri" style="background:none;border:none;color:#b3492f;">✕</button></td>
    </tr>
  `;
}

function openReviewModal(result, source) {
  const items = (result.items && result.items.length) ? result.items : [{ name: '', qty: 1, unit: '', unitPrice: null }];
  const sourceLabel = { nfce: '✅ Lido do QR code (dados oficiais)', ocr: '📷 Lido por foto (confira com atenção)', manual: '✏️ Preenchimento manual' }[source] || '';

  openModal({
    title: 'Revisar compra',
    bodyHtml: `
      <form id="receiptForm">
        ${result.warning ? `<p class="hint" style="color:#b3492f;">${escapeHtml(result.warning)}</p>` : ''}
        <p class="hint">${sourceLabel}</p>
        <label>Mercado</label>
        <input type="text" name="store" value="${escapeHtml(result.store || '')}" placeholder="Ex: Supermercado ABC">
        <label>Data da compra</label>
        <input type="date" name="date" value="${parseNfceDateToStr(result.date)}">
        <div style="overflow-x:auto; margin-top:10px;">
          <table class="receipt-items-table" style="width:100%; border-collapse:collapse;">
            <thead>
              <tr style="text-align:left; font-size:0.8rem; color:#777;">
                <th>Item</th><th>Qtd</th><th>Un.</th><th>Preço unit. (R$)</th><th>Vincular ao estoque</th><th></th>
              </tr>
            </thead>
            <tbody id="receiptItemsBody">
              ${items.map(itemRowHtml).join('')}
            </tbody>
          </table>
        </div>
        <button type="button" id="addReceiptItemBtn" class="btn-secondary" style="margin-top:8px;">+ Item</button>
        <label style="margin-top:12px; display:flex; align-items:center; gap:6px;">
          <input type="checkbox" name="updateStock" checked style="width:auto;"> Atualizar quantidades no Estoque
        </label>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="cancelReceiptBtn">Cancelar</button>
          <button type="submit" class="btn-primary">Salvar compra</button>
        </div>
      </form>
    `,
    onMount: (modalEl, close) => {
      const body = modalEl.querySelector('#receiptItemsBody');

      function bindRow(row) {
        row.querySelector('.remove-ri').addEventListener('click', () => row.remove());
      }
      body.querySelectorAll('.receipt-item-row').forEach(bindRow);

      modalEl.querySelector('#addReceiptItemBtn').addEventListener('click', () => {
        const div = document.createElement('tbody');
        div.innerHTML = itemRowHtml({ name: '', qty: 1, unit: '', unitPrice: null }, body.children.length);
        const row = div.firstElementChild;
        body.appendChild(row);
        bindRow(row);
      });

      modalEl.querySelector('#cancelReceiptBtn').addEventListener('click', close);

      modalEl.querySelector('#receiptForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const store = fd.get('store').trim();
        const date = fd.get('date') || todayStr();
        const updateStock = fd.get('updateStock') === 'on';

        const rows = [...body.querySelectorAll('.receipt-item-row')];
        const parsedItems = rows.map((row) => {
          const name = row.querySelector('.ri-name').value.trim();
          const qty = Number(row.querySelector('.ri-qty').value) || 0;
          const unit = row.querySelector('.ri-unit').value.trim();
          const unitPrice = row.querySelector('.ri-price').value ? Number(row.querySelector('.ri-price').value) : null;
          const matchVal = row.querySelector('.ri-match').value; // "pantry:id" | "house:id" | ""
          const [matchKind, matchId] = matchVal ? matchVal.split(':') : [null, null];
          return { name, qty, unit, unitPrice, totalPrice: unitPrice != null ? unitPrice * qty : null, matchKind, matchId };
        }).filter((i) => i.name);

        if (!parsedItems.length) { window.alert('Adicione pelo menos um item.'); return; }

        const submitBtn = modalEl.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Salvando…';

        try {
          const total = parsedItems.reduce((sum, i) => sum + (i.totalPrice || 0), 0);
          const purchaseId = await purchasesStore.add({
            date, store, total, itemCount: parsedItems.length, source, createdAt: Date.now()
          });

          for (const item of parsedItems) {
            let stockItemId = item.matchId || null;
            let stockKind = item.matchKind || null;
            let categoria = '';

            if (stockItemId) {
              const existing = stockOf(stockKind).getById(stockItemId);
              categoria = existing?.categoria || '';
            }

            if (updateStock) {
              if (stockItemId) {
                const s = stockOf(stockKind);
                const existing = s.getById(stockItemId);
                if (existing) await s.set(stockItemId, { qty: (existing.qty || 0) + item.qty });
              } else {
                // Sem match — cria um item novo no estoque de ingredientes por
                // padrão (é o caso mais comum pra compras de mercado).
                stockKind = 'pantry';
                stockItemId = await pantryStockStore.add({ name: item.name, qty: item.qty, unit: item.unit, minQty: 0, categoria: '' });
              }
            }

            await purchaseItemsStore.add({
              purchaseId,
              date,
              store,
              name: item.name,
              normalizedName: normalizeName(item.name),
              categoria,
              qty: item.qty,
              unit: item.unit,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              stockItemId,
              stockKind
            });
          }

          close();
        } catch (e) {
          console.error('Erro salvando compra:', e);
          window.alert('Erro ao salvar a compra. Tente novamente.');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Salvar compra';
        }
      });
    }
  });
}

export function initPurchases() {
  const btn = document.getElementById('scanReceiptBtn');
  if (btn) btn.addEventListener('click', startReceiptScan);
}
