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

// ----------------------------------------------------------------------------
// DEBUG (17/09/2026): o QR continuava não sendo lido mesmo depois de tentar
// várias resoluções/recortes, sem dar pra saber o motivo à distância. Duas
// suspeitas a descartar:
//  1. Rotação EXIF: fotos de celular guardam a imagem "deitada" internamente
//     e uma tag dizendo "gire ao exibir" — <img>/canvas nem sempre respeitam
//     isso igual em todo navegador, então os recortes (que assumem foto em
//     pé) podiam estar pegando pedaço errado. createImageBitmap com
//     imageOrientation:'from-image' resolve isso de forma mais confiável.
//  2. Não dava pra ver o que o código realmente tentou ler. Agora guardamos
//     uma miniatura de cada tentativa (com resultado) pra mostrar na tela.
// window.__lastQrDebug fica disponível no console pra inspecionar depois.
// ----------------------------------------------------------------------------
async function loadImageFile(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      console.warn('createImageBitmap falhou, usando <img> como fallback:', e);
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function getImageDataAt(img, sx, sy, sw, sh, maxDim) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { imageData: ctx.getImageData(0, 0, canvas.width, canvas.height), canvas };
}

function tryDecodeJsQR(imageData) {
  // "attemptBoth" cobre o caso (raro, mas acontece em fotos com flash/reflexo)
  // de o QR sair com as cores invertidas na captura.
  const r = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
  return r ? r.data : null;
}

// ----------------------------------------------------------------------------
// DEBUG (17/09/2026): comparando as miniaturas de depuração com o leitor de QR
// nativo do Android (que conseguiu ler o mesmo print sem dificuldade), ficou
// claro que o problema não era resolução/recorte/rotação — o QR aparecia
// nítido e grande nas tentativas, mas o jsQR (biblioteca JS "pura", sem
// aceleração/ML) mesmo assim não achava. O Chrome no Android expõe o MESMO
// leitor nativo do sistema (ML Kit do Google) pra páginas web via
// `BarcodeDetector` — muito mais tolerante a reflexo/leve desfoque/baixo
// contraste. Usamos ele como primeira opção; jsQR vira só o plano B pra
// navegadores sem essa API (ex: Safari/iPhone, que ainda não suporta).
// ----------------------------------------------------------------------------
let nativeDetectorPromise;
async function getNativeBarcodeDetector() {
  if (nativeDetectorPromise !== undefined) return nativeDetectorPromise;
  nativeDetectorPromise = (async () => {
    if (!('BarcodeDetector' in window)) return null;
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (!formats.includes('qr_code')) return null;
      return new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch (e) {
      console.warn('[scan] BarcodeDetector nativo indisponível:', e);
      return null;
    }
  })();
  return nativeDetectorPromise;
}

async function tryDecodeNative(detector, canvas) {
  try {
    const codes = await detector.detect(canvas);
    return codes && codes.length ? codes[0].rawValue : null;
  } catch (e) {
    console.warn('[scan] erro no BarcodeDetector nativo:', e);
    return null;
  }
}

/**
 * Tenta achar e decodificar um QR code na foto. Retorna a URL/texto decodificado, ou null se não achar.
 *
 * NOTA (17/09/2026): a primeira versão só testava a foto inteira reduzida
 * pra no máximo 1600px de lado maior. Isso funcionava mal em fotos de nota
 * fiscal inteira (a nota é comprida e o QR code é só um quadradinho no
 * rodapé) — depois de reduzir a foto toda, o QR ficava pequeno demais e sem
 * definição suficiente pra decodificar, mesmo a câmera nativa do celular
 * (que foca e testa continuamente em vídeo, não numa única foto estática)
 * lendo sem problema. Agora tentamos várias "passadas": a imagem inteira em
 * resoluções maiores, e depois pedaços (metade de baixo, cantos) na
 * resolução ORIGINAL da foto, que é onde o QR (normalmente na parte de
 * baixo da nota) aparece com mais nitidez.
 *
 * NOTA 2 (17/09/2026): depois de confirmar via depuração visual que o QR
 * aparecia nítido nas tentativas e mesmo assim não era lido, trocamos pra
 * usar o leitor nativo do navegador (BarcodeDetector/ML Kit) como primeira
 * opção — bem mais tolerante que o jsQR.
 *
 * `debug`, se passado, recebe um array com { label, canvas, found } de cada
 * tentativa — usado só pra mostrar uma prévia visual na tela de "lendo a nota".
 */
async function decodeQrFromImage(img, debug) {
  const nativeDetector = await getNativeBarcodeDetector();
  if (!nativeDetector) await ensureJsQR();
  const w = img.width;
  const h = img.height;
  console.log(`[scan] foto carregada: ${w}x${h}px — leitor: ${nativeDetector ? 'nativo (BarcodeDetector)' : 'jsQR'}`);

  async function attempt(label, sx, sy, sw, sh, maxDim) {
    const { imageData, canvas } = getImageDataAt(img, sx, sy, sw, sh, maxDim);
    const found = nativeDetector ? await tryDecodeNative(nativeDetector, canvas) : tryDecodeJsQR(imageData);
    console.log(`[scan] tentativa "${label}": recorte ${sw}x${sh} → canvas ${canvas.width}x${canvas.height} → ${found ? 'QR ENCONTRADO' : 'nada'}`);
    if (debug) debug.push({ label, canvas, found: !!found });
    return found;
  }

  // 1) Imagem inteira, em algumas resoluções (da maior pra menor: tentar
  //    manter o máximo de detalhe primeiro custa mais processamento, mas o
  //    scan é uma ação pontual disparada pela pessoa, então vale a pena).
  for (const maxDim of [3000, 2200, 1600]) {
    const found = await attempt(`inteira @${maxDim}`, 0, 0, w, h, maxDim);
    if (found) return found;
  }

  // 2) A nota fiscal é comprida e o QR normalmente fica no terço de baixo —
  //    recorta só essa região, em resolução original, pra não perder
  //    definição do QR ao reduzir a foto inteira.
  const crops = [
    { label: 'terço de baixo', sy: Math.round(h * 0.6), sh: Math.round(h * 0.4) },
    { label: 'metade do meio', sy: Math.round(h * 0.4), sh: Math.round(h * 0.4) },
    { label: 'terço de cima', sy: 0, sh: Math.round(h * 0.4) }
  ];
  for (const c of crops) {
    const found = await attempt(c.label, 0, c.sy, w, c.sh, 2400);
    if (found) return found;
  }

  return null;
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

// ----------------------------------------------------------------------------
// DEBUG (17/09/2026, temporário): mostra na tela as miniaturas de cada
// tentativa de leitura de QR, com um selo verde/vermelho, pra dar pra ver (e
// tirar print) exatamente o que o código enxergou — sem isso é impossível
// diagnosticar à distância se o problema é a foto, o recorte ou o próprio QR.
// Pode remover essa função e a chamada dela mais pra frente, quando o scan
// estiver confiável.
// ----------------------------------------------------------------------------
function renderQrDebugPanel(container, attempts) {
  if (!attempts || !attempts.length) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:10px; padding-top:10px; border-top:1px solid #ddd;';
  wrap.innerHTML = '<p class="hint" style="margin-bottom:6px;">Depuração — regiões testadas na foto:</p>';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px;';
  attempts.forEach((a) => {
    const cell = document.createElement('div');
    cell.style.cssText = `border:2px solid ${a.found ? '#3a6351' : '#b3492f'}; border-radius:6px; padding:4px; max-width:140px;`;
    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.7rem; color:#666; margin-bottom:2px;';
    label.textContent = `${a.label}${a.found ? ' ✅' : ''}`;
    a.canvas.style.cssText = 'width:100%; height:auto; display:block;';
    cell.appendChild(label);
    cell.appendChild(a.canvas);
    grid.appendChild(cell);
  });
  wrap.appendChild(grid);
  container.appendChild(wrap);
}

async function handleReceiptPhoto(file) {
  const closeLoading = openModal({
    title: 'Lendo a nota…',
    bodyHtml: `
      <p class="hint" id="scanStatus">Procurando o QR code na foto…</p>
      <div id="scanDebugPanel"></div>
      <div class="modal-actions" id="scanDebugActions" style="display:none;">
        <button type="button" class="btn-primary" id="scanDebugContinueBtn">Continuar</button>
      </div>
    `
  });

  try {
    const img = await loadImageFile(file);
    let result = null;
    let source = 'manual';
    const debugAttempts = [];

    // 1) QR code
    try {
      const qrText = await decodeQrFromImage(img, debugAttempts);

      // Mostra a prévia de depuração e espera a pessoa conferir antes de seguir
      // (só enquanto estamos investigando o problema do QR não ser lido).
      const debugPanel = document.getElementById('scanDebugPanel');
      if (debugPanel) renderQrDebugPanel(debugPanel, debugAttempts);
      if (!qrText) {
        const statusEl = document.getElementById('scanStatus');
        if (statusEl) statusEl.textContent = 'QR code não encontrado em nenhuma das regiões acima.';
        const actions = document.getElementById('scanDebugActions');
        if (actions) {
          actions.style.display = '';
          await new Promise((resolve) => {
            document.getElementById('scanDebugContinueBtn').addEventListener('click', resolve, { once: true });
          });
        }
      }

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

// NOTA (18/09/2026): antes era uma linha de <table> com colunas fixas em
// pixels — no celular ficava tão espremido que só dava pra ver a primeira
// letra do nome do item. Trocado por um "card" por item, empilhando os
// campos em vez de forçar tudo numa linha só; ainda funciona igual no
// desktop, só que com mais respiro.
//
// NOTA (20/09/2026): quando a sugestão automática (findBestStockMatch) não
// achava nada, o dropdown só tinha a opção "criar/ignorar" — sem jeito de
// vincular manualmente a um item que já existe no Estoque mas cujo nome é
// diferente demais da nota pra bater no match automático. Agora o dropdown
// sempre lista TODOS os itens do Estoque (agrupados por ingrediente/casa),
// com a sugestão automática (se houver) já pré-selecionada.
function stockOptionsHtml(selectedKind, selectedId) {
  function optionsFor(list, kind) {
    return [...list]
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .map((it) => `<option value="${kind}:${it.id}" ${kind === selectedKind && it.id === selectedId ? 'selected' : ''}>${escapeHtml(it.name)}</option>`)
      .join('');
  }
  const pantryOpts = optionsFor(pantryStockStore.list, 'pantry');
  const houseOpts = optionsFor(houseStockStore.list, 'house');
  return `
    <option value="">— criar/ignorar —</option>
    ${pantryOpts ? `<optgroup label="Ingredientes">${pantryOpts}</optgroup>` : ''}
    ${houseOpts ? `<optgroup label="Itens da casa">${houseOpts}</optgroup>` : ''}
  `;
}

function itemRowHtml(item, i) {
  const match = item.name ? findBestStockMatch(item.name) : null;
  return `
    <div class="receipt-item-row" data-i="${i}">
      <div class="ri-top">
        <input type="text" class="ri-name" value="${escapeHtml(item.name || '')}" placeholder="Nome do item">
        <button type="button" class="remove-ri" title="Remover item">✕</button>
      </div>
      <div class="ri-fields">
        <label>Qtd<input type="number" step="any" min="0" class="ri-qty" value="${item.qty ?? 1}"></label>
        <label>Un.<input type="text" class="ri-unit" value="${escapeHtml(item.unit || '')}" placeholder="un"></label>
        <label>Preço unit. (R$)<input type="number" step="any" min="0" class="ri-price" value="${item.unitPrice ?? ''}" placeholder="0,00"></label>
      </div>
      <label class="ri-match-label">Vincular ao estoque
        <select class="ri-match">
          ${stockOptionsHtml(match?.kind || null, match?.item?.id || null)}
        </select>
      </label>
    </div>
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
        <div id="receiptItemsBody" class="receipt-items-list" style="margin-top:10px;">
          ${items.map(itemRowHtml).join('')}
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
        const wrap = document.createElement('div');
        wrap.innerHTML = itemRowHtml({ name: '', qty: 1, unit: '', unitPrice: null }, body.children.length);
        const row = wrap.firstElementChild;
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

// ----------------------------------------------------------------------------
// Desfazer a última importação — pedido depois de usar o scanner na prática:
// às vezes só depois de aceitar é que a pessoa percebe que um item deveria
// ter sido vinculado a um item já existente do Estoque (em vez de criar um
// novo), ou que algo saiu errado. Isso remove a compra e seus itens do
// histórico de preços, e desfaz o ajuste de quantidade feito no Estoque na
// hora — sem precisar editar tudo manualmente.
// ----------------------------------------------------------------------------
export function getLastPurchase() {
  const sorted = [...purchasesStore.list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return sorted[0] || null;
}

export async function undoLastPurchase() {
  const last = getLastPurchase();
  if (!last) { window.alert('Nenhuma compra registrada ainda.'); return; }

  const items = purchaseItemsStore.list.filter((i) => i.purchaseId === last.id);
  const resumo = `${last.store || 'Compra sem nome'} — ${last.date || ''} (${items.length} ${items.length === 1 ? 'item' : 'itens'})`;
  const ok = window.confirm(
    `Desfazer a última compra importada?\n\n${resumo}\n\n` +
    `Isso remove a compra e os itens do histórico de preços, e desfaz o ajuste ` +
    `de quantidade feito no Estoque (subtrai o que foi somado). Itens do ` +
    `Estoque criados automaticamente na hora não são apagados — só a ` +
    `quantidade volta atrás.`
  );
  if (!ok) return;

  for (const item of items) {
    if (item.stockItemId && item.stockKind) {
      const s = stockOf(item.stockKind);
      const stockItem = s.getById(item.stockItemId);
      if (stockItem) {
        const nextQty = Math.max(0, (stockItem.qty || 0) - (item.qty || 0));
        await s.set(item.stockItemId, { qty: nextQty });
      }
    }
    await purchaseItemsStore.remove(item.id);
  }
  await purchasesStore.remove(last.id);
  window.alert('Última compra desfeita.');
}

export function initPurchases() {
  const btn = document.getElementById('scanReceiptBtn');
  if (btn) btn.addEventListener('click', startReceiptScan);
}
