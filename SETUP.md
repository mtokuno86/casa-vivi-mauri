# Setup — Casa Vivi & Mauri

Este app já funciona "no modo local" (só neste aparelho, sem sincronizar) assim que
for publicado numa URL. Para ter sincronização real entre celular e tablet, calendário
do Google e a galeria de fotos, siga os passos abaixo — todos exigem login na sua conta
Google, por isso preciso que você mesmo faça (não consigo fazer por você).

Tempo estimado: 30–45 min na primeira vez, com calma.

---

## 0. Por que preciso publicar numa URL (não basta abrir o arquivo direto)?

O app usa recursos (módulos JS, Service Worker, login Google) que exigem que os
arquivos sejam servidos via `https://` (ou `localhost`), não funcionam abrindo o
`index.html` direto do arquivo no computador. O jeito mais simples é usar o
**Firebase Hosting**, que já faz parte do passo 1 abaixo — um só lugar para tudo.

---

## 1. Criar o projeto Firebase (sincronização entre celular e tablet)

1. Acesse **console.firebase.google.com** e entre com sua conta Google.
2. **Criar projeto** → dê um nome (ex: `casa-vivi-mauri`) → pode desativar o Google
   Analytics (não precisa).
3. No menu lateral, vá em **Build → Firestore Database** → **Criar banco de dados**
   → escolha uma localização (ex: `southamerica-east1` - São Paulo) → inicie em
   **modo de produção**.
4. Em **Regras** (Rules) do Firestore, cole isto por enquanto (acesso liberado só
   pra vocês dois usarem, sem autenticação de usuário complexa):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```
   *(Isso deixa o banco aberto para quem tiver o link do app. Como é uso doméstico
   e a URL não será divulgada, é aceitável por ora. Se depois vocês publicarem para
   outras pessoas usarem, aí sim vale configurar autenticação de verdade.)*
5. No menu de engrenagem (⚙) → **Configurações do projeto** → role até "Seus apps"
   → clique no ícone **`</>`** (Web) → registre um app (ex: `casa-vm-web`) → **não**
   marque "Firebase Hosting" nessa tela ainda.
6. Copie o objeto `firebaseConfig` que aparece (apiKey, authDomain, projectId, etc.)
   e cole em **`js/config.js`**, na constante `firebaseConfig`.

---

## 2. Publicar o app (Firebase Hosting)

No computador, com Node.js instalado:

```bash
npm install -g firebase-tools
firebase login
cd pasta-onde-estao-os-arquivos-do-app
firebase init hosting
```

Durante o `firebase init hosting`:
- Escolha o projeto que você criou no passo 1.
- Diretório público: `.` (a própria pasta, já que os arquivos estão na raiz).
- Configurar como single-page app: **Não**.
- Não sobrescreva `index.html` se perguntar.

Depois:

```bash
firebase deploy
```

Isso te dá uma URL tipo `https://casa-vivi-mauri.web.app` — é essa URL que vocês vão
abrir no celular e no tablet.

*Alternativa sem linha de comando:* subir os arquivos num repositório do GitHub e
ativar o **GitHub Pages** (Settings → Pages) também funciona, mas nesse caso o
Firestore/Firebase continuam sendo configurados à parte, como no passo 1.

---

## 3. Instalar no celular e no tablet

1. Abra a URL do app no **Chrome** do Android.
2. Toque no menu (⋮) → **Adicionar à tela inicial / Instalar aplicativo**.
3. Repita nos dois aparelhos. A partir daí abre como um app normal, em tela cheia.

---

## 4. Google Calendar + Drive (calendário e galeria de fotos)

1. Acesse **console.cloud.google.com**, selecione o **mesmo projeto** criado no
   passo 1 (Firebase e Cloud Console compartilham projetos).
2. **APIs e serviços → Biblioteca** → ative:
   - **Google Calendar API**
   - **Google Drive API**
3. **APIs e serviços → Tela de consentimento OAuth**:
   - Tipo de usuário: **Externo**.
   - Preencha nome do app, e-mail de suporte (o seu).
   - Em **Usuários de teste**, adicione `mtokuno@gmail.com` e o e-mail da Vivi.
     *(Enquanto o app não passa pela verificação do Google, só esses e-mails
     conseguem fazer login — é suficiente para uso doméstico.)*
4. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo de aplicativo: **Aplicativo da Web**.
   - Em **Origens JavaScript autorizadas**, adicione a URL do passo 2
     (ex: `https://casa-vivi-mauri.web.app`).
   - Copie o **Client ID** gerado.
5. **APIs e serviços → Credenciais → Criar credenciais → Chave de API**:
   - Copie a **API Key** gerada (opcional: restrinja para Calendar API + Drive API).
6. Cole os dois valores em **`js/config.js`**: `googleClientId` e `googleApiKey`.

---

## 5. Pasta de fotos no Google Drive (galeria da geladeira)

1. Crie uma pasta no Google Drive (ex: "Fotos Geladeira") e jogue as fotos que
   quiser lá dentro.
2. Abra a pasta no navegador e copie o ID da URL:
   `drive.google.com/drive/folders/`**`ESSE_TRECHO_AQUI`**
3. Cole em `js/config.js`, na constante `photosDriveFolderId`.

Depois de editar `js/config.js`, rode `firebase deploy` de novo para publicar as
mudanças.

---

## 6. Importação de receitas via link (opcional)

Isso liga o botão "Importar de link" no cadastro de receitas: cola um link de
receita e o app tenta preencher sozinho ingredientes, tempo de preparo e
rendimento (quando o site tiver esses dados estruturados — nem todos têm).
Funciona por meio de uma **Cloud Function** (um programinha que roda no
servidor do Google, fora do app) que já vem pronta na pasta `functions/`.

**Requisito importante:** Cloud Functions não roda no plano gratuito (Spark)
do Firebase — precisa fazer upgrade para o plano **Blaze** (pay-as-you-go),
que pede um cartão cadastrado. Para o volume de uso de vocês dois, o custo
real deve ficar em R$ 0 (dentro da cota gratuita mensal), mas o cadastro do
cartão é exigido mesmo assim.

1. No Firebase Console → ⚙ **Uso e faturamento** → faça upgrade para o plano
   **Blaze**.
2. No terminal, na pasta do projeto (a mesma onde rodou `firebase init hosting`):
   ```bash
   firebase init functions
   ```
   - Escolha o mesmo projeto do passo 1.
   - Linguagem: **JavaScript**.
   - Se perguntar se pode sobrescrever `functions/package.json` ou
     `functions/index.js`, responda **Não** — esses arquivos já vieram prontos.
   - Instale as dependências quando perguntado (ou rode `cd functions && npm install` depois).
3. Deploy:
   ```bash
   firebase deploy --only functions
   ```
4. Ao final, o terminal mostra a URL da função, parecida com:
   ```
   https://southamerica-east1-casa-vivi-mauri.cloudfunctions.net/parseRecipe
   ```
5. Cole essa URL em `js/config.js`, na constante `recipeImportFunctionUrl`.
6. Publique de novo (redeploy do hosting, ou reenvie os arquivos alterados no
   GitHub Pages).

Teste: aba **Receitas** → "+ Nova receita" → cole um link de receita no campo
"Importar de um link" → "Importar". Quando o site não tiver os dados
estruturados que a função procura, ela avisa e é só preencher manualmente.

---

## 7. Testando

- Abra o app no celular, toque em **"Conectar Google"** no topo, faça login (vai
  aparecer um aviso de "app não verificado" — é esperado, toque em **Avançado →
  Acessar mesmo assim**, já que vocês estão na lista de usuários de teste).
- Cadastre um ou dois membros da casa (botão "👥 Membros" no topo).
- Cadastre uma receita, monte o cardápio da semana, veja a lista de compras se
  atualizar sozinha.
- Cadastre alguns itens no **Estoque** com um mínimo — veja um deles ficando
  "em falta" e aparecendo na Lista de compras.
- Abra no tablet e confirme que os mesmos dados aparecem (sincronização via
  Firestore).

---

## 8. Publicar depois na Play Store (etapa futura, separada)

Quando estiver satisfeito com o app em uso doméstico, dá para empacotar essa mesma
PWA como um app Android de verdade usando o **Bubblewrap** (ferramenta oficial do
Google para transformar PWA em TWA/Android App Bundle), criar uma conta de
desenvolvedor Google Play (taxa única, ~US$25), preencher ficha da loja, política
de privacidade, e enviar para revisão. Nesse momento também vale revisar as regras
abertas do Firestore (passo 1) para autenticação de verdade, já que outras pessoas
vão poder usar o app.
