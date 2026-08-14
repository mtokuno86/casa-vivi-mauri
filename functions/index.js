// ============================================================================
// functions/index.js — Cloud Function "parseRecipe".
//
// Por que isso existe: o navegador não pode buscar o HTML de outro site
// diretamente (bloqueio de CORS), então essa função roda no servidor,
// busca a página da receita e procura pelos dados estruturados
// (schema.org/Recipe) que a maioria dos sites de receita já embute nas
// páginas para aparecer bonito no Google. Retorna um JSON pronto para
// preencher o formulário de receita no app.
//
// Cobertura: funciona na maioria dos sites de receita brasileiros e
// internacionais que seguem o padrão schema.org, mas não em 100% deles —
// alguns não têm esses dados, outros usam formatos não padronizados.
// Quando não encontrar nada, o app cai de volta para o cadastro manual.
// ============================================================================
const { onRequest } = require('firebase-functions/v2/https');

function parseISODuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso.trim());
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const totalMin = days * 24 * 60 + hours * 60 + mins;
  if (!totalMin) return null;
  const h = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (h && mm) return `${h}h${String(mm).padStart(2, '0')}`;
  if (h) return `${h}h`;
  return `${mm} min`;
}

function firstOf(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

// ----------------------------------------------------------------------------
// Detecção/decodificação de charset — corrige acentos e cedilha corrompidos.
//
// `Response.text()` do fetch sempre decodifica como UTF-8, mas vários sites
// de receita brasileiros ainda servem a página em ISO-8859-1/Windows-1252
// (declarado só na tag <meta charset> do HTML, não no header HTTP). Decodificar
// bytes Latin-1 como se fossem UTF-8 é exatamente o que gera "Ã§" no lugar de
// "ç" etc. Por isso lemos os bytes crus e decodificamos com o charset certo.
// ----------------------------------------------------------------------------
function detectCharset(buffer, contentTypeHeader) {
  if (contentTypeHeader) {
    const m = /charset=([^;]+)/i.exec(contentTypeHeader);
    if (m) return m[1].trim().toLowerCase();
  }
  // Os primeiros bytes do HTML sempre podem ser lidos como latin1 sem erro
  // (cobre qualquer valor de byte de 0-255), só pra achar a tag <meta charset>.
  const head = Buffer.from(buffer.slice(0, 4096)).toString('latin1');
  const metaCharset = /<meta[^>]+charset=["']?\s*([a-z0-9\-]+)/i.exec(head);
  if (metaCharset) return metaCharset[1].toLowerCase();
  return 'utf-8';
}

function normalizeCharsetName(name) {
  const n = (name || '').toLowerCase();
  if (n === 'latin1' || n === 'latin-1') return 'iso-8859-1';
  return n;
}

function decodeHtml(buffer, contentTypeHeader) {
  const charset = normalizeCharsetName(detectCharset(buffer, contentTypeHeader));
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (e) {
    // Charset não reconhecido pelo TextDecoder — melhor tentar UTF-8 (o mais
    // comum hoje em dia) do que falhar a importação inteira.
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// ----------------------------------------------------------------------------
// Parser (heurístico) de "2 xícaras de farinha de trigo" -> qty/unit/name.
// Cobre os padrões mais comuns de receitas em português; o que não bater
// nenhum padrão conhecido cai inteiro no campo "name" (nada se perde), e o
// usuário sempre pode ajustar manualmente antes de salvar.
// ----------------------------------------------------------------------------
const UNIT_WORDS = [
  'colher(?:es)? de sopa', 'colher(?:es)? de ch[aá]', 'colher(?:es)? de caf[eé]',
  'x[ií]caras?', 'x[ií]c', 'gramas?', 'quilos?', 'mililitros?', 'litros?',
  'unidades?', 'dentes?', 'fatias?', 'pitadas?', 'copos?', 'latas?', 'pacotes?',
  'kg', 'g', 'ml', 'l', 'un'
];
const UNIT_RE = new RegExp(`^(${UNIT_WORDS.join('|')})\\.?(?=\\s|$)`, 'i');
const FRACTION_CHARS = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅛': '1/8' };

function parseIngredientLine(line) {
  let text = String(line).trim();
  Object.entries(FRACTION_CHARS).forEach(([ch, repl]) => { text = text.split(ch).join(repl); });

  const m = /^(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?)\s*(.*)$/.exec(text);
  if (!m) return { qty: '', unit: '', name: text };

  const qty = m[1].replace(',', '.');
  let rest = m[2].trim();

  const unitMatch = UNIT_RE.exec(rest);
  let unit = '';
  if (unitMatch) {
    unit = unitMatch[0].replace(/\.$/, '').trim();
    rest = rest.slice(unitMatch[0].length).trim();
  }
  rest = rest.replace(/^de\s+/i, '').trim();

  return { qty, unit, name: rest || text };
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch (e) {
      // bloco de JSON malformado ou incompleto — ignora e segue para o próximo
    }
  }
  return blocks;
}

function findRecipeNode(data) {
  const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
  for (const node of nodes) {
    if (!node || !node['@type']) continue;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.includes('Recipe')) return node;
  }
  return null;
}

function extractRecipe(html) {
  for (const block of extractJsonLdBlocks(html)) {
    const recipe = findRecipeNode(block);
    if (recipe) return recipe;
  }
  return null;
}

function instructionsToText(instructions) {
  if (!instructions) return '';
  if (typeof instructions === 'string') return instructions;
  if (Array.isArray(instructions)) {
    return instructions
      .map((step, i) => {
        const text = typeof step === 'string' ? step : (step.text || step.name || '');
        return text ? `${i + 1}. ${text}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

exports.parseRecipe = onRequest({ cors: true, region: 'southamerica-east1' }, async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Passe o link da receita no parâmetro "url".' });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('protocolo inválido');
  } catch (e) {
    res.status(400).json({ error: 'Link inválido.' });
    return;
  }

  try {
    const resp = await fetch(parsedUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CasaVMBot/1.0; +https://mtokuno86.github.io/casa-vivi-mauri/)' },
      redirect: 'follow'
    });
    if (!resp.ok) {
      res.status(502).json({ error: `Não foi possível acessar essa página (HTTP ${resp.status}).` });
      return;
    }
    const rawBytes = await resp.arrayBuffer();
    const html = decodeHtml(rawBytes, resp.headers.get('content-type'));
    const recipe = extractRecipe(html);
    if (!recipe) {
      res.status(404).json({ error: 'Não encontramos dados estruturados de receita nessa página. Cadastre manualmente.' });
      return;
    }

    const ingredients = (recipe.recipeIngredient || recipe.ingredients || [])
      .map((line) => parseIngredientLine(line))
      .filter((i) => i.name);

    res.json({
      title: recipe.name || '',
      image: firstOf(recipe.image?.url || recipe.image) || '',
      prepTime: parseISODuration(recipe.prepTime),
      cookTime: parseISODuration(recipe.cookTime),
      totalTime: parseISODuration(recipe.totalTime),
      yield: firstOf(recipe.recipeYield) || '',
      difficulty: recipe.difficulty || null,
      ingredients,
      instructions: instructionsToText(recipe.recipeInstructions),
      sourceUrl: parsedUrl.toString()
    });
  } catch (e) {
    console.error('Erro ao processar receita:', e);
    res.status(500).json({ error: 'Erro ao processar essa receita. Tente novamente ou cadastre manualmente.' });
  }
});
