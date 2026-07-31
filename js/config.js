// ============================================================================
// CONFIGURAÇÃO - preencha aqui depois de seguir o SETUP.md
// ============================================================================

// --- Firebase (sincronização em tempo real entre celular e tablet) ---
// Deixe tudo como está (campos vazios) para rodar em "modo local" (localStorage),
// só nesse aparelho, sem sincronizar. Preencha para sincronizar de verdade.
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// --- Google OAuth (Calendar + Drive, para calendário e galeria de fotos) ---
// Client ID do tipo "Web application" criado no Google Cloud Console.
export const googleClientId = "";

// Chave de API do Google Cloud (para chamadas de leitura simples).
export const googleApiKey = "";

// ID da pasta do Google Drive com as fotos do dashboard.
// Pegue da URL da pasta: drive.google.com/drive/folders/ESSE_ID_AQUI
export const photosDriveFolderId = "";

// Intervalo de troca de foto no dashboard (ms)
export const photoRotationMs = 12000;

// Nome de exibição da casa (só cosmético)
export const householdName = "Casa Vivi & Mauri";
