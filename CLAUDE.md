# StockOS — Guia de Configuração para Claude

Este ficheiro serve de referência para sessões futuras. Resume tudo o que foi configurado e como resolver problemas recorrentes.

---

## Repositório

- **GitHub:** `esmeraldofr/stockos`
- **Branch da sessão Claude:** padrão `claude/<nome>-<sessionId>` (auto-merge para `develop`).
- **Branches de ambiente (3 níveis):**
  - `develop` — integração / preview
  - `qualidade` — staging (BD prod read-only)
  - `main` — produção
- **Promoções entre ambientes são MANUAIS** (workflow_dispatch).

---

## Stack

| Componente | Tecnologia |
|---|---|
| Frontend | HTML/CSS/JS estático (`public/`) |
| Backend | Node.js (`api/server.js`) |
| Base de dados | Supabase (PostgreSQL) |
| Deploy | Vercel |
| CI/CD | GitHub Actions |

---

## Plataforma

| Campo | Valor |
|---|---|
| URL | https://stockos-mu.vercel.app |
| URL develop | https://stockos-develop-esmeraldofr.vercel.app (alias fixo actualizado pelo `deploy-dev.yml`; o antigo `stockos-git-develop-…` deixou de existir quando a integração Git da Vercel foi desligada) |

**Contas:** sem seed automático no código. O administrador cria os utilizadores pela UI (Admin → Utilizadores). Se ficares sem nenhum admin activo, reactiva uma conta directamente na BD: `UPDATE utilizadores SET ativo=true WHERE email='…';`.

---

## Workflows GitHub Actions

### 1. `auto-merge-claude.yml` — Auto-merge claude/** → develop (AUTO)

Dispara em cada push para `claude/**`. Faz merge automático para **`develop`** (não para `main`). É o único passo automático do pipeline.

Estratégia:
1. `git push origin develop` directo (precisa de `contents: write`)
2. Fallback para `gh pr merge --admin` se branch protection bloquear

### 2. `promote-to-qualidade.yml` — develop → qualidade (MANUAL)

Apenas `workflow_dispatch`. Tem de ser disparado a mão (ou via PR `develop → qualidade`). Faz `git merge --no-ff origin/develop` em `qualidade` e push.

### 3. `promote-to-main.yml` — qualidade → main (MANUAL)

Apenas `workflow_dispatch`. **Main vem sempre de `qualidade`, nunca directamente de `develop`.** Faz `git merge --no-ff origin/qualidade` em `main`.

### 4. `deploy.yml` — Deploy Vercel produção

Push em `main` → deploy produção via `amondnet/vercel-action@v25`.

Secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

### 5. `deploy-qualidade.yml` — Deploy Vercel qualidade

Push em `qualidade` → preview Vercel num projecto Vercel separado (`VERCEL_PROJECT_ID_QUALIDADE`) com `DATABASE_URL_QUALIDADE` (Postgres prod read-only).

### 6. `deploy-dev.yml` — Deploy Vercel develop

Push em `develop` → preview Vercel para desenvolvimento.

### 7. `setup-db.yml` — Inicialização da BD

Push em `main` ou `workflow_dispatch`. Corre `supabase/stockos_database.sql` se a BD ainda não estiver inicializada. **Não cria utilizadores nem repõe passwords.**

---

## Render (alternativa gratuita, em paralelo com a Vercel)

- `render.yaml` define 3 serviços web (plano free, Frankfurt, `npm install` / `npm start`, health `/api/ping`, autoDeploy):
  - `stockos` — branch `main`, BD de produção (**a funcionar desde 25/10/2026**);
  - `stockos-develop` — branch `develop`, BD de desenvolvimento (`DATABASE_URL_DEV`), `STOCKOS_DEPLOY_TIER=develop`;
  - `stockos-qualidade` — branch `qualidade`, BD de produção só leitura (`DATABASE_URL_QUALIDADE`), `STOCKOS_READ_ONLY=1`.
- A Vercel continua configurada — os dois podem estar activos ao mesmo tempo, contra a mesma BD de produção.
- No Render o servidor detecta o ambiente pelo branch (`RENDER_GIT_BRANCH`: main → production, qualidade → só leitura, develop → develop); `STOCKOS_DEPLOY_TIER=production` também está definido.
- Variáveis a preencher no painel do Render: `DATABASE_URL` (pooler 6543 de produção), `JWT_SECRET`; opcionais `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `MINDEE_API_KEY`.
- Plano free adormece após ~15 min sem pedidos (1.º acesso ~30–60 s). Não conta invocações (a Vercel Hobby suspendeu a conta em 25/10/2026 por limite de utilização — `402 DEPLOYMENT_DISABLED`).

---

## Vercel (`vercel.json`)

```json
{
  "routes": [
    { "src": "/api/(.*)", "dest": "api/server.js" },
    { "src": "/",         "dest": "public/index.html" },
    { "src": "/(.*)",     "dest": "public/$1" }
  ]
}
```

**Importante:** A rota explícita para `/` é obrigatória. Sem ela, aceder à raiz retorna 403.

---

## Fluxo de trabalho

```
claude/session-<id>  ──auto (auto-merge-claude.yml)──▶  develop
                                                          │
                                  manual (PR ou workflow) │
                                                          ▼
                                                       qualidade  (staging, BD prod read-only)
                                                          │
                                  manual (PR ou workflow) │
                                                          ▼
                                                         main  ──▶ produção (deploy.yml)
```

1. Desenvolver em `claude/<nome>-<id>`, fazer push.
2. `auto-merge-claude.yml` mergeia automaticamente para `develop` (único passo automático).
3. Para promover a `qualidade`: PR `develop → qualidade` (merge manual) ou disparar `promote-to-qualidade.yml` no Actions.
4. Para promover a produção: PR `qualidade → main` ou `promote-to-main.yml`. **Nunca fazer PR directo `develop → main`.**
5. Push em `main` → `deploy.yml` faz o deploy para produção automaticamente.

---

## Problemas conhecidos e soluções

| Problema | Causa | Solução |
|---|---|---|
| Auto-merge falha com 403 | `gh pr merge` bloqueado por branch protection | Usar `git push origin develop` directo no workflow |
| Vercel retorna 403 | Rota `/` não definida em `vercel.json` | Adicionar `{ "src": "/", "dest": "public/index.html" }` |
| Push falha com 403 | Branch não começa com `claude/` | Garantir que o branch segue o padrão `claude/<nome>-<sessionId>` |
| BD não inicializada | `setup-db.yml` não correu ou falhou | Correr manualmente via `workflow_dispatch` no GitHub Actions |
| Qualidade desactualizada | Promoção é manual | Disparar `promote-to-qualidade.yml` ou abrir PR `develop → qualidade` |
| Produção desactualizada | Promoção é manual | Disparar `promote-to-main.yml` ou abrir PR `qualidade → main` |
| Vercel `402 DEPLOYMENT_DISABLED` (conta suspensa) | Limite do plano Hobby: muitos pedidos (refresco do turno ~8 pedidos/25 s por aparelho + ping 10 s) e tráfego (foto do TPA base64 em cada `/api/dia`) | Foto fora do `/api/dia` (`SQL_CAIXA_SEM_FOTO`), refresco 60 s, ping 30 s, heartbeat 150 s, tudo parado com a app em segundo plano. Publicar menos vezes (agrupar alterações). Alternativa: Render (`render.yaml`) |

---

## Supabase

- **Project URL:** `https://dakleqewbwbryuchlrzm.supabase.co`
- **Schema SQL:** `supabase/stockos_database.sql`
- **Tabela principal de utilizadores:** `utilizadores`
