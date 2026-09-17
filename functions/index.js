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
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const vision = require('@google-cloud/vision');

admin.initializeApp();

// Segredo do OAuth Client do Google (Cloud Console → Credenciais → o client
// "Web application" que já existe → "Client secret"). NUNCA cole esse valor
// direto no código — configure via terminal com:
//   firebase functions:secrets:set GOOGLE_CLIENT_SECRET
// (veja SETUP.md). Isso guarda o valor no Secret Manager do Google Cloud,
// fora do código-fonte que vai pro GitHub.
const googleClientSecret = defineSecret('GOOGLE_CLIENT_SECRET');

// Esse NÃO é segredo (é o mesmo valor já público em js/config.js como
// googleClientId) — só precisa bater exatamente com aquele.
const GOOGLE_CLIENT_ID = '1094300436813-4esdk2ubn2hq0vjpb1gflflgh5li8il6.apps.googleusercontent.com';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

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

// ----------------------------------------------------------------------------
// Extração aproximada (fallback) para páginas SEM schema.org/Recipe — ex:
// Panelaterapia, que escreve as receitas como texto corrido com listas, sem
// o "cartão de receita" estruturado que o extractRecipe() de cima procura.
//
// Estratégia: acha o primeiro heading (h1-h4) cujo texto contenha
// "ingrediente", e pega a PRÓXIMA lista (<ul> ou <ol>) que aparecer antes do
// heading seguinte — cada <li> dessa lista vira um ingrediente (reaproveita
// o mesmo parseIngredientLine de cima pra separar qtd/unidade/nome). Repete
// a mesma ideia pra "modo de preparo" tentando achar um heading equivalente.
//
// É heurístico e pode falhar em sites com estrutura muito diferente — por
// isso sempre volta pro app com approximate:true, pra deixar claro que
// precisa de mais atenção na revisão do que uma importação via schema.org.
// ----------------------------------------------------------------------------
function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractListItemsAfterHeading(html, headingWordsRe, preferOrdered) {
  const headingRe = new RegExp(`<h[1-4][^>]*>((?:(?!</h[1-4]>)[\\s\\S])*?)<\\/h[1-4]>`, 'gi');
  let hMatch;
  while ((hMatch = headingRe.exec(html)) !== null) {
    const headingText = stripTags(hMatch[1]);
    if (!headingWordsRe.test(headingText)) continue;

    const afterHeading = html.slice(headingRe.lastIndex);
    const nextHeadingIdx = afterHeading.search(/<h[1-4][^>]*>/i);
    const window = nextHeadingIdx === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIdx);

    const tagsInOrder = preferOrdered ? ['ol', 'ul'] : ['ul', 'ol'];
    for (const tag of tagsInOrder) {
      const listRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const listMatch = listRe.exec(window);
      if (!listMatch) continue;
      const items = [];
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liRe.exec(listMatch[1])) !== null) {
        const text = decodeHtmlEntities(stripTags(liMatch[1])).trim();
        if (text) items.push(text);
      }
      if (items.length) return items;
    }
  }
  return [];
}

function extractFallbackTitle(html) {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const text = decodeHtmlEntities(stripTags(h1[1])).trim();
    if (text) return text;
  }
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og) return decodeHtmlEntities(og[1]).trim();
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleTag) return decodeHtmlEntities(stripTags(titleTag[1])).trim();
  return '';
}

const INGREDIENT_HEADING_RE = /ingrediente/i;
const INSTRUCTIONS_HEADING_RE = /modo de preparo|instru[çc][ãa]o|passo a passo|como (fazer|preparar)/i;

// Blogs escrevem listas como frases ("4 filés de frango;", "2 ovos;",
// terminando a última com "."), diferente de um cartão de receita — sem
// isso, esse ";"/"." final sobra grudado no nome do ingrediente/passo.
function stripTrailingPunctuation(text) {
  return String(text).replace(/[;,.]+\s*$/, '').trim();
}

function extractFallbackRecipe(html) {
  const title = extractFallbackTitle(html);
  const ingredientLines = extractListItemsAfterHeading(html, INGREDIENT_HEADING_RE, false);
  const ingredients = ingredientLines
    .map((line) => parseIngredientLine(line))
    .map((i) => ({ ...i, name: stripTrailingPunctuation(i.name) }))
    .filter((i) => i.name);
  const instructionSteps = extractListItemsAfterHeading(html, INSTRUCTIONS_HEADING_RE, true)
    .map(stripTrailingPunctuation);
  const instructions = instructionSteps.length ? instructionsToText(instructionSteps) : '';
  return { title, ingredients, instructions };
}

// ----------------------------------------------------------------------------
// Busca por ingrediente em sites "mapeados" — usada pela tela de Receitas
// para descobrir receitas novas sem depender só da busca (fraca) do Tudo
// Gostoso.
//
// Cobertura: só sites cuja página de resultados de busca já vem pronta no
// HTML (sem depender de JavaScript no navegador) e cujos Termos de Uso não
// proíbem explicitamente coleta automatizada. Testamos vários sites grandes
// (Tudo Gostoso, CyberCook, Receiteria, TudoReceitas, ComidaEReceitas,
// Receitas Nestlé, Panelinha) e nenhum deles devolve resultados via busca
// simples — todos renderizam a lista via JS. Os dois abaixo são blogs
// WordPress e usam o padrão de busca `?s=termo`, comum a esse tipo de site;
// novos blogs do mesmo tipo tendem a funcionar com o mesmo parser, sem
// precisar de código específico por site.
//
// Atenção Panelaterapia: a busca funciona (título + link), mas as páginas
// de receita do Panelaterapia NÃO têm dados estruturados schema.org/Recipe
// (conferido diretamente — a página é só texto corrido com listas, sem o
// bloco de "cartão de receita" que a `parseRecipe` procura). Por isso a
// `parseRecipe` cai no fallback de varredura de texto (ver
// extractFallbackRecipe mais abaixo) pra esse tipo de site: acha a lista
// logo depois de um heading "ingredientes" e usa como ingredientes — é
// aproximado (sem tempo/rendimento/dificuldade, e às vezes sem "modo de
// preparo" também, dependendo de como o site escreveu o texto), então
// sempre volta marcado como approximate:true pro app avisar a pessoa.
// ----------------------------------------------------------------------------
const SEARCH_SITES = {
  panelaterapia: {
    label: 'Panelaterapia',
    searchUrl: (q) => `https://panelaterapia.com/?s=${encodeURIComponent(q)}`
  },
  receitasdemae: {
    label: 'Receitas de Mãe',
    searchUrl: (q) => `https://www.receitasdemae.com.br/?s=${encodeURIComponent(q)}`
  }
};

// Padrão comum a temas WordPress: o título de cada post nos resultados de
// busca fica dentro de um heading (h1-h4) que envolve um único link para a
// página do post — ex: <h3 class="entry-title"><a href="...">Título</a></h3>.
// Como cada busca só lista posts (não itens de menu), isso captura os
// resultados sem precisar saber o nome exato da classe CSS do tema.
const WP_RESULT_RE = /<h[1-4][^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/a>\s*<\/h[1-4]>/gi;

// Links de menu/navegação/rodapé (categorias, tags, páginas institucionais)
// às vezes também caem dentro de um <h1-4>...<a> — esse filtro tira esse
// tipo de resultado, deixando só o que parece post/receita de verdade.
const NON_POST_PATH_RE = /\/(categoria|category|tag|tags|autor|author|page|paged|feed|wp-login|wp-content|wp-admin|cookie-policy|politica-de-cookies|politica-de-privacidade|termos?-de-uso|quem-somos|contato|fale-conosco|sobre)(\/|$|\?)/i;
const NAV_TITLE_RE = /^(in[ií]cio|home|receitas|v[ií]deos|viagens|variedades|sobre|contato|login|menu|buscar|procurar|search|mais recente)$/i;

// Entidades nomeadas mais comuns em português (a maioria dos sites já manda
// o acento como UTF-8 literal depois do decodeHtml() lá em cima, mas alguns
// plugins/editores ainda escrevem como entidade nomeada — sem isso, "&iacute;"
// aparecia literal no texto em vez de virar "í").
const NAMED_ENTITIES = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  acirc: 'â', ecirc: 'ê', ocirc: 'ô', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô',
  atilde: 'ã', otilde: 'õ', Atilde: 'Ã', Otilde: 'Õ',
  ccedil: 'ç', Ccedil: 'Ç', agrave: 'à', Agrave: 'À',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“'
};
const NAMED_ENTITY_RE = new RegExp(`&(${Object.keys(NAMED_ENTITIES).join('|')});`, 'g');

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(NAMED_ENTITY_RE, (_, name) => NAMED_ENTITIES[name])
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// `href` num HTML costuma vir relativo (ex: "/receitas/frango-ao-mel/"), não
// absoluto — resolvemos contra a URL de verdade da página buscada (depois de
// seguir redirects) pra sempre devolver um link completo e clicável.
function extractWpSearchResults(html, siteKey, baseUrl) {
  const results = [];
  const seen = new Set();
  let m;
  WP_RESULT_RE.lastIndex = 0;
  while ((m = WP_RESULT_RE.exec(html)) !== null) {
    const rawHref = m[1];
    const title = decodeHtmlEntities(m[2]).trim();
    if (!rawHref || !title) continue;
    let url;
    try {
      url = new URL(rawHref, baseUrl).toString();
    } catch (e) {
      continue; // href impossível de resolver — ignora esse resultado
    }
    if (seen.has(url)) continue;
    if (NON_POST_PATH_RE.test(url) || NAV_TITLE_RE.test(title)) continue;
    seen.add(url);
    results.push({ site: siteKey, title, url });
    if (results.length >= 8) break; // não precisa de mais que isso por site
  }
  return results;
}

async function searchOneSite(siteKey, query) {
  const site = SEARCH_SITES[siteKey];
  try {
    const searchUrl = site.searchUrl(query);
    const resp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CasaVMBot/1.0; +https://mtokuno86.github.io/casa-vivi-mauri/)' },
      redirect: 'follow'
    });
    if (!resp.ok) return { site: siteKey, label: site.label, results: [], error: `HTTP ${resp.status}` };
    const rawBytes = await resp.arrayBuffer();
    const html = decodeHtml(rawBytes, resp.headers.get('content-type'));
    // resp.url reflete a URL final depois de qualquer redirect — mais
    // confiável que reusar a URL de busca original como base de resolução.
    const baseUrl = resp.url || searchUrl;
    return { site: siteKey, label: site.label, results: extractWpSearchResults(html, siteKey, baseUrl) };
  } catch (e) {
    console.error(`Erro buscando em ${siteKey}:`, e);
    return { site: siteKey, label: site.label, results: [], error: 'Falha ao acessar o site' };
  }
}

exports.searchRecipes = onRequest({ cors: true, region: 'southamerica-east1' }, async (req, res) => {
  const q = req.query.q;
  if (!q || typeof q !== 'string' || !q.trim()) {
    res.status(400).json({ error: 'Passe o ingrediente/termo no parâmetro "q".' });
    return;
  }
  const requestedSite = typeof req.query.site === 'string' ? req.query.site : null;
  const siteKeys = requestedSite && SEARCH_SITES[requestedSite] ? [requestedSite] : Object.keys(SEARCH_SITES);

  const bySite = await Promise.all(siteKeys.map((key) => searchOneSite(key, q.trim())));
  res.json({ query: q.trim(), sites: bySite });
});

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
      // Sem schema.org/Recipe — tenta a varredura de texto (heading
      // "ingredientes" + lista logo abaixo) antes de desistir e mandar pro
      // cadastro 100% manual. Cobre sites como o Panelaterapia, que escreve
      // a receita como texto corrido em vez de usar um cartão estruturado.
      const fallback = extractFallbackRecipe(html);
      if (fallback.ingredients.length || fallback.title) {
        res.json({
          title: fallback.title,
          image: '',
          prepTime: null,
          cookTime: null,
          totalTime: null,
          yield: '',
          difficulty: null,
          ingredients: fallback.ingredients,
          instructions: fallback.instructions,
          sourceUrl: parsedUrl.toString(),
          approximate: true
        });
        return;
      }
      res.status(404).json({ error: 'Não encontramos dados de receita nessa página. Cadastre manualmente.' });
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

// ============================================================================
// Conexão permanente com o Google — 3 funções que, juntas, substituem o
// "renova sozinho por ~1h e depois pede login de novo" por uma conexão que
// dura até a pessoa desconectar de propósito.
//
// Como funciona (visão geral):
//  1. googleOAuthCallback: o navegador abre uma aba de autorização de
//     verdade do Google (uma única vez por aparelho) pedindo acesso
//     "offline" — a resposta inclui um refresh_token, que NUNCA expira por
//     tempo (só se a pessoa revogar, ou ficar 6 meses sem usar, ou o app
//     ficar em modo "Testing" no Google Cloud — daí o 7º passo do SETUP.md
//     de publicar a tela de consentimento). Essa função recebe o código de
//     autorização, troca por tokens, e guarda o refresh_token no Firestore
//     — nunca no navegador, por segurança.
//  2. getGoogleAccessToken: toda vez que o app precisa de um token de
//     acesso válido (a cada ~1h, ou ao abrir o app), chama essa função, que
//     usa o refresh_token guardado pra pedir um novo token curto ao Google.
//     Isso acontece em segundo plano, sem NENHUMA interação — sem popup.
//  3. disconnectGoogle: desconecta de verdade (revoga no Google + apaga o
//     refresh_token do Firestore) — usado quando a pessoa clica pra
//     desconectar, não só quando o token local expira.
//
// IMPORTANTE (segurança): a coleção "googleAuthTokens" no Firestore guarda
// um segredo de verdade (o refresh_token). As regras de segurança do
// Firestore (firestore.rules, fora deste arquivo) precisam bloquear
// qualquer leitura/escrita direta do app nessa coleção — só o Admin SDK
// (essas Cloud Functions) deve acessá-la. Veja o trecho pronto no SETUP.md.
// ============================================================================
const GOOGLE_AUTH_COLLECTION = 'googleAuthTokens';

async function exchangeCodeForTokens(code, redirectUri, clientSecret) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || 'Falha ao trocar código por tokens.');
  return data;
}

async function refreshAccessToken(refreshToken, clientSecret) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(data.error_description || data.error || 'Falha ao renovar token.');
    err.code = data.error;
    throw err;
  }
  return data;
}

function callbackRedirectUri() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'casa-a-casa-504119';
  return `https://southamerica-east1-${projectId}.cloudfunctions.net/googleOAuthCallback`;
}

function oauthResultPage(success, message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Casa Vivi & Mauri</title></head>
<body style="font-family:sans-serif; text-align:center; padding:48px 20px; color:#2b2b28;">
  <h2>${success ? '✅' : '⚠️'} ${message}</h2>
  <p>Pode fechar esta janela.</p>
  <script>setTimeout(function(){ window.close(); }, 1800);</script>
</body></html>`;
}

// Recebe o retorno do Google depois da tela de permissão (redirect_uri) —
// troca o código por tokens e guarda o refresh_token no Firestore, indexado
// pelo "deviceId" que veio de volta no parâmetro "state" (o app manda esse
// id na hora de abrir a autorização, pra saber depois qual aparelho é qual).
exports.googleOAuthCallback = onRequest({ cors: false, region: 'southamerica-east1', secrets: [googleClientSecret] }, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    res.status(400).send(oauthResultPage(false, 'Autorização cancelada ou negada.'));
    return;
  }
  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).send(oauthResultPage(false, 'Requisição inválida.'));
    return;
  }
  try {
    const tokens = await exchangeCodeForTokens(code, callbackRedirectUri(), googleClientSecret.value());
    if (!tokens.refresh_token) {
      res.status(400).send(oauthResultPage(false, 'O Google não retornou um token de renovação. Tente desconectar o app em myaccount.google.com/permissions e conectar de novo.'));
      return;
    }

    let email = null;
    try {
      const uiResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (uiResp.ok) email = (await uiResp.json()).email || null;
    } catch (e) { /* não essencial — só pra identificação na tela, ignora falha */ }

    await admin.firestore().collection(GOOGLE_AUTH_COLLECTION).doc(state).set({
      refreshToken: tokens.refresh_token,
      email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.send(oauthResultPage(true, email ? `Conectado como ${email}.` : 'Conectado!'));
  } catch (e) {
    console.error('Erro no callback OAuth do Google:', e);
    res.status(500).send(oauthResultPage(false, 'Erro ao conectar. Tente novamente.'));
  }
});

// Chamada pelo app toda vez que precisa de um token de acesso válido — usa o
// refresh_token guardado pra pedir um novo ao Google, sem nenhuma interação.
exports.getGoogleAccessToken = onRequest({ cors: true, region: 'southamerica-east1', secrets: [googleClientSecret] }, async (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId || typeof deviceId !== 'string') {
    res.status(400).json({ error: 'Passe o deviceId.' });
    return;
  }
  const docRef = admin.firestore().collection(GOOGLE_AUTH_COLLECTION).doc(deviceId);
  try {
    const doc = await docRef.get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Esse aparelho nunca conectou ao Google (ou já foi desconectado).' });
      return;
    }
    const tokens = await refreshAccessToken(doc.data().refreshToken, googleClientSecret.value());
    res.json({ accessToken: tokens.access_token, expiresIn: tokens.expires_in });
  } catch (e) {
    if (e.code === 'invalid_grant') {
      // Refresh token revogado/expirado de vez — limpa e avisa o app pra
      // pedir reconexão manual (não adianta tentar de novo sozinho).
      await docRef.delete().catch(() => {});
      res.status(401).json({ error: 'Conexão com o Google expirou ou foi revogada — reconecte manualmente.' });
      return;
    }
    console.error('Erro ao renovar token do Google:', e);
    res.status(500).json({ error: 'Erro ao renovar a conexão com o Google.' });
  }
});

// Desconecta de verdade: revoga o token no Google e apaga o refresh_token
// guardado — usado quando a pessoa clica pra desconectar (não é chamada
// quando o token local só "expira" por tempo, ver auth.js).
exports.disconnectGoogle = onRequest({ cors: true, region: 'southamerica-east1' }, async (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId || typeof deviceId !== 'string') {
    res.status(400).json({ error: 'Passe o deviceId.' });
    return;
  }
  try {
    const docRef = admin.firestore().collection(GOOGLE_AUTH_COLLECTION).doc(deviceId);
    const doc = await docRef.get();
    if (doc.exists) {
      const { refreshToken } = doc.data();
      if (refreshToken) {
        await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => {});
      }
      await docRef.delete();
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao desconectar do Google:', e);
    res.status(500).json({ error: 'Erro ao desconectar.' });
  }
});

// ============================================================================
// Escaneamento de nota fiscal (NFC-e) — 2 funções que, juntas, permitem
// registrar uma compra de mercado tirando só uma foto:
//  1. parseNfce: recebe a URL que estava codificada no QR code da nota (o
//     app lê o QR da foto no navegador, com a biblioteca jsQR — ver
//     js/purchases.js) e busca essa URL no site da Sefaz do estado, que
//     devolve os itens comprados com preço exato — sem depender de "ler" a
//     imagem, então é bem mais confiável.
//  2. ocrReceipt: usada só quando o QR não saiu legível na foto — manda a
//     foto pro Cloud Vision (OCR) e tenta achar os mesmos itens no texto
//     reconhecido. Menos precisa, por isso sempre pede revisão antes de
//     salvar.
//
// Por que um parser "de texto" em vez de um parser de HTML fixo: cada estado
// tem seu próprio portal da Sefaz, com HTML bem diferente entre eles — mas o
// padrão visual "Qtde.: X UN: Y Vl. Unit.: Z Vl. Total W" embaixo do nome de
// cada produto é praticamente igual em todo o Brasil (é definido pelo layout
// nacional da NFC-e). Buscar por ESSE padrão de texto, em vez de depender da
// estrutura exata do HTML de um estado, funciona (ou quase) em mais lugares.
// Quando não bater perfeitamente, a pessoa revisa/corrige na tela antes de
// salvar — por isso um resultado parcial já ajuda bastante.
// ============================================================================

function parseBRNumber(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).trim().replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

function stripTagsKeepLines(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|td|span|h[1-6])>/gi, '$&\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const NFCE_QTY_RE = /Qtde\.?:?\s*([\d.,]+)/i;
const NFCE_UNIT_RE = /\bUN:?\s*([A-Za-zÀ-ú]{1,6})\b/i;
const NFCE_UNIT_PRICE_RE = /Vl\.?\s*Unit[áa]?r?i?o?\.?:?\s*([\d.,]+)/i;
const NFCE_TOTAL_ITEM_RE = /Vl\.?\s*(Total|Item)\.?:?\s*([\d.,]+)/i;

/** Acha linhas "Qtde./UN/Vl.Unit./Vl.Total" (padrão nacional da NFC-e) e usa a linha anterior como nome do produto. */
function parseReceiptLines(lines) {
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const qtyMatch = NFCE_QTY_RE.exec(lines[i]);
    if (!qtyMatch) continue;
    const window = [lines[i], lines[i + 1] || '', lines[i + 2] || ''].join(' ');
    const unitMatch = NFCE_UNIT_RE.exec(window);
    const unitPriceMatch = NFCE_UNIT_PRICE_RE.exec(window);
    const totalMatch = NFCE_TOTAL_ITEM_RE.exec(window);
    if (!unitPriceMatch && !totalMatch) continue; // não parece ser mesmo uma linha de item

    let name = '';
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const candidate = lines[j];
      if (candidate && candidate.length > 2 && !/^c[oó]d/i.test(candidate)) { name = candidate; break; }
    }
    if (!name) continue;

    const unitPrice = unitPriceMatch ? parseBRNumber(unitPriceMatch[1]) : null;
    const totalPrice = totalMatch ? parseBRNumber(totalMatch[2]) : null;
    const qty = parseBRNumber(qtyMatch[1]) || 1;
    items.push({
      name: name.replace(/^\d+\s*[-–]\s*/, '').trim(),
      qty,
      unit: unitMatch ? unitMatch[1].toLowerCase() : '',
      unitPrice: unitPrice ?? (totalPrice ? totalPrice / qty : null),
      totalPrice: totalPrice ?? (unitPrice ? unitPrice * qty : null)
    });
  }
  return items;
}

function guessStoreName(lines) {
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const l = lines[i];
    if (l.length > 4 && l.length < 60 && /[A-Za-zÀ-ú]{4,}/.test(l) && !/^\d/.test(l) && !/CNPJ|CPF|DATA|EMISS/i.test(l)) return l;
  }
  return '';
}

function guessDate(lines) {
  const dateRe = /(\d{2}\/\d{2}\/\d{4})\s*(\d{2}:\d{2}:\d{2})?/;
  for (const l of lines) {
    const m = dateRe.exec(l);
    if (m) return m[0];
  }
  return '';
}

function guessTotal(lines) {
  const totalRe = /Valor\s+(a\s+)?[Pp]agar|Valor\s+Total\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (totalRe.test(lines[i])) {
      const m = /([\d.,]+)/.exec(lines[i + 1] || lines[i]);
      if (m) return parseBRNumber(m[1]);
    }
  }
  return null;
}

exports.parseNfce = onRequest({ cors: true, region: 'southamerica-east1' }, async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Passe a URL do QR code da nota no parâmetro "url".' });
    return;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('protocolo inválido');
  } catch (e) {
    res.status(400).json({ error: 'Link do QR code inválido.' });
    return;
  }
  try {
    const resp = await fetch(parsedUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CasaVMBot/1.0)' },
      redirect: 'follow'
    });
    if (!resp.ok) {
      res.status(502).json({ error: `Não foi possível acessar a nota (HTTP ${resp.status}).` });
      return;
    }
    const html = await resp.text();
    const lines = stripTagsKeepLines(html);
    const items = parseReceiptLines(lines);
    res.json({
      store: guessStoreName(lines),
      date: guessDate(lines),
      total: guessTotal(lines),
      items,
      sourceUrl: parsedUrl.toString(),
      warning: items.length ? null : 'Não conseguimos identificar os itens automaticamente nessa nota — confira e preencha manualmente abaixo.'
    });
  } catch (e) {
    console.error('Erro ao ler nota fiscal (NFC-e):', e);
    res.status(500).json({ error: 'Erro ao processar essa nota. Tente novamente ou cadastre manualmente.' });
  }
});

let visionClient = null;
function getVisionClient() {
  if (!visionClient) visionClient = new vision.ImageAnnotatorClient();
  return visionClient;
}

// Fallback por OCR — usado quando o QR code não saiu legível na foto. Exige
// que a API "Cloud Vision" esteja ativada no projeto (veja SETUP.md).
exports.ocrReceipt = onRequest({ cors: true, region: 'southamerica-east1', memory: '512MiB' }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST com { imageBase64 } no corpo.' });
    return;
  }
  const imageBase64 = req.body && req.body.imageBase64;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'Passe a imagem em base64 no campo "imageBase64".' });
    return;
  }
  try {
    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const [result] = await getVisionClient().textDetection({ image: { content: buffer } });
    const fullText = (result.fullTextAnnotation && result.fullTextAnnotation.text) || '';
    if (!fullText) {
      res.json({ items: [], store: '', date: '', total: null, warning: 'Não conseguimos ler texto nessa foto — tente uma foto mais nítida ou cadastre manualmente.' });
      return;
    }
    const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);
    const items = parseReceiptLines(lines);
    res.json({
      store: guessStoreName(lines),
      date: guessDate(lines),
      total: guessTotal(lines),
      items,
      warning: 'Leitura por foto (menos precisa que o QR code) — confira os itens antes de salvar.'
    });
  } catch (e) {
    console.error('Erro no OCR da nota fiscal:', e);
    res.status(500).json({ error: 'Erro ao ler a foto da nota. Confira se a API "Cloud Vision" está ativada no Google Cloud Console (veja SETUP.md), ou cadastre manualmente.' });
  }
});
