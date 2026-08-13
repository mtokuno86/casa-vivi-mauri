// ============================================================================
// recipeFacets.js — taxonomia de filtros (proteína / culinária / utensílios)
// e o "chute" automático desses campos a partir do texto da receita (título,
// ingredientes, modo de preparo). O chute é só um ponto de partida: sempre
// fica editável no formulário, nunca é aplicado sem o usuário poder revisar.
// ============================================================================

export const PROTEINS = [
  'Frango', 'Carne bovina', 'Carne suína', 'Peixe', 'Frutos do mar',
  'Ovo', 'Vegetariano/sem carne', 'Vegano', 'Outra/mista'
];

export const CUISINES = [
  'Brasileira', 'Italiana', 'Japonesa', 'Mexicana', 'Árabe/Mediterrânea',
  'Indiana', 'Chinesa', 'Americana', 'Outra'
];

export const EQUIPMENT_OPTIONS = [
  'Forno', 'Airfryer', 'Liquidificador', 'Batedeira',
  'Panela de pressão', 'Processador', 'Churrasqueira', 'Microondas'
];

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // remove acentos, facilita casar palavra-chave
}

function textBlob(recipe) {
  const ingredientNames = (recipe.ingredients || []).map((i) => i.name || '').join(' ');
  return normalize(`${recipe.title || ''} ${ingredientNames} ${recipe.instructions || ''}`);
}

function firstMatch(haystack, groups) {
  for (const [label, keywords] of groups) {
    if (keywords.some((kw) => haystack.includes(kw))) return label;
  }
  return '';
}

function allMatches(haystack, groups) {
  return groups.filter(([, keywords]) => keywords.some((kw) => haystack.includes(kw))).map(([label]) => label);
}

const PROTEIN_KEYWORDS = [
  ['Frutos do mar', ['camarao', 'lula', 'polvo', 'mexilhao', 'ostra', 'marisco', 'frutos do mar']],
  ['Peixe', ['peixe', 'salmao', 'tilapia', 'atum', 'bacalhau', 'merluza', 'sardinha']],
  ['Frango', ['frango', 'galinha']],
  ['Carne bovina', ['carne bovina', 'carne moida', 'bife', 'patinho', 'alcatra', 'picanha', 'acem', 'costela bovina', 'file mignon', 'carne de panela']],
  ['Carne suína', ['carne suina', 'lombo suino', 'bacon', 'linguica', 'pernil', 'costelinha', 'copa lombo']],
  ['Ovo', ['ovo', 'ovos']]
];

const CUISINE_KEYWORDS = [
  ['Italiana', ['macarrao', 'espaguete', 'penne', 'parmesao', 'molho de tomate', 'manjericao', 'risoto', 'lasanha', 'pizza', 'nhoque']],
  ['Japonesa', ['shoyu', 'miso', 'gohan', 'nori', 'wasabi', 'sushi', 'sashimi', 'panko', 'missô']],
  ['Mexicana', ['tortilla', 'jalapeno', 'guacamole', 'nachos', 'pico de gallo', 'taco', 'burrito']],
  ['Árabe/Mediterrânea', ['homus', 'hummus', 'tahine', 'tahini', 'cuscuz marroquino', 'esfiha', 'quibe', 'pita']],
  ['Indiana', ['curry', 'garam masala', 'curcuma']],
  ['Chinesa', ['molho de ostra', 'chow mein', 'yakisoba']],
  ['Americana', ['hamburguer', 'cheddar', 'barbecue', 'costela ao barbecue']],
  ['Brasileira', ['feijao', 'farinha de mandioca', 'dende', 'acai', 'tapioca', 'pao de queijo', 'feijoada', 'farofa']]
];

const EQUIPMENT_KEYWORDS = [
  ['Forno', ['forno', 'assar', 'asse no forno']],
  ['Airfryer', ['airfryer', 'fritadeira eletrica', 'fritadeira sem oleo']],
  ['Liquidificador', ['liquidificador']],
  ['Batedeira', ['batedeira']],
  ['Panela de pressão', ['panela de pressao']],
  ['Processador', ['processador']],
  ['Churrasqueira', ['churrasqueira', 'carvao', 'na brasa']],
  ['Microondas', ['microondas', 'micro-ondas', 'micro ondas']]
];

/**
 * Sugere proteína/culinária/utensílios a partir do texto da receita.
 * Retorna só o que conseguiu identificar (campos vazios ficam de fora) —
 * quem chama decide se preenche ou deixa em branco pro usuário escolher.
 */
export function guessFacets(recipe) {
  const haystack = textBlob(recipe);
  return {
    protein: firstMatch(haystack, PROTEIN_KEYWORDS),
    cuisine: firstMatch(haystack, CUISINE_KEYWORDS),
    equipment: allMatches(haystack, EQUIPMENT_KEYWORDS)
  };
}
