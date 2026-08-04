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
    const html = await resp.text();
    const recipe = extractRecipe(html);
    if (!recipe) {
      res.status(404).json({ error: 'Não encontramos dados estruturados de receita nessa página. Cadastre manualmente.' });
      return;
    }

    const ingredients = (recipe.recipeIngredient || recipe.ingredients || [])
      .map((line) => ({ qty: '', unit: '', name: String(line).trim() }))
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
