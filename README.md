# 🚀 StockOS — Guia de Deploy (Supabase + Vercel)

## Estrutura do Projecto
```
stockos-deploy/
├── api/
│   └── server.js          ← Backend (Node.js + Express)
├── public/
│   └── index.html         ← Frontend ligado à API
├── supabase/
│   └── stockos_database.sql ← Script da base de dados
├── .env.example           ← Modelo das variáveis de ambiente
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

---

## PASSO 1 — Criar conta no GitHub
> O GitHub é necessário para ligar ao Vercel.

1. Aceder a **https://github.com** → **Sign up** → criar conta gratuita
2. Criar novo repositório: **New repository** → nome: `stockos` → **Create**
3. Fazer upload dos ficheiros (botão **Add file → Upload files**)

---

## PASSO 2 — Configurar base de dados no Supabase

1. Aceder a **https://supabase.com** → **Start your project**
2. Criar conta (pode usar Google/GitHub)
3. Clicar **New Project**:
   - **Name**: `stockos`
   - **Database Password**: criar uma senha forte (guardar!)
   - **Region**: `West EU (Ireland)` — mais próximo de Angola
4. Aguardar ~2 minutos enquanto o projecto é criado
5. No menu esquerdo, clicar em **SQL Editor**
6. Clicar **New query**
7. Colar todo o conteúdo do ficheiro `supabase/stockos_database.sql`
8. Clicar **Run** (▶)
9. Verificar que aparece: *"Success. No rows returned"*

### Obter as credenciais:
1. Menu esquerdo → **Settings** → **API**
2. Copiar:
   - **Project URL** → vai para `SUPABASE_URL`
   - **anon public** key → vai para `SUPABASE_ANON_KEY`
3. Menu esquerdo → **Settings** → **Database**
4. Em **Connection string** → seleccionar **URI**
5. Substituir `[YOUR-PASSWORD]` pela senha criada no passo 3
6. Copiar → vai para `DATABASE_URL`

---

## PASSO 3 — Deploy no Vercel

1. Aceder a **https://vercel.com** → **Sign up with GitHub**
2. Clicar **Add New Project**
3. Seleccionar o repositório `stockos`
4. Clicar **Import**
5. Em **Environment Variables**, adicionar uma a uma:

| Nome | Valor |
|------|-------|
| `DATABASE_URL` | `postgresql://postgres:[SENHA]@db.xxx.supabase.co:5432/postgres` |
| `SUPABASE_URL` | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | `eyJ...` |
| `JWT_SECRET` | qualquer texto longo e aleatório |
| `NODE_ENV` | `production` |

6. Clicar **Deploy**
7. Aguardar ~1 minuto
8. Clicar no link gerado (ex: `https://stockos-xxx.vercel.app`) ✅

---

## PASSO 4 — Verificar que tudo funciona

Abrir o URL do Vercel e testar:
- [ ] Dashboard carrega com dados reais
- [ ] Produtos aparecem na lista
- [ ] Alertas de stock aparecem
- [ ] Consegue criar um novo produto

### Testar a API directamente:
```
https://stockos-xxx.vercel.app/api/health
```
Deve responder: `{"status":"ok","versao":"2.1.0"}`

---

## Desenvolvimento Local (opcional)

```bash
# 1. Instalar dependências
npm install

# 2. Criar ficheiro .env
cp .env.example .env
# Editar o .env com as credenciais do Supabase

# 3. Iniciar servidor
npm run dev

# 4. Abrir no browser
# http://localhost:3000
```

---

## Custos

| Serviço | Plano | Custo |
|---------|-------|-------|
| Supabase | Free | **$0/mês** — 500MB BD, backups diários |
| Vercel | Hobby | **$0/mês** — 100GB largura de banda |
| GitHub | Free | **$0/mês** — repositório público |
| **Total** | | **$0/mês** |

> Para produção a crescer, o Supabase Pro custa $25/mês e inclui 8GB de BD.

---

## Suporte

Em caso de problemas, verificar:
1. **Logs do Vercel**: painel → projecto → **Functions** → ver erros
2. **Logs do Supabase**: painel → **Logs** → **API**
3. Confirmar que todas as variáveis de ambiente estão correctas
