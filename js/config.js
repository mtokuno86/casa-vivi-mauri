// ============================================================================
// CONFIGURAÇÃO - preencha aqui depois de seguir o SETUP.md
// ============================================================================

// --- Firebase (sincronização em tempo real entre celular e tablet) ---
// Deixe tudo como está (campos vazios) para rodar em "modo local" (localStorage),
// só nesse aparelho, sem sincronizar. Preencha para sincronizar de verdade.
export const firebaseConfig = {
  apiKey: "AIzaSyDfek3j-3Qtr5TG-OEj6tsqtgnuAHtad60",
  authDomain: "casa-a-casa-504119.firebaseapp.com",
  projectId: "casa-a-casa-504119",
  storageBucket: "casa-a-casa-504119.firebasestorage.app",
  messagingSenderId: "1094300436813",
  appId: "1:1094300436813:web:db3be1938cb062c0600f04"
};

// --- Google OAuth (Calendar + Drive, para calendário e galeria de fotos) ---
// Client ID do tipo "Web application" criado no Google Cloud Console.
export const googleClientId = "1094300436813-4esdk2ubn2hq0vjpb1gflflgh5li8il6.apps.googleusercontent.com";

// Chave de API do Google Cloud (para chamadas de leitura simples).
export const googleApiKey = "AIzaSyD3-D9eTyo69o1H3FQcVTnzrfnb3BRsFkw";

// ID da pasta do Google Drive com as fotos do dashboard.
// Pegue da URL da pasta: drive.google.com/drive/folders/ESSE_ID_AQUI
export const photosDriveFolderId = "148ch_pbMKjeIJjPbrL7OiqDSMcZ5_Uvr";

// Calendários do Google a exibir/editar, além do calendário principal de quem
// está logado ("primary"). Para ver o calendário da Vivi também, ela precisa
// primeiro compartilhar o calendário dela com a conta Google que faz login
// no app (Google Calendar > Configurações > Compartilhar com pessoas
// específicas > adicionar o e-mail, com permissão "Ver todos os detalhes do
// evento"). Depois disso, é só descomentar a linha abaixo:
export const googleCalendarIds = [
  "primary"
  // , "vivianehatano@gmail.com"
];

// Intervalo de troca de foto no dashboard (ms)
export const photoRotationMs = 12000;

// Nome de exibição da casa (só cosmético)
export const householdName = "Casa Vivi & Mauri";

// URL da Cloud Function "parseRecipe" (importação automática de receita via
// link). Depois de fazer o deploy (veja SETUP.md), cole a URL aqui, algo como:
// "https://southamerica-east1-SEU-PROJETO.cloudfunctions.net/parseRecipe"
// Deixe vazio para desativar o botão "Importar de link" (fica só o manual).
export const recipeImportFunctionUrl = "";
