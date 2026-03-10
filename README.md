# 🏥 Clínica Insight — Dashboard Kommo

Dashboard de análise comercial em tempo real para clínicas, integrado via OAuth 2.0 com a Kommo CRM.  
Deploy otimizado para **Railway**.

---

## Funcionalidades

- **KPIs em tempo real**: Receita, Leads, Conversão, Ciclo Médio, Ticket Médio
- **Funil de Conversão**: Visualização por etapas do pipeline
- **Análise por Origem**: Comparativo de fontes de leads (campo personalizado)
- **Ranking da Equipe**: Performance por responsável com gráficos
- **Negócios Ganhos**: Tabela com link direto para a Kommo
- **Filtros**: Período, Pipeline, Responsável, Origem
- **Autenticação**: OAuth 2.0 e Long-lived Token

---

## Deploy no Railway

### 1. Criar integração na Kommo

1. Acesse **Configurações → Integrações** na sua conta Kommo
2. Crie uma nova integração privada
3. Copie o **Client ID** e **Client Secret**
4. No campo **Redirect URI**, coloque: `https://SEU-APP.up.railway.app/auth/callback`
   (substitua pelo domínio real após o primeiro deploy)

### 2. Subir para o Railway

**Opção A — Pelo GitHub:**
1. Suba este projeto para um repositório no GitHub
2. No Railway, clique em **New Project → Deploy from GitHub Repo**
3. Selecione o repositório

**Opção B — Via CLI:**
```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

### 3. Configurar variáveis de ambiente

No painel do Railway → seu serviço → aba **Variables**, adicione:

| Variável | Valor |
|---|---|
| `KOMMO_CLIENT_ID` | Client ID da integração Kommo |
| `KOMMO_CLIENT_SECRET` | Client Secret da integração Kommo |
| `KOMMO_REDIRECT_URI` | `https://SEU-APP.up.railway.app/auth/callback` |
| `DB_PATH` | `/app/data/tokens.db` |
| `TZ_OFFSET` | `-03:00` |
| `KOMMO_SOURCE_FIELD_ID` | *(opcional)* ID do campo de origem |

> **PORT** é injetado automaticamente pelo Railway — não precisa definir.

### 4. Adicionar Volume (IMPORTANTE)

O SQLite precisa de persistência. Sem volume, os tokens são perdidos a cada redeploy.

1. No serviço, vá em **Settings → Volumes**
2. Clique **+ Add Volume**
3. Mount Path: `/app/data`
4. Pronto — o banco SQLite fica persistido

### 5. Gerar domínio público

1. No serviço, vá em **Settings → Networking → Public Networking**
2. Clique **Generate Domain** (ou adicione um domínio customizado)
3. Atualize o `KOMMO_REDIRECT_URI` com o domínio gerado
4. Atualize o Redirect URI na integração da Kommo também

### 6. Acessar o Dashboard

Abra o domínio gerado, conecte sua conta Kommo e pronto.

---

## Desenvolvimento Local

```bash
cp .env.example .env
# Preencha as credenciais no .env

npm install
npm run dev
# http://localhost:3000
```

Ou com Docker:
```bash
docker compose up -d --build
```

---

## Estrutura

```
├── railway.json           # Config Railway (Dockerfile builder)
├── Dockerfile             # Build container
├── server.js              # Express + auth + API routes
├── lib/
│   ├── kommo.js           # Cliente API Kommo v4 + dashboard builder
│   └── store.js           # SQLite token store
├── public/
│   └── index.html         # Frontend SPA completo (HTML + CSS + JS)
├── docker-compose.yml     # Dev local
└── .env.example           # Template de variáveis
```

## Campo de Origem

Para ativar a análise por origem dos leads, defina `KOMMO_SOURCE_FIELD_ID` com o ID numérico do campo personalizado que representa a origem na sua conta Kommo. Você encontra o ID em **Configurações → Campos → clique no campo → veja o ID na URL**.
