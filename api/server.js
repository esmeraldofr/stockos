require('dotenv').config();
/** Preferir IPv4 ao resolver hosts (ex. Supabase). Evita ENETUNREACH quando só há rota IPv4. */
const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const postgres = require('postgres');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stockos-secret-2025';
const PWD_SALT   = 'stockos-pwd-salt-2025';

const _dbUrlRaw = process.env.DATABASE_URL;
if (!_dbUrlRaw) { console.error('[FATAL] DATABASE_URL não definida'); process.exit(1); }

if (process.env.VERCEL_ENV === 'preview' && /dakleqewbwbryuchlrzm/i.test(_dbUrlRaw)) {
  console.error(
    '[WARN] Preview com ref de produção na DATABASE_URL. Define DATABASE_URL (Preview) na Vercel = secret DATABASE_URL_DEV no GitHub, ou corre o workflow deploy-develop.'
  );
}

/** Log de arranque: host, user e ref (sem password) — confirma em Vercel Logs qual BD está ligada. */
function logStockosDbTarget() {
  try {
    const u = new URL(_dbUrlRaw);
    const host = u.hostname || '';
    const port = u.port || '';
    const user = decodeURIComponent((u.username || '').replace(/\+/g, ' '));
    const m = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    console.log('[StockOS DB target]', {
      VERCEL_ENV: process.env.VERCEL_ENV,
      NODE_ENV: process.env.NODE_ENV,
      host,
      port: port || 'default',
      user,
      directDbRef: m ? m[1] : undefined,
      SUPABASE_PROJECT_REF: process.env.SUPABASE_PROJECT_REF || undefined,
    });
  } catch (e) {
    console.warn('[StockOS DB target] URI inválida:', (e && e.message) || e);
  }
}
logStockosDbTarget();

/**
 * Pooler Supabase :6543 sem ?pgbouncer=true usa Session mode (poucos clientes → MaxClientsInSessionMode).
 * Transaction mode permite muito mais clientes e é o recomendado para serverless.
 */
function normalizeSupabasePoolerUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;
  try {
    const u = new URL(urlStr);
    const host = (u.hostname || '').toLowerCase();
    if (!host.includes('pooler.supabase.com')) return urlStr;
    if (String(u.port || '') !== '6543') return urlStr;
    if (!u.searchParams.has('pgbouncer')) u.searchParams.set('pgbouncer', 'true');
    return u.toString();
  } catch (_) {
    return urlStr;
  }
}

const _dbUrl = normalizeSupabasePoolerUrl(_dbUrlRaw);

/**
 * Poucas ligações por instância (Vercel): cada uma abre slots no Postgres/pooler.
 * max≥2 evita deadlock se houver reserve() + query() em paralelo no mesmo pedido.
 * Sobrescrever com PG_POOL_MAX se necessário.
 */
const _sqlOpts = {
  ssl: 'require',
  prepare: false,
  /** Serverless + pooler em modo transacção: mais slots reduzem filas quando há vários GET em paralelo. */
  max: Math.min(10, Math.max(3, parseInt(process.env.PG_POOL_MAX || '6', 10) || 6)),
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 15
};
let _activeDbUrl = _dbUrl;
/** Instância única do cliente postgres (reutiliza ligações TCP/TLS). */
let _pgSingleton = null;

function withUrlUsername(urlStr, username) {
  const u = new URL(urlStr);
  u.username = username;
  return u.toString();
}

function getDbCandidates() {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  try {
    const u = new URL(_dbUrl);
    const host = (u.hostname || '').toLowerCase();
    const baseUser = decodeURIComponent((u.username || 'postgres').replace(/\+/g, ' '));
    const envRef = (process.env.SUPABASE_PROJECT_REF || '').replace(/[^a-z0-9]/gi, '');
    let ref = null;
    const mDb = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    if (mDb) ref = mDb[1];
    if (!ref && envRef) ref = envRef;

    // URI já aponta ao pooler partilhado mas user sem ".<ref>" → "Tenant or user not found"
    if (host.includes('pooler.supabase.com') && ref && !baseUser.includes('.')) {
      push(normalizeSupabasePoolerUrl(withUrlUsername(_dbUrl, `${baseUser}.${ref}`)));
      if (baseUser !== 'postgres') {
        push(normalizeSupabasePoolerUrl(withUrlUsername(_dbUrl, `postgres.${ref}`)));
      }
    }

    if (mDb) {
      const r = mDb[1];
      const users = new Set([baseUser, `${baseUser}.${r}`, `postgres.${r}`]);
      const fromEnv = (process.env.SUPABASE_POOLER_HOST || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const poolerHosts =
        fromEnv.length > 0
          ? fromEnv
          : [
              'aws-0-eu-west-1.pooler.supabase.com',
              'aws-1-eu-west-1.pooler.supabase.com',
            ];
      for (const poolerHost of poolerHosts) {
        for (const usr of users) {
          const pooler = new URL(_dbUrl);
          pooler.hostname = poolerHost;
          pooler.port = '6543';
          pooler.username = usr;
          push(normalizeSupabasePoolerUrl(pooler.toString()));
        }
      }
    }
  } catch (_) {}
  /** Preferir pooler em modo transacção primeiro (evita Session mode). */
  push(normalizeSupabasePoolerUrl(_dbUrl));
  push(_dbUrl);
  return out;
}

async function resetPgSingleton() {
  const s = _pgSingleton;
  _pgSingleton = null;
  if (s) await s.end({ timeout: 5 }).catch(() => {});
}

/** Garante uma ligação persistente; tenta URLs candidatas só até a primeira funcionar. */
async function ensurePgSingleton() {
  if (_pgSingleton) return _pgSingleton;
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const url of getDbCandidates()) {
      let sqlConn = null;
      try {
        sqlConn = postgres(url, _sqlOpts);
        await sqlConn`SELECT 1`;
        _pgSingleton = sqlConn;
        _activeDbUrl = url;
        return _pgSingleton;
      } catch (e) {
        lastErr = e;
        try { await sqlConn?.end({ timeout: 2 }).catch(() => {}); } catch (_) {}
      }
    }
    if (round === 0) await new Promise((r) => setTimeout(r, 120));
  }
  throw lastErr;
}

const query = async (text, params) => {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sql = await ensurePgSingleton();
      const rows = await sql.unsafe(text, params || []);
      return { rows: Array.from(rows) };
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const transient =
        attempt === 0 &&
        (/ECONNRESET|ECONNREFUSED|ENETUNREACH|Connection|terminated|closed|socket|timeout|53300|57P01|57P02|57P03|MaxClientsInSessionMode|pool_size/i.test(msg) ||
          e.code === 'ECONNRESET' ||
          e.code === 'ENETUNREACH');
      if (transient) {
        await resetPgSingleton();
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
};

const pool = {
  query,
  connect: async () => {
    const sql = await ensurePgSingleton();
    const reserved = await sql.reserve();
    return {
      query: async (text, params) => {
        const rows = await reserved.unsafe(text, params || []);
        return { rows: Array.from(rows) };
      },
      release: async () => {
        await reserved.release().catch(() => {});
      }
    };
  }
};

/** Evita correr a migração de depósitos em cada pedido (scan completo à BD). */
let depositosSaidasMigrationDone = false;
/** ALTER/enum de utilizadores só na primeira vez por processo. */
let usernameColumnEnsured = false;

async function qry(sql, params, label) {
  try { await query(sql, params); }
  catch(e) { console.error(`[initDB:${label}]`, e.message); }
}

/** Índices leves (IF NOT EXISTS) — aceleram /dia, escala. Corre após init. */
async function ensureStockosPerfIndexes() {
  const stmts = [
    'CREATE INDEX IF NOT EXISTS idx_turnos_data ON turnos (data)',
    'CREATE INDEX IF NOT EXISTS idx_turno_stock_turno_id ON turno_stock (turno_id)',
    'CREATE INDEX IF NOT EXISTS idx_turno_stock_turno_prod ON turno_stock (turno_id, produto_id)',
    'CREATE INDEX IF NOT EXISTS idx_turno_vendas_turno_id ON turno_vendas (turno_id)',
    'CREATE INDEX IF NOT EXISTS idx_turno_caixa_turno_id ON turno_caixa (turno_id)',
    'CREATE INDEX IF NOT EXISTS idx_escala_data ON escala (data)'
  ];
  for (let i = 0; i < stmts.length; i++) {
    try {
      await query(stmts[i]);
    } catch (e) {
      console.warn('[idx]', i, (e && e.message) || e);
    }
  }
}

let resolveLoginReady;
let rejectLoginReady;
/** Resolve quando login pode fazer SELECT em utilizadores (antes do resto do initDB acabar). */
const dbLoginReady = new Promise((resolve, reject) => {
  resolveLoginReady = resolve;
  rejectLoginReady = reject;
});
let loginReadyResolved = false;
function markLoginReady() {
  if (!loginReadyResolved) {
    loginReadyResolved = true;
    resolveLoginReady();
  }
}

let resolveDbReady;
let rejectDbReady;
let dbReadyResolved = false;
/** Resolve quando GET /api/dia, escala, produtos podem correr (antes de seed/dedup pesados). */
const dbReady = new Promise((resolve, reject) => {
  resolveDbReady = resolve;
  rejectDbReady = reject;
});
function markDbReady() {
  if (!dbReadyResolved) {
    dbReadyResolved = true;
    resolveDbReady();
  }
}

/**
 * Quando bate com o valor em stockos_meta.bootstrap, initDB só confirma o enum «compras» (1–2 queries).
 * Subir este valor sempre que adicionares migrações em initDB() para forçar um arranque completo uma vez.
 */
const STOCKOS_BOOTSTRAP_VERSION = '2026-04-01-pedidos-tbl';

async function initDB() {
  await qry(`CREATE TABLE IF NOT EXISTS stockos_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`, [], 'stockos_meta');
  try {
    const chk = await query(`SELECT v FROM stockos_meta WHERE k = $1`, ['bootstrap']);
    if (chk.rows.length && chk.rows[0].v === STOCKOS_BOOTSTRAP_VERSION) {
      /** Login só precisa de SELECT em utilizadores — não esperar pelo DO/ALTER do enum «compras». */
      markLoginReady();
      await ensureRoleEnumCompras();
      await ensurePrecosVendasSnapshots();
      try {
        await ensureTurnoPedidos();
      } catch (e) {
        console.error('[initDB] ensureTurnoPedidos (bootstrap skip):', e && e.message, e && e.stack);
      }
      markDbReady();
      console.log('DB ready (bootstrap skip)');
      return;
    }
  } catch (e) {
    console.warn('[initDB] bootstrap check:', e && e.message);
  }

  await qry(`CREATE TABLE IF NOT EXISTS utilizadores (
    id SERIAL PRIMARY KEY, nome VARCHAR(150) NOT NULL, email VARCHAR(200) NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL DEFAULT '', role VARCHAR(20) NOT NULL DEFAULT 'operador',
    ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'utilizadores');
  await qry(
    `INSERT INTO utilizadores (nome,email,senha_hash,role) VALUES ('Admin','admin@stockos.ao',$1,'admin') ON CONFLICT (email) DO UPDATE SET senha_hash=$1`,
    [hashPassword('admin123')],
    'admin-early'
  );
  markLoginReady();
  await qry(`CREATE TABLE IF NOT EXISTS produtos (
    id SERIAL PRIMARY KEY, nome VARCHAR(200) NOT NULL, preco NUMERIC(15,2) NOT NULL DEFAULT 0,
    categoria VARCHAR(20) NOT NULL DEFAULT 'outro', ordem INTEGER NOT NULL DEFAULT 0, ativo BOOLEAN NOT NULL DEFAULT TRUE,
    tipo_medicao VARCHAR(10) NOT NULL DEFAULT 'unidade' CHECK (tipo_medicao IN ('unidade','peso'))
  )`, [], 'produtos');
  await qry(`CREATE TABLE IF NOT EXISTS turnos (
    id SERIAL PRIMARY KEY, data DATE NOT NULL DEFAULT CURRENT_DATE, nome VARCHAR(10) NOT NULL CHECK (nome IN ('manha','tarde','noite')),
    utilizador_id INTEGER REFERENCES utilizadores(id) ON DELETE SET NULL,
    estado VARCHAR(10) NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto','fechado')),
    notas TEXT NOT NULL DEFAULT '', criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), fechado_em TIMESTAMPTZ, UNIQUE(data, nome)
  )`, [], 'turnos');
  await qry(`CREATE TABLE IF NOT EXISTS turno_stock (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    encontrado NUMERIC(10,3), entrada NUMERIC(10,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(10,3), fechados NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id, produto_id)
  )`, [], 'turno_stock');
  await qry(`ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS fechados NUMERIC(10,3) NOT NULL DEFAULT 0`, [], 'turno_stock-fechados');
  await qry(`CREATE TABLE IF NOT EXISTS turno_caixa (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
    tpa NUMERIC(15,2), transferencia NUMERIC(15,2), dinheiro NUMERIC(15,2),
    saida NUMERIC(15,2) NOT NULL DEFAULT 0
  )`, [], 'turno_caixa');
  await qry(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS venda_avulso BOOLEAN NOT NULL DEFAULT FALSE`, [], 'alter-venda-avulso');
  await qry(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tipo_medicao VARCHAR(10) NOT NULL DEFAULT 'unidade'`, [], 'alter-tipo-medicao');
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS em_stock_turno BOOLEAN NOT NULL DEFAULT TRUE`,
    [],
    'produtos-em-stock-turno'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS venda_por_copo BOOLEAN NOT NULL DEFAULT FALSE`,
    [],
    'produtos-venda-copo'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS kg_por_copo NUMERIC(10,4) NOT NULL DEFAULT 0`,
    [],
    'produtos-kg-copo'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_copos_pacote NUMERIC(15,2) NOT NULL DEFAULT 0`,
    [],
    'produtos-preco-pacote-copo'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS qtd_copos_pacote INTEGER NOT NULL DEFAULT 0`,
    [],
    'produtos-qtd-pacote-copo'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_tara_kg NUMERIC(10,3) NOT NULL DEFAULT 0`,
    [],
    'produtos-peso-tara-kg'
  );
  await qry(
    `UPDATE produtos SET venda_por_copo=true, kg_por_copo=0.27, preco=400, preco_copos_pacote=1000, qtd_copos_pacote=3, tipo_medicao='peso'
     WHERE LOWER(TRIM(nome))='fino' AND categoria='bebida' AND COALESCE(kg_por_copo,0)=0`,
    [],
    'produtos-seed-fino-copo'
  );
  await qry(
    `UPDATE produtos SET peso_tara_kg = 12.9 WHERE LOWER(TRIM(nome)) = 'fino barril'`,
    [],
    'produtos-seed-fino-barril-tara'
  );
  await qry(
    `UPDATE produtos SET em_stock_turno = false WHERE categoria = 'outro'`,
    [],
    'produtos-outro-sem-folha-stock'
  );
  /** Sem ALTER em utilizadores aqui: em BD restaurada o role da app não é owner → must be owner. criado_em já está no CREATE TABLE acima. */
  await qry(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`, [], 'alter-notas');
  await qry(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`, [], 'alter-criado');
  await qry(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS fechado_em TIMESTAMPTZ`, [], 'alter-fechado');
  await qry(`CREATE TABLE IF NOT EXISTS receitas (
    id SERIAL PRIMARY KEY,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    componente_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    quantidade NUMERIC(10,3) NOT NULL DEFAULT 1,
    UNIQUE(produto_id, componente_id)
  )`, [], 'receitas');
  await qry(`CREATE TABLE IF NOT EXISTS turno_vendas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    quantidade NUMERIC(10,3) NOT NULL DEFAULT 0,
    UNIQUE(turno_id, produto_id)
  )`, [], 'turno_vendas');
  await qry(`CREATE TABLE IF NOT EXISTS turno_entradas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    tipo VARCHAR(10) NOT NULL DEFAULT 'entrada' CHECK (tipo IN ('entrada','tirar')),
    origem VARCHAR(10) NOT NULL DEFAULT 'armazem' CHECK (origem IN ('armazem','compra')),
    preco NUMERIC(15,2) NOT NULL DEFAULT 0,
    quantidade NUMERIC(10,3) NOT NULL DEFAULT 0,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'turno_entradas');
  await qry(`ALTER TABLE turno_entradas ADD COLUMN IF NOT EXISTS tipo VARCHAR(10) NOT NULL DEFAULT 'entrada'`, [], 'turno_entradas-tipo');
  await qry(`ALTER TABLE turno_entradas ADD COLUMN IF NOT EXISTS origem VARCHAR(10) NOT NULL DEFAULT 'armazem'`, [], 'turno_entradas-origem');
  await qry(`ALTER TABLE turno_entradas ADD COLUMN IF NOT EXISTS preco NUMERIC(15,2) NOT NULL DEFAULT 0`, [], 'turno_entradas-preco');
  await qry(`CREATE TABLE IF NOT EXISTS turno_saidas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL DEFAULT '',
    valor NUMERIC(15,2) NOT NULL DEFAULT 0,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'turno_saidas');
  await qry(`CREATE TABLE IF NOT EXISTS armazem_stock (
    id SERIAL PRIMARY KEY,
    produto_id INTEGER NOT NULL UNIQUE REFERENCES produtos(id) ON DELETE CASCADE,
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
    custo_medio NUMERIC(15,2) NOT NULL DEFAULT 0,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'armazem_stock');
  await qry(`CREATE TABLE IF NOT EXISTS armazem_compras (
    id SERIAL PRIMARY KEY,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
    caixas NUMERIC(12,3) NOT NULL DEFAULT 0,
    qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0,
    preco_unitario NUMERIC(15,2) NOT NULL DEFAULT 0,
    valor_total NUMERIC(15,2) NOT NULL DEFAULT 0,
    fornecedor TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    criado_por TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'armazem_compras');
  await qry(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS caixas NUMERIC(12,3) NOT NULL DEFAULT 0`, [], 'armazem_compras-caixas');
  await qry(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0`, [], 'armazem_compras-qtd-caixa');
  await qry(`CREATE TABLE IF NOT EXISTS armazem_inventario_diario (
    id SERIAL PRIMARY KEY,
    data DATE NOT NULL,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    encontrado NUMERIC(12,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(12,3) NOT NULL DEFAULT 0,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(data, produto_id)
  )`, [], 'armazem_inventario_diario');
  await qry(`CREATE TABLE IF NOT EXISTS armazem_faturas (
    id SERIAL PRIMARY KEY,
    numero_fatura TEXT NOT NULL DEFAULT '',
    fornecedor TEXT NOT NULL DEFAULT '',
    data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
    notas TEXT NOT NULL DEFAULT '',
    total_valor NUMERIC(15,2) NOT NULL DEFAULT 0,
    criado_por TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'armazem_faturas');
  await qry(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS fatura_id INTEGER REFERENCES armazem_faturas(id) ON DELETE SET NULL`, [], 'armazem_compras-fatura');
  await qry(`CREATE TABLE IF NOT EXISTS escala (
    id SERIAL PRIMARY KEY,
    data DATE NOT NULL,
    turno VARCHAR(10) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
    utilizador_id TEXT,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(data, turno, utilizador_id)
  )`, [], 'escala');
  await qry(`CREATE TABLE IF NOT EXISTS escala_template (
    id SERIAL PRIMARY KEY,
    dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
    turno VARCHAR(10) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
    utilizador_id TEXT,
    notas TEXT NOT NULL DEFAULT '',
    UNIQUE(dia_semana, turno, utilizador_id)
  )`, [], 'escala_template');
  await qry(`CREATE TABLE IF NOT EXISTS turno_equipa_real (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    utilizador_id TEXT NOT NULL,
    cobrindo_utilizador_id TEXT,
    hora_extra BOOLEAN NOT NULL DEFAULT FALSE,
    motivo_falta TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(turno_id, utilizador_id)
  )`, [], 'turno_equipa_real');
  await qry(`CREATE TABLE IF NOT EXISTS turno_faltas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    utilizador_id TEXT NOT NULL,
    motivo_falta TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(turno_id, utilizador_id)
  )`, [], 'turno_faltas');
  await qry(`ALTER TABLE escala ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`, [], 'escala-userid-text');
  await qry(`ALTER TABLE escala DROP CONSTRAINT IF EXISTS escala_data_turno_key`, [], 'escala-drop-unique-old');
  await qry(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='escala_data_turno_utilizador_key') THEN ALTER TABLE escala ADD CONSTRAINT escala_data_turno_utilizador_key UNIQUE (data, turno, utilizador_id); END IF; END $$`, [], 'escala-add-unique-new');
  await qry(`ALTER TABLE escala_template ALTER COLUMN utilizador_id DROP NOT NULL`, [], 'escala_template-nullable-user');
  await qry(`ALTER TABLE escala_template ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`, [], 'escala_template-userid-text');
  await qry(`ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`, [], 'escala_template-notas');
  await qry(`ALTER TABLE turno_equipa_real ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`, [], 'turno_equipa_real-userid-text');
  await qry(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS cobrindo_utilizador_id TEXT`, [], 'turno_equipa_real-cobrindo');
  await qry(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS hora_extra BOOLEAN NOT NULL DEFAULT FALSE`, [], 'turno_equipa_real-hora-extra');
  await qry(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS motivo_falta TEXT NOT NULL DEFAULT ''`, [], 'turno_equipa_real-motivo-falta');
  await qry(`ALTER TABLE turno_faltas ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`, [], 'turno_faltas-userid-text');
  await qry(`ALTER TABLE escala_template DROP CONSTRAINT IF EXISTS escala_template_dia_semana_turno_key`, [], 'escala_template-drop-unique-old');
  await qry(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='escala_template_dia_turno_utilizador_key') THEN ALTER TABLE escala_template ADD CONSTRAINT escala_template_dia_turno_utilizador_key UNIQUE (dia_semana, turno, utilizador_id); END IF; END $$`, [], 'escala_template-add-unique-new');
  await qry(`ALTER TABLE escala ADD COLUMN IF NOT EXISTS area_trabalho SMALLINT`, [], 'escala-area-trabalho');
  await qry(`ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS area_trabalho SMALLINT`, [], 'escala_template-area-trabalho');
  /** /dia e preços: ensurePrecosVendasSnapshots antes de markDbReady; se a tabela não existir, leituras usam só produtos.preco. */
  await ensureRoleEnumCompras();
  await ensurePrecosVendasSnapshots();
  try {
    await ensureTurnoPedidos();
  } catch (e) {
    console.error('[initDB] ensureTurnoPedidos (full init):', e && e.message, e && e.stack);
  }
  /** Dedup/seed abaixo podem correr em paralelo com tráfego; schema crítico para /dia já está garantido. */
  markDbReady();
  // Remover duplicados de produtos (manter o de menor id por nome)
  await qry(`DELETE FROM produtos WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY nome ORDER BY id::text) AS rn FROM produtos) sub WHERE rn > 1)`, [], 'produtos-dedup');
  // Garantir constraint única no nome
  await qry(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='produtos_nome_key') THEN ALTER TABLE produtos ADD CONSTRAINT produtos_nome_key UNIQUE (nome); END IF; END $$`, [], 'produtos-unique');
  await qry(`INSERT INTO produtos (nome,preco,categoria,ordem) VALUES
    ('Carne',0,'ingredientes',1),('Ovo',0,'ingredientes',2),('Enchido',0,'ingredientes',3),('Pão 12',0,'ingredientes',4),
    ('Pão 6',0,'ingredientes',5),('Batata Palha',0,'ingredientes',6),('Malonese',0,'ingredientes',7),('Mostarda',0,'ingredientes',8),
    ('Ketchup',0,'ingredientes',9),('Milho',0,'ingredientes',10),('Óleo',0,'ingredientes',11),('Molho Inglês',0,'ingredientes',12),
    ('Nata',0,'ingredientes',13),('Papel Alumínio',0,'ingredientes',14),('Saco',0,'ingredientes',15),('Palito',0,'ingredientes',16),
    ('Guardanapos',0,'ingredientes',17),('Batata Pré-frita',0,'ingredientes',18),
    ('Água Pequena',200,'bebida',19),('Smirnoff',1000,'bebida',20),('Gin Gordons Lata',1000,'bebida',21),
    ('Coca Cola Lata',700,'bebida',22),('Speed Lata',1000,'bebida',23),('Blue Laranja Lata',700,'bebida',24),
    ('Sprite Lata',700,'bebida',25),('Blue Limão Lata',700,'bebida',26),('Eka',700,'bebida',27),
    ('Booster',700,'bebida',28),('Booster Morango',700,'bebida',29),('Booster Manga',700,'bebida',30),
    ('Compal Lata',700,'bebida',31),('Sumol Ananas',700,'bebida',32),('Sumol Laranja',700,'bebida',33),
    ('Sumol Manga',700,'bebida',34),('Cuca Lata',700,'bebida',35),('Nocal Lata',700,'bebida',36),('Dopel',700,'bebida',37)
    ON CONFLICT (nome) DO NOTHING`, [], 'produtos-seed');
  await qry(`UPDATE produtos SET venda_avulso=true, preco=1000 WHERE nome='Batata Pré-frita'`, [], 'batata-avulso');
  await qry(
    `INSERT INTO stockos_meta (k,v) VALUES ('bootstrap', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [STOCKOS_BOOTSTRAP_VERSION],
    'meta-bootstrap'
  );
  console.log('DB ready');
}
initDB()
  .then(() => {
    markDbReady();
    return ensureStockosPerfIndexes();
  })
  .then(async () => {
    try {
      await ensureTurnoPedidos();
    } catch (e) {
      console.error('[ensureTurnoPedidos post-init]', e && e.message, e && e.stack);
    }
  })
  .catch((e) => {
    console.error('[initDB] fatal', e && e.message, e && e.stack);
    if (!loginReadyResolved) rejectLoginReady(e);
    /** Não rejeitar dbReady: senão toda a API fica «DB não disponível» após qualquer falha no arranque. */
    if (!dbReadyResolved) {
      console.warn(
        '[initDB] dbReady: arranque incompleto — a marcar pronto na mesma (modo degradado). Verifique logs e DDL (ex.: turno_pedidos).'
      );
      markDbReady();
    }
  });

/** Confirma no separador Rede (DevTools) que o preview não está a servir uma função antiga. */
const STOCKOS_API_BUILD = '2026-04-01-pedidos-fk-produto-type';

/** Folha de stock do turno: só Menu, Ingredientes e Bebidas — categoria «outro» não entra. */
const SQL_STOCK_CATEGORIAS = "categoria IN ('menu','ingredientes','bebida')";
const SQL_P_STOCK_CATEGORIAS = "p.categoria IN ('menu','ingredientes','bebida')";

const SQL_ORD_H = `(CASE h.valid_from_turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 0 END)`;

function sqlWhereHistLteTurno(turnAlias) {
  const ordT = `(CASE ${turnAlias}.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 0 END)`;
  return `(h.valid_from < ${turnAlias}.data OR (h.valid_from = ${turnAlias}.data AND ${SQL_ORD_H} <= ${ordT}))`;
}

/**
 * Após init: se a tabela não existir (migração bloqueada no pooler), leituras usam só produtos.preco.
 */
let _sqlUsePrecoHistorico = true;

/**
 * Preço unitário vigente para o turno `t` (histórico por calendário + manhã/tarde/noite); fallback `produtos.preco`.
 * Requer JOIN `turnos t ON t.id = ts.turno_id`.
 */
function sqlPPrecoNaData() {
  if (!_sqlUsePrecoHistorico) return `p.preco::numeric`;
  return `COALESCE((SELECT h.preco FROM produto_preco_historico h WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('t')} ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1), p.preco)::numeric`;
}

/** Valor de vendas por linha: snapshot ao fecho ou vendido × preço vigente na data/turno. */
function sqlTsValorVendaLinha() {
  if (!_sqlUsePrecoHistorico) {
    return `CASE WHEN ts.valor_vendas_reportado_kz IS NOT NULL THEN ts.valor_vendas_reportado_kz::numeric ELSE GREATEST(0::numeric, COALESCE(ts.encontrado,0)::numeric + COALESCE(ts.entrada,0)::numeric - COALESCE(ts.deixado,0)::numeric) * p.preco::numeric END`;
  }
  return `CASE WHEN ts.valor_vendas_reportado_kz IS NOT NULL THEN ts.valor_vendas_reportado_kz::numeric ELSE GREATEST(0::numeric, COALESCE(ts.encontrado,0)::numeric + COALESCE(ts.entrada,0)::numeric - COALESCE(ts.deixado,0)::numeric) * ${sqlPPrecoNaData()} END`;
}

function sqlGteStockVendido() {
  return `GREATEST(0::numeric, COALESCE(ts.encontrado,0)::numeric + COALESCE(ts.entrada,0)::numeric - COALESCE(ts.deixado,0)::numeric)`;
}

function sqlBackfillTurnoStockValorKz() {
  const g = sqlGteStockVendido();
  if (!_sqlUsePrecoHistorico) return `${g} * p.preco::numeric`;
  return `${g} * COALESCE((
          SELECT h.preco FROM produto_preco_historico h
          WHERE h.produto_id = ts.produto_id AND ${sqlWhereHistLteTurno('t')}
          ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
        ), p.preco)::numeric`;
}

function sqlBackfillTurnoVendasSnapshotsSet() {
  if (!_sqlUsePrecoHistorico) {
    return `preco_unit_snapshot = p.preco,
          preco_copos_pacote_snapshot = p.preco_copos_pacote,
          qtd_copos_pacote_snapshot = p.qtd_copos_pacote`;
  }
  return `preco_unit_snapshot = COALESCE((
            SELECT h.preco FROM produto_preco_historico h
            WHERE h.produto_id = tv.produto_id AND ${sqlWhereHistLteTurno('t')}
            ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
          ), p.preco),
          preco_copos_pacote_snapshot = COALESCE((
            SELECT h.preco_copos_pacote FROM produto_preco_historico h
            WHERE h.produto_id = tv.produto_id AND ${sqlWhereHistLteTurno('t')}
            ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
          ), p.preco_copos_pacote),
          qtd_copos_pacote_snapshot = COALESCE((
            SELECT h.qtd_copos_pacote FROM produto_preco_historico h
            WHERE h.produto_id = tv.produto_id AND ${sqlWhereHistLteTurno('t')}
            ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
          ), p.qtd_copos_pacote)`;
}

function sqlFechoTurnoStockValorKz() {
  const g = sqlGteStockVendido();
  if (!_sqlUsePrecoHistorico) return `${g} * p.preco::numeric`;
  return `${g} * COALESCE((
           SELECT h.preco FROM produto_preco_historico h
           WHERE h.produto_id = ts.produto_id AND ${sqlWhereHistLteTurno('tu')}
           ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
         ), p.preco)::numeric`;
}

function sqlFechoTurnoVendasSnapshotsSet() {
  if (!_sqlUsePrecoHistorico) {
    return `preco_unit_snapshot = p.preco,
           preco_copos_pacote_snapshot = p.preco_copos_pacote,
           qtd_copos_pacote_snapshot = p.qtd_copos_pacote`;
  }
  return `preco_unit_snapshot = COALESCE((
             SELECT h.preco FROM produto_preco_historico h
             WHERE h.produto_id = tv.produto_id AND ${sqlWhereHistLteTurno('tu')}
             ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
           ), p.preco),
           preco_copos_pacote_snapshot = COALESCE((
             SELECT h.preco_copos_pacote FROM produto_preco_historico h
             WHERE h.produto_id = tv.produto_id AND ${sqlWhereHistLteTurno('tu')}
             ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
           ), p.preco_copos_pacote),
           qtd_copos_pacote_snapshot = COALESCE((
             SELECT h.qtd_copos_pacote FROM produto_preco_historico h
             WHERE h.produto_id = tv.produto_id AND ${sqlWhereHistLteTurno('tu')}
             ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
           ), p.qtd_copos_pacote)`;
}

function sqlVendaListaPrecoUnit() {
  if (!_sqlUsePrecoHistorico) return `COALESCE(tv.preco_unit_snapshot, p.preco)::numeric`;
  return `COALESCE(tv.preco_unit_snapshot, COALESCE((
                SELECT h.preco FROM produto_preco_historico h
                WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('tu')}
                ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
              ), p.preco))::numeric`;
}

function sqlVendaListaPrecoCopoPacote() {
  if (!_sqlUsePrecoHistorico) return `COALESCE(tv.preco_copos_pacote_snapshot, p.preco_copos_pacote)::numeric`;
  return `COALESCE(tv.preco_copos_pacote_snapshot, COALESCE((
                SELECT h.preco_copos_pacote FROM produto_preco_historico h
                WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('tu')}
                ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
              ), p.preco_copos_pacote))::numeric`;
}

function sqlVendaListaQtdCoposPacote() {
  if (!_sqlUsePrecoHistorico) return `COALESCE(tv.qtd_copos_pacote_snapshot, p.qtd_copos_pacote)::integer`;
  return `COALESCE(tv.qtd_copos_pacote_snapshot, COALESCE((
                SELECT h.qtd_copos_pacote FROM produto_preco_historico h
                WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('tu')}
                ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1
              ), p.qtd_copos_pacote))::integer`;
}

/**
 * Onde corre a API — para activar melhorias só em develop sem afectar produção/qualidade.
 * Opcional: STOCKOS_DEPLOY_TIER=develop|qualidade|production|preview|local (sobrepõe a detecção Vercel).
 */
function stockosDeploymentTier() {
  const explicit = String(process.env.STOCKOS_DEPLOY_TIER || '').trim().toLowerCase();
  if (['production', 'qualidade', 'develop', 'preview', 'local'].includes(explicit)) return explicit;
  if (process.env.VERCEL_ENV === 'production') return 'production';
  if (process.env.VERCEL_ENV === 'preview') {
    const br = String(
      process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_GIT_BRANCH || ''
    ).toLowerCase();
    if (br === 'qualidade') return 'qualidade';
    if (br === 'develop') return 'develop';
    return 'preview';
  }
  return 'local';
}

/** Use no código para funcionalidades experimentais: só true no preview do branch develop. */
function isStockosDevelopOnly() {
  return stockosDeploymentTier() === 'develop';
}

/** Diagnósticos extra (ex. GET /api/dev/info): develop na Vercel ou execução local. */
function allowStockosDevDiagnostics() {
  const t = stockosDeploymentTier();
  return t === 'develop' || t === 'local';
}

/**
 * Ambiente «qualidade»: API só aceita leitura (GET/HEAD) + login POST.
 * Activar com STOCKOS_READ_ONLY=1 ou preview Vercel do branch `qualidade`.
 */
function isStockosApiReadOnly() {
  const ro = String(process.env.STOCKOS_READ_ONLY || '').trim().toLowerCase();
  if (ro === '1' || ro === 'true' || ro === 'yes') return true;
  if (process.env.VERCEL_ENV === 'preview') {
    const br = String(
      process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_GIT_BRANCH || ''
    ).toLowerCase();
    if (br === 'qualidade') return true;
  }
  return false;
}

app.use(cors({ origin: '*' }));
app.use((req, res, next) => {
  res.setHeader('X-StockOS-Api-Build', STOCKOS_API_BUILD);
  res.setHeader('X-StockOS-Tier', stockosDeploymentTier());
  if (isStockosApiReadOnly()) res.setHeader('X-StockOS-Read-Only', '1');
  next();
});
app.use(express.json({ limit: '6mb' }));
/** Antes de await dbReady: health não bloqueia em initDB (dezenas de queries DDL em cold start). */
app.get('/api/health', (req, res) =>
  res.json({
    status: 'ok',
    v: 5,
    build: STOCKOS_API_BUILD,
    tier: stockosDeploymentTier(),
    develop_only: isStockosDevelopOnly(),
    read_only: isStockosApiReadOnly()
  })
);
/** Antes de await dbReady: só espera dbLoginReady (utilizadores + admin ou bootstrap). */
app.post('/api/auth/login', async (req, res) => {
  try {
    await dbLoginReady;
    const password = (req.body.password || '').trim();
    const login = loginFromBody(req);
    if (!login || !password) return res.status(400).json({ erro: 'Nome de utilizador e senha são obrigatórios' });
    const r = await queryUtilizadorPorLogin(login);
    if (!r.rows.length) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const user = r.rows[0];
    if (user.senha_hash !== hashPassword(password)) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const token = createToken({ id: user.id, email: user.email, nome: user.nome, role: user.role, username: user.username });
    res.json({
      token,
      user: { id: user.id, email: user.email, nome: user.nome, role: user.role, username: user.username }
    });
  } catch (e) {
    console.error('[auth/login]', pgErrText(e));
    res.status(500).json({
      erro:
        'Não foi possível autenticar. Usa o email completo (ex.: admin@stockos.ao). Se persistir, o user da DATABASE_URL precisa de GRANT SELECT (e UPDATE nas colunas usadas) em public.utilizadores.'
    });
  }
});
app.use(express.static('public'));
app.use(async (req, res, next) => { try { await dbReady; next(); } catch(e) { res.status(500).json({ erro: 'DB não disponível' }); } });

app.use((req, res, next) => {
  if (!isStockosApiReadOnly()) return next();
  const m = req.method.toUpperCase();
  if (m === 'OPTIONS' || m === 'GET' || m === 'HEAD') return next();
  let p = req.path || '';
  if (!p && req.url) p = String(req.url).split('?')[0] || '';
  if (m === 'POST' && p === '/api/auth/login') return next();
  return res.status(403).json({
    erro: 'Ambiente de qualidade em modo só leitura. Não é possível criar, alterar nem apagar dados.',
    codigo: 'READ_ONLY'
  });
});

// ── HELPERS AUTH ──────────────────────────────────────────────
function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function createToken(payload) {
  const h = base64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const b = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now()/1000) + 12*3600 }));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${h}.${b}.${s}`;
}
function verifyToken(token) {
  try {
    const [h,b,s] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    if (s !== expected) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64').toString());
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}
function hashPassword(p) { return crypto.createHash('sha256').update(p + PWD_SALT).digest('hex'); }
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ','');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ erro: 'Não autenticado' });
  req.user = payload; next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ erro: 'Sem permissão' });
    next();
  };
}
function prevTurno(nome, data) {
  if (nome === 'manha') {
    const d = new Date(data + 'T12:00:00Z');
    d.setDate(d.getDate() - 1);
    return { nome: 'noite', data: d.toISOString().split('T')[0] };
  }
  if (nome === 'tarde') return { nome: 'manha', data };
  return { nome: 'tarde', data };
}

/** Início oficial do turno (minutos desde meia-noite), fuso Africa/Luanda. */
const TURNO_INICIO_MINUTES = { manha: 7 * 60, tarde: 15 * 60, noite: 23 * 60 };
const TZ_STOCKOS = 'Africa/Luanda';

function normalizeIsoDateStr(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}
function luandaDateStr(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_STOCKOS, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === 'year').value;
  const mo = parts.find((p) => p.type === 'month').value;
  const da = parts.find((p) => p.type === 'day').value;
  return `${y}-${mo}-${da}`;
}
function luandaMinutesNow(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_STOCKOS, hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = fmt.formatToParts(d);
  const h = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const m = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  return h * 60 + m;
}

/** Soma dias a uma data YYYY-MM-DD (meio-dia UTC para evitar saltos). */
function addDaysIso(isoDateStr, deltaDays) {
  const base = normalizeIsoDateStr(String(isoDateStr || '').slice(0, 10));
  if (!base) return luandaDateStr();
  const d = new Date(`${base}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Primeiro turno em que o novo preço aplica por defeito: o próximo em relação à hora actual em Luanda.
 * Ex.: às 16h → noite do mesmo dia; após 23h → manhã do dia seguinte.
 */
function proximoTurnoPrecoVigente(now = new Date()) {
  const data = luandaDateStr(now);
  const m = luandaMinutesNow(now);
  const M = TURNO_INICIO_MINUTES;
  if (m < M.manha) return { data, nome: 'manha' };
  if (m < M.tarde) return { data, nome: 'tarde' };
  if (m < M.noite) return { data, nome: 'noite' };
  return { data: addDaysIso(data, 1), nome: 'manha' };
}

/** Vigência explícita (data + turno) ou, em omissão, próximo turno a partir de agora. */
function vigenciaPrecoNovaLinha(body) {
  const raw = String(body && body.preco_vigente_desde != null ? body.preco_vigente_desde : '').trim();
  if (raw) {
    const m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    const d = m
      ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
      : null;
    if (!d) return proximoTurnoPrecoVigente();
    const tn = String(body.preco_vigente_turno || 'manha').trim().toLowerCase();
    const nome = ['manha', 'tarde', 'noite'].includes(tn) ? tn : 'manha';
    return { data: d, nome };
  }
  return proximoTurnoPrecoVigente();
}

/** Rejeita abertura antes da data/hora permitida (data futura ou mesmo dia antes do início do turno). */
function assertPodeAbrirTurno(data, nome) {
  const day = normalizeIsoDateStr(String(data || '').slice(0, 10));
  if (!day) throw new Error('Data inválida');
  const today = normalizeIsoDateStr(luandaDateStr());
  if (day > today) throw new Error('Não é possível abrir turno para uma data futura.');
  if (day < today) return;
  const start = TURNO_INICIO_MINUTES[nome];
  if (start === undefined) return;
  if (luandaMinutesNow() < start) {
    const hh = Math.floor(start / 60);
    const mm = start % 60;
    const label = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' }[nome] || nome;
    throw new Error(
      `Só é possível abrir o turno ${label} após ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} (horário de Angola).`
    );
  }
}

function normDataPostgres(d) {
  if (d == null || d === '') return '';
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function normalizeUsername(s) {
  return String(s || '').trim().toLowerCase();
}
function isValidUsername(s) {
  return /^[a-z0-9._-]{3,50}$/.test(s);
}

/** Supabase pode usar ENUM role_utilizador; o código usa o valor «compras». */
async function ensureRoleEnumCompras() {
  await query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role_utilizador') THEN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'role_utilizador' AND e.enumlabel = 'compras'
        ) THEN
          ALTER TYPE role_utilizador ADD VALUE 'compras';
        END IF;
      END IF;
    END $$;
  `).catch(() => {});
}

/**
 * URI directa ao Postgres (Supabase db.<ref>.supabase.co:5432). O pooler :6543 em modo transacção
 * pode ignorar DDL com qry() sem erro visível → tabela nunca criada.
 */
function getDirectSupabasePostgresUrl() {
  const env = (process.env.DATABASE_URL_DIRECT || process.env.STOCKOS_DATABASE_URL_DIRECT || '').trim();
  if (env) return env;
  try {
    const u = new URL(_dbUrlRaw);
    const host = (u.hostname || '').toLowerCase();
    let ref = (process.env.SUPABASE_PROJECT_REF || '').replace(/[^a-z0-9]/gi, '');
    if (!ref) {
      const user = decodeURIComponent((u.username || '').replace(/\+/g, ' '));
      const m = user.match(/^postgres\.([a-z0-9]+)$/i);
      if (m) ref = m[1];
    }
    if (!ref) return null;
    if (host.includes('pooler.supabase.com')) {
      const d = new URL(u.toString());
      d.hostname = `db.${ref}.supabase.co`;
      d.port = '5432';
      d.searchParams.delete('pgbouncer');
      if (!d.searchParams.get('sslmode')) d.searchParams.set('sslmode', 'require');
      /** Direct session: user é «postgres», não «postgres.<ref>» (pooler). A password mantém-se. */
      d.username = 'postgres';
      return d.toString();
    }
  } catch (_) {}
  return null;
}

const PPH_DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS produto_preco_historico (
      id SERIAL PRIMARY KEY,
      produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
      valid_from DATE NOT NULL,
      valid_from_turno VARCHAR(10) NOT NULL DEFAULT 'manha' CHECK (valid_from_turno IN ('manha','tarde','noite')),
      preco NUMERIC(15,2) NOT NULL DEFAULT 0,
      preco_copos_pacote NUMERIC(15,2) NOT NULL DEFAULT 0,
      qtd_copos_pacote INTEGER NOT NULL DEFAULT 0
    )`,
  `ALTER TABLE produto_preco_historico ADD COLUMN IF NOT EXISTS valid_from_turno VARCHAR(10) NOT NULL DEFAULT 'manha'`,
  `ALTER TABLE produto_preco_historico DROP CONSTRAINT IF EXISTS produto_preco_historico_produto_id_valid_from_key`,
  `ALTER TABLE produto_preco_historico DROP CONSTRAINT IF EXISTS produto_preco_historico_prod_vig_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS produto_preco_historico_prod_vig_uidx ON produto_preco_historico (produto_id, valid_from, valid_from_turno)`,
  `CREATE INDEX IF NOT EXISTS idx_produto_preco_hist_lookup ON produto_preco_historico (produto_id, valid_from DESC)`
];

async function produtoPrecoHistoricoTableExists() {
  try {
    await query(`SELECT 1 FROM produto_preco_historico LIMIT 1`);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Histórico de preços: vigência por (data, turno). Relatórios usam a data do turno e manhã/tarde/noite.
 */
async function ensureProdutoPrecoHistorico() {
  try {
  for (let i = 0; i < PPH_DDL_STATEMENTS.length; i++) {
    await qry(PPH_DDL_STATEMENTS[i], [], 'pph');
  }

  async function seedBase() {
    try {
      await query(`
        INSERT INTO produto_preco_historico (produto_id, valid_from, valid_from_turno, preco, preco_copos_pacote, qtd_copos_pacote)
        SELECT id, DATE '2000-01-01', 'manha', preco, preco_copos_pacote, qtd_copos_pacote FROM produtos
        ON CONFLICT (produto_id, valid_from, valid_from_turno) DO NOTHING
      `);
    } catch (e) {
      console.warn('[ensureProdutoPrecoHistorico seed]', e.message);
    }
  }

  if (await produtoPrecoHistoricoTableExists()) {
    await seedBase();
    return;
  }

  console.warn('[ensureProdutoPrecoHistorico] tabela ausente após qry DDL — a repetir com query() no pool principal');
  try {
    for (let i = 0; i < PPH_DDL_STATEMENTS.length; i++) {
      await query(PPH_DDL_STATEMENTS[i]);
    }
  } catch (e) {
    console.warn('[ensureProdutoPrecoHistorico] query() no pooler:', e && e.message);
  }
  if (await produtoPrecoHistoricoTableExists()) {
    await seedBase();
    return;
  }

  const directUrl = getDirectSupabasePostgresUrl();
  if (!directUrl) {
    console.error(
      '[ensureProdutoPrecoHistorico] sem tabela após pooler. Define DATABASE_URL_DIRECT ou SUPABASE_PROJECT_REF; ou corre supabase/stockos_database.sql no Supabase SQL Editor.'
    );
    return;
  }

  console.warn('[ensureProdutoPrecoHistorico] a repetir DDL na ligação directa Supabase (porta 5432)');
  const sqlDirect = postgres(directUrl, { ..._sqlOpts, max: 1 });
  try {
    for (let i = 0; i < PPH_DDL_STATEMENTS.length; i++) {
      await sqlDirect.unsafe(PPH_DDL_STATEMENTS[i]);
    }
  } catch (e) {
    console.error('[ensureProdutoPrecoHistorico] DDL directa:', e && e.message);
    return;
  } finally {
    await sqlDirect.end({ timeout: 5 }).catch(() => {});
  }

  await seedBase();
  if (!(await produtoPrecoHistoricoTableExists())) {
    console.error(
      '[ensureProdutoPrecoHistorico] tabela ainda em falta após DDL directa. Verifica logs acima ou aplica o SQL em supabase/stockos_database.sql.'
    );
  }
  } finally {
    try {
      _sqlUsePrecoHistorico = await produtoPrecoHistoricoTableExists();
      if (!_sqlUsePrecoHistorico) {
        console.warn('[StockOS] produto_preco_historico ausente — leituras usam só produtos.preco até a tabela existir.');
      }
    } catch (_) {
      _sqlUsePrecoHistorico = false;
    }
  }
}

/**
 * Snapshot de valores ao fecho: alterar produtos.preco não muda relatórios de turnos já fechados.
 * Backfill: só turnos fechados sem snapshot (turnos reabertos ficam com NULL até novo fecho).
 */
/** «Encontrado» sem valor por defeito: NULL até o operador preencher (abrir turno não insere 0). */
async function ensureTurnoStockEncontradoNullable() {
  try {
    await qry(
      `ALTER TABLE turno_stock ALTER COLUMN encontrado DROP DEFAULT`,
      [],
      'turno_stock-encontrado-drop-default'
    );
  } catch (e) {
    console.warn('[ensureTurnoStockEncontradoNullable] drop default:', e && e.message);
  }
  try {
    await qry(
      `ALTER TABLE turno_stock ALTER COLUMN encontrado DROP NOT NULL`,
      [],
      'turno_stock-encontrado-null'
    );
  } catch (e) {
    console.warn('[ensureTurnoStockEncontradoNullable] drop not null:', e && e.message);
  }
}

/** «Deixado» sem 0 por defeito (NULL até preencher). */
async function ensureTurnoStockDeixadoNullable() {
  try {
    await qry(`ALTER TABLE turno_stock ALTER COLUMN deixado DROP DEFAULT`, [], 'turno_stock-deixado-drop-default');
  } catch (e) {
    console.warn('[ensureTurnoStockDeixadoNullable] drop default:', e && e.message);
  }
  try {
    await qry(`ALTER TABLE turno_stock ALTER COLUMN deixado DROP NOT NULL`, [], 'turno_stock-deixado-null');
  } catch (e) {
    console.warn('[ensureTurnoStockDeixadoNullable] drop not null:', e && e.message);
  }
}

/** TPA / Transferência / Dinheiro sem 0 por defeito na linha de caixa. */
async function ensureTurnoCaixaEntradasNullable() {
  for (const col of ['tpa', 'transferencia', 'dinheiro']) {
    try {
      await qry(
        `ALTER TABLE turno_caixa ALTER COLUMN ${col} DROP DEFAULT`,
        [],
        `turno_caixa-${col}-drop-default`
      );
    } catch (e) {
      console.warn(`[ensureTurnoCaixaEntradasNullable] ${col} drop default:`, e && e.message);
    }
    try {
      await qry(
        `ALTER TABLE turno_caixa ALTER COLUMN ${col} DROP NOT NULL`,
        [],
        `turno_caixa-${col}-null`
      );
    } catch (e) {
      console.warn(`[ensureTurnoCaixaEntradasNullable] ${col} drop not null:`, e && e.message);
    }
  }
}

async function ensurePrecosVendasSnapshots() {
  await ensureProdutoPrecoHistorico();
  await ensureTurnoStockEncontradoNullable();
  await ensureTurnoStockDeixadoNullable();
  await ensureTurnoCaixaEntradasNullable();
  await qry(`ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS valor_vendas_reportado_kz NUMERIC(15,2)`, [], 'turno_stock-valor-snap');
  await qry(`ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS preco_unit_snapshot NUMERIC(15,2)`, [], 'turno_vendas-precio-snap');
  await qry(`ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS preco_copos_pacote_snapshot NUMERIC(15,2)`, [], 'turno_vendas-preco-copo-snap');
  await qry(`ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS qtd_copos_pacote_snapshot INTEGER`, [], 'turno_vendas-qtd-copo-snap');
  try {
    await query(`
      UPDATE turno_stock ts
      SET valor_vendas_reportado_kz = (${sqlBackfillTurnoStockValorKz()})
      FROM produtos p, turnos t
      WHERE ts.produto_id = p.id AND ts.turno_id = t.id AND t.estado = 'fechado' AND ts.valor_vendas_reportado_kz IS NULL
    `);
  } catch (e) {
    console.warn('[ensurePrecosVendasSnapshots ts]', e.message);
  }
  try {
    await query(`
      UPDATE turno_vendas tv
      SET ${sqlBackfillTurnoVendasSnapshotsSet()}
      FROM produtos p, turnos t
      WHERE tv.produto_id = p.id AND tv.turno_id = t.id AND t.estado = 'fechado' AND tv.preco_unit_snapshot IS NULL
    `);
  } catch (e) {
    console.warn('[ensurePrecosVendasSnapshots tv]', e.message);
  }
}

async function ensureTurnoPedidos() {
  /** Alinhar produto_id ao tipo de produtos.id (INTEGER vs UUID — FK falha se diferir). */
  const _pidCheck = await query(
    `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='produtos' AND column_name='id'`
  ).catch(() => ({ rows: [] }));
  const _pidType = _pidCheck.rows.length > 0 ? String(_pidCheck.rows[0].data_type).toLowerCase() : 'integer';
  const pidSql =
    _pidType === 'uuid'
      ? 'UUID'
      : _pidType === 'bigint'
        ? 'BIGINT'
        : 'INTEGER';

  const _tplCheck = await query(
    `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='turno_pedido_linhas' AND column_name='produto_id'`
  ).catch(() => ({ rows: [] }));
  if (_tplCheck.rows.length > 0) {
    const cur = String(_tplCheck.rows[0].data_type).toLowerCase();
    if (cur !== _pidType) {
      await query(`DROP TABLE IF EXISTS turno_pedido_linhas CASCADE`);
      await query(`DROP TABLE IF EXISTS turno_pedidos CASCADE`);
    }
  }

  /** Usar query() — qry() engolia falhas e as tabelas nunca eram criadas. */
  await query(
    `CREATE TABLE IF NOT EXISTS turno_pedidos (
      id SERIAL PRIMARY KEY,
      turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
      cliente_nome TEXT NOT NULL DEFAULT '',
      tipo_pagamento VARCHAR(24) NOT NULL DEFAULT 'dinheiro',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  );
  await query(
    `ALTER TABLE turno_pedidos ADD COLUMN IF NOT EXISTS tipo_pagamento VARCHAR(24) NOT NULL DEFAULT 'dinheiro'`,
    []
  );
  await query(
    `CREATE TABLE IF NOT EXISTS turno_pedido_linhas (
      id SERIAL PRIMARY KEY,
      pedido_id INTEGER NOT NULL REFERENCES turno_pedidos(id) ON DELETE CASCADE,
      produto_id ${pidSql} NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
      quantidade NUMERIC(10,3) NOT NULL DEFAULT 0
    )`
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_turno_pedidos_turno ON turno_pedidos(turno_id)`
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_turno_pedido_linhas_pedido ON turno_pedido_linhas(pedido_id)`
  );
}

/**
 * Define quantidade absoluta em turno_vendas e aplica delta ao stock (menu/copo/ingredientes).
 */
async function applyTurnoVendaQuantity(client, turnoId, produto_id, newQty) {
  const prodInfo = await client.query(
    'SELECT venda_por_copo, kg_por_copo FROM produtos WHERE id=$1',
    [produto_id]
  );
  const prow = prodInfo.rows[0];
  if (!prow) throw new Error('Produto não encontrado');
  const isCopo = prow.venda_por_copo === true && parseFloat(prow.kg_por_copo) > 0;

  let nq = parseFloat(newQty);
  if (isCopo) nq = Math.max(0, Math.floor(nq));

  const old = await client.query(
    'SELECT quantidade FROM turno_vendas WHERE turno_id=$1 AND produto_id=$2',
    [turnoId, produto_id]
  );
  const oldQty = old.rows.length ? parseFloat(old.rows[0].quantidade) : 0;
  const delta = nq - oldQty;

  await client.query(
    `INSERT INTO turno_vendas (turno_id,produto_id,quantidade) VALUES ($1,$2,$3)
     ON CONFLICT (turno_id,produto_id) DO UPDATE SET quantidade=$3`,
    [turnoId, produto_id, nq]
  );

  if (delta === 0) return;

  if (isCopo) {
    const kg = delta * parseFloat(prow.kg_por_copo);
    await client.query(
      `UPDATE turno_stock SET deixado=GREATEST(0, COALESCE(deixado,0) - $1)
       WHERE turno_id=$2 AND produto_id=$3`,
      [kg, turnoId, produto_id]
    );
    return;
  }

  async function expandIngredientes(prodId, fator) {
    const r = await client.query(
      'SELECT componente_id, quantidade FROM receitas WHERE produto_id=$1',
      [prodId]
    );
    if (r.rows.length === 0) {
      return [{ componente_id: prodId, quantidade: fator }];
    }
    const ingredientes = [];
    for (const comp of r.rows) {
      const sub = await expandIngredientes(comp.componente_id, fator * parseFloat(comp.quantidade));
      ingredientes.push(...sub);
    }
    return ingredientes;
  }

  const ingredientes = await expandIngredientes(produto_id, delta);
  const totais = {};
  for (const ing of ingredientes) {
    totais[ing.componente_id] = (totais[ing.componente_id] || 0) + ing.quantidade;
  }
  for (const [compId, qtd] of Object.entries(totais)) {
    await client.query(
      `UPDATE turno_stock SET deixado=GREATEST(0, COALESCE(deixado,0) - $1)
       WHERE turno_id=$2 AND produto_id=$3`,
      [qtd, turnoId, compId]
    );
  }
}

async function recordProdutoPrecoHistoricoIfChanged(produtoId, oldRow, np, ncp, nq, body) {
  if (!_sqlUsePrecoHistorico) return;
  const op = parseFloat(oldRow.preco) || 0;
  const ocp = parseFloat(oldRow.preco_copos_pacote) || 0;
  const oq = parseInt(oldRow.qtd_copos_pacote, 10) || 0;
  if (Math.abs(op - np) <= 1e-6 && Math.abs(ocp - ncp) <= 1e-6 && oq === nq) return;
  const v = vigenciaPrecoNovaLinha(body || {});
  await query(
    `INSERT INTO produto_preco_historico (produto_id, valid_from, valid_from_turno, preco, preco_copos_pacote, qtd_copos_pacote)
     VALUES ($1, $2::date, $3, $4, $5, $6)
     ON CONFLICT (produto_id, valid_from, valid_from_turno) DO UPDATE SET
       preco = EXCLUDED.preco,
       preco_copos_pacote = EXCLUDED.preco_copos_pacote,
       qtd_copos_pacote = EXCLUDED.qtd_copos_pacote`,
    [produtoId, v.data, v.nome, np, ncp, nq]
  );
}

/**
 * Descobre se existe coluna username (login não deve depender só de information_schema —
 * em alguns hosts a metadata fica vazia e a app tentava ALTER TABLE → must be owner).
 */
async function utilizadoresHasUsernameColumn() {
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'utilizadores' AND column_name = 'username'
       LIMIT 1`
    );
    if (r.rows.length > 0) return true;
  } catch (_) {}
  try {
    await query(`SELECT username FROM utilizadores WHERE false`);
    return true;
  } catch (_) {
    return false;
  }
}

function pgErrText(e) {
  return [e && e.message, e && e.detail, e && e.hint, e && e.code].filter(Boolean).join(' | ');
}

/**
 * Um SELECT: email exacto ou username (só se $1 não tiver «@»). Preferência por email se ambos casassem.
 * Fallback em duas queries se a coluna username não existir (BD muito antiga).
 */
async function queryUtilizadorPorLogin(login) {
  const L = String(login || '').trim();
  try {
    const r = await query(
      `SELECT * FROM utilizadores WHERE ativo=true AND (
        LOWER(email) = LOWER($1)
        OR (STRPOS($1, '@') = 0 AND LOWER(COALESCE(username, '')) = LOWER($1))
      )
      ORDER BY CASE WHEN LOWER(email) = LOWER($1) THEN 0 ELSE 1 END
      LIMIT 1`,
      [L]
    );
    return r;
  } catch (e) {
    const byEmail = await query(
      `SELECT * FROM utilizadores WHERE ativo=true AND LOWER(email)=LOWER($1)`,
      [L]
    );
    if (byEmail.rows.length > 0 || L.includes('@')) return byEmail;
    try {
      return await query(
        `SELECT * FROM utilizadores WHERE ativo=true AND LOWER(username)=LOWER($1)`,
        [L]
      );
    } catch (e2) {
      console.warn('[auth/login] lookup por username ignorado:', pgErrText(e2));
      return byEmail;
    }
  }
}

/**
 * Nunca corre DDL em utilizadores (ALTER/INDEX) — com stockos_app após pg_restore isso gera «must be owner».
 * Só backfill com UPDATE se a coluna username já existir. Esquema novo: POST /api/migrate (admin) ou SQL no Supabase como postgres.
 */
async function ensureUsernameColumn() {
  if (usernameColumnEnsured) return;
  const hasUsername = await utilizadoresHasUsernameColumn().catch(() => false);
  if (hasUsername) {
    const r = await query(`SELECT id, email FROM utilizadores WHERE username IS NULL OR TRIM(username) = ''`).catch(() => ({ rows: [] }));
    for (const row of r.rows) {
      await query(`UPDATE utilizadores SET username=$1 WHERE id=$2`, [`u${row.id}`, row.id]).catch(() => {});
    }
    await query(`UPDATE utilizadores SET username = 'admin' WHERE email = 'admin@stockos.ao'`).catch(() => {});
  } else {
    console.warn('[ensureUsernameColumn] Coluna username ausente — aplica supabase/grant_stockos_app.sql e migrações como postgres, ou POST /api/migrate.');
  }

  usernameColumnEnsured = true;
}

function loginFromBody(req) {
  const v = (req.body.login || req.body.email || '').trim();
  return v;
}

async function ensureDepositosBanco() {
  await query(`CREATE TABLE IF NOT EXISTS depositos_banco (
    id SERIAL PRIMARY KEY,
    data_referencia DATE,
    data_deposito DATE NOT NULL DEFAULT CURRENT_DATE,
    valor NUMERIC(15,2) NOT NULL,
    referencia TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    criado_por TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS turno_id INTEGER REFERENCES turnos(id) ON DELETE CASCADE`).catch(() => {});
  await query(`DELETE FROM depositos_banco WHERE turno_id IS NULL`).catch(() => {});
  await query(`ALTER TABLE depositos_banco DROP COLUMN IF EXISTS data_referencia`).catch(() => {});
  try {
    await query(`ALTER TABLE depositos_banco ALTER COLUMN turno_id SET NOT NULL`);
  } catch (_) {}
  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS depositos_banco_turno_id_key ON depositos_banco(turno_id)`);
  } catch (_) {}
  await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS valor_tpa NUMERIC(15,2) NOT NULL DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS valor_saidas NUMERIC(15,2) NOT NULL DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS saidas_destino TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS bordero_foto_url TEXT NOT NULL DEFAULT ''`).catch(() => {});
  if (!depositosSaidasMigrationDone) {
    try {
      await migrateDepositosSaidasAntigasAgrupadas();
      depositosSaidasMigrationDone = true;
    } catch (e) {
      console.error('migrateDepositosSaidasAntigasAgrupadas', e);
    }
  }
}

function sanitizeSaidasDestino(s) {
  return String(s ?? '')
    .trim()
    .slice(0, 2000);
}

const BORDERO_BUCKET = 'depositos-bordero';

function detectSupabaseUrlFromDatabaseUrl() {
  try {
    const u = new URL(_dbUrl);
    const m = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    if (m) return `https://${m[1]}.supabase.co`;
  } catch (_) {}
  return '';
}

function getSupabaseEnv() {
  const url = (process.env.SUPABASE_URL || detectSupabaseUrlFromDatabaseUrl() || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, key };
}

function parseDataUrlFoto(dataUrl) {
  const s = String(dataUrl || '').trim();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i.exec(s);
  if (!m) return null;
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (buf.length < 80 || buf.length > 5 * 1024 * 1024) return null;
  const ct = m[1].toLowerCase();
  const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
  return { contentType: ct, buffer: buf, ext };
}

async function uploadBorderoToSupabase(buffer, key, contentType) {
  const { url: base, key: serviceKey } = getSupabaseEnv();
  if (!base || !serviceKey) return null;
  const uploadUrl = `${base}/storage/v1/object/${BORDERO_BUCKET}/${key}`;
  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error(`Upload Storage falhou (${r.status}). Cria o bucket «${BORDERO_BUCKET}» (público) no Supabase. ${t}`);
    err.code = 'STORAGE';
    throw err;
  }
  return `${base}/storage/v1/object/public/${BORDERO_BUCKET}/${key}`;
}

async function deleteBorderoFromSupabaseStorage(publicUrl) {
  const { url: base, key: serviceKey } = getSupabaseEnv();
  if (!base || !serviceKey || !publicUrl || typeof publicUrl !== 'string') return;
  const marker = `/storage/v1/object/public/${BORDERO_BUCKET}/`;
  const i = publicUrl.indexOf(marker);
  if (i < 0) return;
  const path = publicUrl.slice(i + marker.length);
  if (!path) return;
  const delUrl = `${base}/storage/v1/object/${BORDERO_BUCKET}/${path}`;
  await fetch(delUrl, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
  }).catch(() => {});
}

/** Uma foto de borderô por dia de depósito: limpa todas as linhas desse dia e grava só no registo canónico (primeiro turno). */
async function purgeBorderoUrlsForDayAndStorage(dataStr) {
  const r = await query(
    `SELECT d.id, d.bordero_foto_url FROM depositos_banco d
     JOIN turnos t ON t.id = d.turno_id
     WHERE t.data = $1::date`,
    [dataStr]
  );
  for (const row of r.rows) {
    const u = row.bordero_foto_url;
    if (u && String(u).startsWith('http')) await deleteBorderoFromSupabaseStorage(String(u));
  }
  await query(
    `UPDATE depositos_banco d SET bordero_foto_url = ''
     FROM turnos t
     WHERE d.turno_id = t.id AND t.data = $1::date`,
    [dataStr]
  );
}

async function getCanonicalDepositIdForDay(dataStr) {
  const r = await query(
    `SELECT d.id FROM depositos_banco d
     JOIN turnos t ON t.id = d.turno_id
     WHERE t.data = $1::date
     ORDER BY CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END
     LIMIT 1`,
    [dataStr]
  );
  return r.rows[0]?.id ?? null;
}

async function applyBorderoFotoCanonicalDay(dataStr, canonicalId, fotoBase64) {
  const parsed = parseDataUrlFoto(fotoBase64);
  if (!parsed) {
    const err = new Error('Envia uma imagem (JPEG, PNG ou WebP) em base64 (data URL).');
    err.code = 'BORDERO';
    throw err;
  }
  await purgeBorderoUrlsForDayAndStorage(dataStr);
  const { url: sbUrl, key: sbKey } = getSupabaseEnv();
  let finalUrl;
  if (sbUrl && sbKey) {
    const fileKey = `${dataStr}/${canonicalId}-${crypto.randomBytes(6).toString('hex')}.${parsed.ext}`;
    finalUrl = await uploadBorderoToSupabase(parsed.buffer, fileKey, parsed.contentType);
  } else {
    const raw = String(fotoBase64 || '').trim();
    if (raw.length > 4 * 1024 * 1024) {
      throw new Error('Imagem demasiado grande. Define SUPABASE_SERVICE_ROLE_KEY no servidor para usar Storage.');
    }
    finalUrl = raw;
  }
  await query('UPDATE depositos_banco SET bordero_foto_url=$1 WHERE id=$2', [finalUrl, canonicalId]);
}

async function applyFaturaFotoUrl(client, faturaId, fotoBase64) {
  const parsed = parseDataUrlFoto(fotoBase64);
  if (!parsed) {
    const err = new Error('Envia uma imagem (JPEG, PNG ou WebP) em base64 (data URL).');
    err.code = 'FATURA_FOTO';
    throw err;
  }
  const { url: sbUrl, key: sbKey } = getSupabaseEnv();
  let finalUrl;
  if (sbUrl && sbKey) {
    const fileKey = `faturas-compra/${faturaId}-${crypto.randomBytes(6).toString('hex')}.${parsed.ext}`;
    finalUrl = await uploadBorderoToSupabase(parsed.buffer, fileKey, parsed.contentType);
  } else {
    const raw = String(fotoBase64 || '').trim();
    if (raw.length > 4 * 1024 * 1024) {
      throw new Error('Imagem demasiado grande. Define SUPABASE_SERVICE_ROLE_KEY no servidor para usar Storage.');
    }
    finalUrl = raw;
  }
  await client.query('UPDATE armazem_faturas SET foto_fatura_url=$1 WHERE id=$2', [finalUrl, faturaId]);
}

/** valor = bruto por turno na coluna valor; saída no depósito só no total (valor_saidas num único registo do dia). Líquido total = Σ(valor) − Σ(valor_saidas). */
function parseDepositoValores(body) {
  const saidasRaw = parseFloat(body.valor_saidas);
  const saidas = Number.isNaN(saidasRaw) ? 0 : Math.max(0, saidasRaw);
  const bruto = parseFloat(body.valor_bruto);
  if (!Number.isNaN(bruto) && bruto > 0) {
    const liquido = bruto - saidas;
    if (liquido <= 0) {
      const err = new Error('O valor bruto deve ser maior que o montante para compras de armazém (saída no depósito).');
      err.code = 'DEP';
      throw err;
    }
    return { valor: bruto, valor_saidas: saidas };
  }
  const v = parseFloat(body.valor);
  if (!Number.isNaN(v) && v > 0) {
    const brutoLegacy = v + saidas;
    return { valor: brutoLegacy, valor_saidas: saidas };
  }
  return null;
}

function ordemTurnoNome(nome) {
  if (nome === 'manha') return 1;
  if (nome === 'tarde') return 2;
  if (nome === 'noite') return 3;
  return 9;
}

/** Migra formato antigo (saídas repartidas por turno) para bruto por linha + saída total só no primeiro turno do dia. */
async function migrateDepositosSaidasAntigasAgrupadas() {
  const r = await query(`
    SELECT d.id, d.valor, d.valor_saidas, t.data::text AS data, t.nome
    FROM depositos_banco d
    JOIN turnos t ON t.id = d.turno_id
    ORDER BY t.data, CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END
  `);
  const byData = new Map();
  for (const row of r.rows) {
    if (!byData.has(row.data)) byData.set(row.data, []);
    byData.get(row.data).push(row);
  }
  for (const grp of byData.values()) {
    const nComSaidas = grp.filter((x) => (parseFloat(x.valor_saidas) || 0) > 0).length;
    if (nComSaidas <= 1) continue;
    const totalSaidas = grp.reduce((s, x) => s + (parseFloat(x.valor_saidas) || 0), 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of grp) {
        const v = parseFloat(row.valor) || 0;
        const vs = parseFloat(row.valor_saidas) || 0;
        await client.query(`UPDATE depositos_banco SET valor = $1, valor_saidas = 0 WHERE id = $2`, [v + vs, row.id]);
      }
      const sorted = [...grp].sort((a, b) => ordemTurnoNome(a.nome) - ordemTurnoNome(b.nome));
      await client.query(`UPDATE depositos_banco SET valor_saidas = $1 WHERE id = $2`, [totalSaidas, sorted[0].id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

async function assertTurnoFechado(turnoId) {
  const n = parseInt(turnoId, 10);
  if (!n) {
    const err = new Error('Indica o turno válido.');
    err.code = 'TURNOS';
    throw err;
  }
  const r = await query(`SELECT id, estado, data FROM turnos WHERE id = $1`, [n]);
  if (!r.rows.length) {
    const err = new Error('Turno não encontrado.');
    err.code = 'TURNOS';
    throw err;
  }
  if (r.rows[0].estado !== 'fechado') {
    const err = new Error('O turno deve estar fechado para registar o depósito.');
    err.code = 'TURNOS';
    throw err;
  }
  return r.rows[0];
}

// ── AUTH ──────────────────────────────────────────────────────
/** Informação de runtime útil em develop (e em local); 404 noutros tiers. */
app.get('/api/dev/info', (req, res) => {
  if (!allowStockosDevDiagnostics()) {
    return res.status(404).json({ erro: 'Não encontrado' });
  }
  res.json({
    build: STOCKOS_API_BUILD,
    tier: stockosDeploymentTier(),
    node: process.version,
    uptime_s: Math.floor(process.uptime()),
    vercel_url: process.env.VERCEL_URL || null,
    git_ref: process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_GIT_BRANCH || null,
    git_sha: process.env.VERCEL_GIT_COMMIT_SHA
      ? String(process.env.VERCEL_GIT_COMMIT_SHA).slice(0, 7)
      : null
  });
});


app.get('/api/status', async (req, res) => {
  try {
    const r = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    res.json({ tables: r.rows.map(x => x.table_name) });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/**
 * Diagnóstico preview/dev: confirma ligação TCP + permissões de leitura (sem auth).
 * Registado em /api/db-check e /db-check (alguns proxies Vercel entregam o path sem prefixo /api).
 */
async function handleDbCheck(req, res) {
  try {
    const one = await query(`SELECT 1 AS ok`);
    const tabs = await query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`
    );
    let utilizadores_ok = false;
    let utilizadores_ativos = null;
    let utilizadores_erro = null;
    try {
      const u = await query(`SELECT COUNT(*)::int AS n FROM utilizadores WHERE ativo = true`);
      utilizadores_ok = true;
      utilizadores_ativos = u.rows[0].n;
    } catch (e) {
      utilizadores_erro = String((e && e.message) || e);
    }
    res.json({
      ok: true,
      build: STOCKOS_API_BUILD,
      tier: stockosDeploymentTier(),
      develop_only: isStockosDevelopOnly(),
      api_read_only: isStockosApiReadOnly(),
      ping: one.rows[0].ok === 1,
      tables_public: tabs.rows[0].n,
      utilizadores_ok,
      utilizadores_ativos,
      utilizadores_erro
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      build: STOCKOS_API_BUILD,
      tier: stockosDeploymentTier(),
      develop_only: isStockosDevelopOnly(),
      api_read_only: isStockosApiReadOnly(),
      erro: String((e && e.message) || e),
      code: e && e.code
    });
  }
}
app.get('/api/db-check', handleDbCheck);
app.get('/db-check', handleDbCheck);

app.post('/api/migrate', auth, requireRole('admin'), async (req, res) => {
  const results = [];
  async function run(sql, label) {
    try { await query(sql); results.push({ label, ok: true }); }
    catch(e) { results.push({ label, ok: false, erro: e.message }); }
  }
  await run(
    `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role_utilizador') THEN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'role_utilizador' AND e.enumlabel = 'compras'
        ) THEN
          ALTER TYPE role_utilizador ADD VALUE 'compras';
        END IF;
      END IF;
    END $$`,
    'role_enum_compras'
  );
  await run(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS username VARCHAR(50)`, 'utilizadores-username-col');
  await run(
    `UPDATE utilizadores SET username = 'u' || id::text WHERE username IS NULL OR TRIM(COALESCE(username,'')) = ''`,
    'utilizadores-username-backfill'
  );
  await run(`UPDATE utilizadores SET username = 'admin' WHERE email = 'admin@stockos.ao'`, 'utilizadores-username-admin');
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_utilizadores_username_lower ON utilizadores (LOWER(username))`, 'utilizadores-username-idx');
  try {
    await ensureDepositosBanco();
    results.push({ label: 'depositos_banco', ok: true });
  } catch (e) {
    results.push({ label: 'depositos_banco', ok: false, erro: e.message });
  }
  await run(`ALTER TABLE produtos ALTER COLUMN sku SET DEFAULT ''`, 'sku-default');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco NUMERIC(15,2) NOT NULL DEFAULT 0`, 'preco');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria VARCHAR(20) NOT NULL DEFAULT 'outro'`, 'categoria');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ordem INTEGER NOT NULL DEFAULT 0`, 'ordem');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE`, 'ativo');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tipo_medicao VARCHAR(10) NOT NULL DEFAULT 'unidade'`, 'tipo_medicao');
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS em_stock_turno BOOLEAN NOT NULL DEFAULT TRUE`,
    'produtos-em-stock-turno'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS venda_por_copo BOOLEAN NOT NULL DEFAULT FALSE`,
    'produtos-venda-copo'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS kg_por_copo NUMERIC(10,4) NOT NULL DEFAULT 0`,
    'produtos-kg-copo'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_copos_pacote NUMERIC(15,2) NOT NULL DEFAULT 0`,
    'produtos-preco-pacote-copo'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS qtd_copos_pacote INTEGER NOT NULL DEFAULT 0`,
    'produtos-qtd-pacote-copo'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_tara_kg NUMERIC(10,3) NOT NULL DEFAULT 0`,
    'produtos-peso-tara-kg'
  );
  await run(
    `UPDATE produtos SET venda_por_copo=true, kg_por_copo=0.27, preco=400, preco_copos_pacote=1000, qtd_copos_pacote=3, tipo_medicao='peso'
     WHERE LOWER(TRIM(nome))='fino' AND categoria='bebida' AND COALESCE(kg_por_copo,0)=0`,
    'produtos-seed-fino-copo'
  );
  await run(
    `UPDATE produtos SET peso_tara_kg = 12.9 WHERE LOWER(TRIM(nome)) = 'fino barril'`,
    'produtos-seed-fino-barril-tara'
  );
  await run(
    `UPDATE produtos SET em_stock_turno = false WHERE categoria = 'outro'`,
    'produtos-outro-sem-folha-stock'
  );
  await run(`CREATE TABLE IF NOT EXISTS armazem_stock (
    id SERIAL PRIMARY KEY,
    produto_id INTEGER NOT NULL UNIQUE REFERENCES produtos(id) ON DELETE CASCADE,
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
    custo_medio NUMERIC(15,2) NOT NULL DEFAULT 0,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, 'armazem_stock');
  await run(`CREATE TABLE IF NOT EXISTS armazem_compras (
    id SERIAL PRIMARY KEY,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
    caixas NUMERIC(12,3) NOT NULL DEFAULT 0,
    qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0,
    preco_unitario NUMERIC(15,2) NOT NULL DEFAULT 0,
    valor_total NUMERIC(15,2) NOT NULL DEFAULT 0,
    fornecedor TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    criado_por TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, 'armazem_compras');
  await run(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS caixas NUMERIC(12,3) NOT NULL DEFAULT 0`, 'armazem_compras-caixas');
  await run(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0`, 'armazem_compras-qtd-caixa');
  await run(`CREATE TABLE IF NOT EXISTS armazem_faturas (
    id SERIAL PRIMARY KEY,
    numero_fatura TEXT NOT NULL DEFAULT '',
    fornecedor TEXT NOT NULL DEFAULT '',
    data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
    notas TEXT NOT NULL DEFAULT '',
    total_valor NUMERIC(15,2) NOT NULL DEFAULT 0,
    criado_por TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, 'armazem_faturas');
  await run(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS fatura_id INTEGER REFERENCES armazem_faturas(id) ON DELETE SET NULL`, 'armazem_compras-fatura');
  await run(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS foto_fatura_url TEXT NOT NULL DEFAULT ''`, 'armazem_faturas-foto');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`, 'notas');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`, 'criado_em');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS fechado_em TIMESTAMPTZ`, 'fechado_em');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'aberto'`, 'estado');
  await run(`CREATE TABLE IF NOT EXISTS turno_stock (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    encontrado NUMERIC(10,3), entrada NUMERIC(10,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(10,3), UNIQUE(turno_id, produto_id))`, 'turno_stock');
  await run(`CREATE TABLE IF NOT EXISTS turno_caixa (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
    tpa NUMERIC(15,2), transferencia NUMERIC(15,2), dinheiro NUMERIC(15,2),
    saida NUMERIC(15,2) NOT NULL DEFAULT 0)`, 'turno_caixa');
  // Detect produtos.id type to align all FK columns
  const _pidCheck = await query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='produtos' AND column_name='id'`).catch(e=>({rows:[]}));
  const _pidType = _pidCheck.rows.length > 0 ? _pidCheck.rows[0].data_type : 'integer';
  results.push({ label: 'produtos-id-type', ok: true, type: _pidType });
  const pidCol = _pidType === 'uuid' ? 'UUID' : 'INTEGER';
  // Fix receitas
  const _rcCheck = await query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='receitas' AND column_name='produto_id'`).catch(e=>({rows:[]}));
  const _rcType = _rcCheck.rows.length > 0 ? _rcCheck.rows[0].data_type : 'not_found';
  results.push({ label: 'receitas-type-check', ok: true, type: _rcType });
  if (_rcType !== _pidType) {
    await run(`DROP TABLE IF EXISTS receitas CASCADE`, 'receitas-drop');
    await run(`CREATE TABLE receitas (id SERIAL PRIMARY KEY, produto_id ${pidCol} NOT NULL, componente_id ${pidCol} NOT NULL, quantidade NUMERIC(10,3) NOT NULL DEFAULT 1, UNIQUE(produto_id,componente_id))`, 'receitas-create');
  }
  // Fix turno_vendas
  const _tvCheck = await query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='turno_vendas' AND column_name='produto_id'`).catch(e=>({rows:[]}));
  const _tvType = _tvCheck.rows.length > 0 ? _tvCheck.rows[0].data_type : 'not_found';
  results.push({ label: 'turno_vendas-type-check', ok: true, type: _tvType });
  if (_tvType !== _pidType) {
    await run(`DROP TABLE IF EXISTS turno_vendas CASCADE`, 'turno_vendas-drop');
    await run(`CREATE TABLE turno_vendas (id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE, produto_id ${pidCol} NOT NULL REFERENCES produtos(id) ON DELETE CASCADE, quantidade NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id,produto_id))`, 'turno_vendas-create');
  }
  // Fix turno_stock
  const _tsCheck = await query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='turno_stock' AND column_name='produto_id'`).catch(e=>({rows:[]}));
  const _tsType = _tsCheck.rows.length > 0 ? _tsCheck.rows[0].data_type : 'not_found';
  results.push({ label: 'turno_stock-type-check', ok: true, type: _tsType });
  if (_tsType !== _pidType) {
    await run(`DROP TABLE IF EXISTS turno_stock CASCADE`, 'turno_stock-drop');
    await run(`CREATE TABLE turno_stock (id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE, produto_id ${pidCol} NOT NULL REFERENCES produtos(id) ON DELETE CASCADE, encontrado NUMERIC(10,3), entrada NUMERIC(10,3) NOT NULL DEFAULT 0, deixado NUMERIC(10,3), fechados NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id,produto_id))`, 'turno_stock-create');
  }
  await run(`DELETE FROM produtos WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY nome ORDER BY id::text) AS rn FROM produtos) sub WHERE rn > 1)`, 'produtos-dedup');
  await run(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='produtos_nome_key') THEN ALTER TABLE produtos ADD CONSTRAINT produtos_nome_key UNIQUE (nome); END IF; END $$`, 'produtos-unique');
  await run(`INSERT INTO produtos (nome,preco,categoria,ordem) VALUES
    ('Carne',0,'ingredientes',1),('Ovo',0,'ingredientes',2),('Enchido',0,'ingredientes',3),('Pão 12',0,'ingredientes',4),
    ('Pão 6',0,'ingredientes',5),('Batata Palha',0,'ingredientes',6),('Malonese',0,'ingredientes',7),('Mostarda',0,'ingredientes',8),
    ('Ketchup',0,'ingredientes',9),('Milho',0,'ingredientes',10),('Óleo',0,'ingredientes',11),('Molho Inglês',0,'ingredientes',12),
    ('Nata',0,'ingredientes',13),('Papel Alumínio',0,'ingredientes',14),('Saco',0,'ingredientes',15),('Palito',0,'ingredientes',16),
    ('Guardanapos',0,'ingredientes',17),('Batata Pré-frita',0,'ingredientes',18),
    ('Água Pequena',200,'bebida',19),('Smirnoff',1000,'bebida',20),('Gin Gordons Lata',1000,'bebida',21),
    ('Coca Cola Lata',700,'bebida',22),('Speed Lata',1000,'bebida',23),('Blue Laranja Lata',700,'bebida',24),
    ('Sprite Lata',700,'bebida',25),('Blue Limão Lata',700,'bebida',26),('Eka',700,'bebida',27),
    ('Booster',700,'bebida',28),('Booster Morango',700,'bebida',29),('Booster Manga',700,'bebida',30),
    ('Compal Lata',700,'bebida',31),('Sumol Ananas',700,'bebida',32),('Sumol Laranja',700,'bebida',33),
    ('Sumol Manga',700,'bebida',34),('Cuca Lata',700,'bebida',35),('Nocal Lata',700,'bebida',36),('Dopel',700,'bebida',37)
    ON CONFLICT (nome) DO NOTHING`, 'produtos-seed');
  await run(`CREATE TABLE IF NOT EXISTS escala (
    id SERIAL PRIMARY KEY,
    data DATE NOT NULL,
    turno VARCHAR(10) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
    utilizador_id TEXT,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(data, turno, utilizador_id)
  )`, 'escala');
  await run(`CREATE TABLE IF NOT EXISTS turno_equipa_real (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    utilizador_id TEXT NOT NULL,
    cobrindo_utilizador_id TEXT,
    hora_extra BOOLEAN NOT NULL DEFAULT FALSE,
    motivo_falta TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(turno_id, utilizador_id)
  )`, 'turno_equipa_real');
  await run(`CREATE TABLE IF NOT EXISTS turno_faltas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    utilizador_id TEXT NOT NULL,
    motivo_falta TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(turno_id, utilizador_id)
  )`, 'turno_faltas');
  await run(`ALTER TABLE escala ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`, 'escala-userid-text');
  await run(`ALTER TABLE turno_equipa_real ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`, 'turno_equipa_real-userid-text');
  await run(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS cobrindo_utilizador_id TEXT`, 'turno_equipa_real-cobrindo');
  await run(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS hora_extra BOOLEAN NOT NULL DEFAULT FALSE`, 'turno_equipa_real-hora-extra');
  await run(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS motivo_falta TEXT NOT NULL DEFAULT ''`, 'turno_equipa_real-motivo-falta');
  await run(`ALTER TABLE turno_faltas ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`, 'turno_faltas-userid-text');
  await run(`ALTER TABLE escala DROP CONSTRAINT IF EXISTS escala_data_turno_key`, 'escala-drop-unique-old');
  await run(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='escala_data_turno_utilizador_key') THEN ALTER TABLE escala ADD CONSTRAINT escala_data_turno_utilizador_key UNIQUE (data, turno, utilizador_id); END IF; END $$`, 'escala-add-unique-new');
  await run(`ALTER TABLE escala ADD COLUMN IF NOT EXISTS area_trabalho SMALLINT`, 'escala-area-trabalho');
  res.json({ results });
});

app.post('/api/reseed-produtos', auth, requireRole('admin'), async (req, res) => {
  try {
    await query(`ALTER TABLE produtos DROP CONSTRAINT IF EXISTS produtos_sku_key`);
    await query(`DELETE FROM comanda_itens`);
    await query(`DELETE FROM movimentacoes`);
    await query(`DELETE FROM turno_stock`);
    await query(`DELETE FROM produtos`);
    await query(`INSERT INTO produtos (nome,preco,categoria,ordem) VALUES
      ('Carne',0,'ingredientes',1),('Ovo',0,'ingredientes',2),('Enchido',0,'ingredientes',3),('Pão 12',0,'ingredientes',4),
      ('Pão 6',0,'ingredientes',5),('Batata Palha',0,'ingredientes',6),('Malonese',0,'ingredientes',7),('Mostarda',0,'ingredientes',8),
      ('Ketchup',0,'ingredientes',9),('Milho',0,'ingredientes',10),('Óleo',0,'ingredientes',11),('Molho Inglês',0,'ingredientes',12),
      ('Nata',0,'ingredientes',13),('Papel Alumínio',0,'ingredientes',14),('Saco',0,'ingredientes',15),('Palito',0,'ingredientes',16),
      ('Guardanapos',0,'ingredientes',17),('Batata Pré-frita',0,'ingredientes',18),
      ('Água Pequena',200,'bebida',19),('Smirnoff',1000,'bebida',20),('Gin Gordons Lata',1000,'bebida',21),
      ('Coca Cola Lata',700,'bebida',22),('Speed Lata',1000,'bebida',23),('Blue Laranja Lata',700,'bebida',24),
      ('Sprite Lata',700,'bebida',25),('Blue Limão Lata',700,'bebida',26),('Eka',700,'bebida',27),
      ('Booster',700,'bebida',28),('Booster Morango',700,'bebida',29),('Booster Manga',700,'bebida',30),
      ('Compal Lata',700,'bebida',31),('Sumol Ananas',700,'bebida',32),('Sumol Laranja',700,'bebida',33),
      ('Sumol Manga',700,'bebida',34),('Cuca Lata',700,'bebida',35),('Nocal Lata',700,'bebida',36),('Dopel',700,'bebida',37)`);
    res.json({ ok: true, mensagem: '37 produtos reinseridos' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const r = await query(
      'SELECT id,email,nome,role,username FROM utilizadores WHERE id=$1',
      [req.user.id]
    );
    return res.json(r.rows[0]);
  } catch (_) {
    const r = await query(
      'SELECT id,email,nome,role FROM utilizadores WHERE id=$1',
      [req.user.id]
    );
    return res.json(r.rows[0]);
  }
});

app.post('/api/auth/alterar-password', auth, async (req, res) => {
  try {
    const { passwordAtual, passwordNova } = req.body;
    if (!passwordNova || passwordNova.length < 6) return res.status(400).json({ erro: 'Nova password deve ter pelo menos 6 caracteres' });
    const r = await query('SELECT senha_hash FROM utilizadores WHERE id=$1', [req.user.id]);
    if (r.rows[0].senha_hash !== hashPassword(passwordAtual)) return res.status(400).json({ erro: 'Password actual incorrecta' });
    await query('UPDATE utilizadores SET senha_hash=$1 WHERE id=$2', [hashPassword(passwordNova), req.user.id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: 'Erro interno' }); }
});

// ── PRODUTOS ──────────────────────────────────────────────────
app.get('/api/produtos', auth, async (req, res) => {
  try {
    const todos = req.query.todos === '1';
    const r = await query(
      `SELECT * FROM produtos ${todos ? '' : 'WHERE ativo=true'} ORDER BY ordem, nome`
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/produtos', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    const {
      nome,
      preco,
      categoria,
      venda_avulso,
      tipo_medicao,
      em_stock_turno,
      venda_por_copo,
      kg_por_copo,
      preco_copos_pacote,
      qtd_copos_pacote,
      peso_tara_kg
    } = req.body;
    const medicao = tipo_medicao === 'peso' ? 'peso' : 'unidade';
    const maxOrdem = await query('SELECT COALESCE(MAX(ordem),0)+1 as n FROM produtos');
    const noTurno = em_stock_turno === undefined || em_stock_turno === null ? true : !!em_stock_turno;
    const vpc = !!venda_por_copo && (categoria || 'outro') === 'bebida';
    const kgc = vpc ? parseFloat(kg_por_copo) || 0 : 0;
    const kgcF = kgc > 0 ? kgc : 0;
    const pcp = kgcF > 0 ? parseFloat(preco_copos_pacote) || 0 : 0;
    const qcp = kgcF > 0 ? parseInt(qtd_copos_pacote, 10) || 0 : 0;
    const pt = parseFloat(peso_tara_kg);
    const pTara = Number.isFinite(pt) && pt >= 0 ? pt : 0;
    const r = await query(
      `INSERT INTO produtos (nome,preco,categoria,ordem,venda_avulso,tipo_medicao,em_stock_turno,venda_por_copo,kg_por_copo,preco_copos_pacote,qtd_copos_pacote,peso_tara_kg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        nome,
        preco || 0,
        categoria || 'outro',
        maxOrdem.rows[0].n,
        !!venda_avulso,
        medicao,
        noTurno,
        kgcF > 0,
        kgcF,
        pcp,
        qcp,
        pTara
      ]
    );
    const row = r.rows[0];
    if (_sqlUsePrecoHistorico) {
      try {
        await query(
          `INSERT INTO produto_preco_historico (produto_id, valid_from, valid_from_turno, preco, preco_copos_pacote, qtd_copos_pacote)
           VALUES ($1, DATE '2000-01-01', 'manha', $2, $3, $4)
           ON CONFLICT (produto_id, valid_from, valid_from_turno) DO UPDATE SET
             preco = EXCLUDED.preco,
             preco_copos_pacote = EXCLUDED.preco_copos_pacote,
             qtd_copos_pacote = EXCLUDED.qtd_copos_pacote`,
          [row.id, preco || 0, pcp, qcp]
        );
      } catch (e) {
        console.warn('[POST produtos hist]', e.message);
      }
    }
    res.json(row);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/produtos/:id', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    const {
      nome,
      preco,
      categoria,
      ordem,
      ativo,
      venda_avulso,
      tipo_medicao,
      em_stock_turno,
      venda_por_copo,
      kg_por_copo,
      preco_copos_pacote,
      qtd_copos_pacote,
      peso_tara_kg
    } = req.body;
    const medicao = tipo_medicao === 'peso' ? 'peso' : 'unidade';
    const noTurno =
      em_stock_turno === undefined || em_stock_turno === null ? undefined : !!em_stock_turno;
    const vpc = !!venda_por_copo && (categoria || '') === 'bebida';
    const kgc = vpc ? parseFloat(kg_por_copo) || 0 : 0;
    const kgcF = kgc > 0 ? kgc : 0;
    const pcp = kgcF > 0 ? parseFloat(preco_copos_pacote) || 0 : 0;
    const qcp = kgcF > 0 ? parseInt(qtd_copos_pacote, 10) || 0 : 0;
    const pt = parseFloat(peso_tara_kg);
    const pTara = Number.isFinite(pt) && pt >= 0 ? pt : 0;
    const copoVals = [kgcF > 0, kgcF, pcp, qcp, pTara];
    const prev = await query(
      'SELECT preco, preco_copos_pacote, qtd_copos_pacote FROM produtos WHERE id=$1',
      [req.params.id]
    );
    if (!prev.rows.length) return res.status(404).json({ erro: 'Produto não encontrado' });
    const old = prev.rows[0];
    const np = parseFloat(preco) || 0;
    const r = noTurno === undefined
      ? await query(
          `UPDATE produtos SET nome=$1,preco=$2,categoria=$3,ordem=$4,ativo=$5,venda_avulso=$6,tipo_medicao=$7,
           venda_por_copo=$8,kg_por_copo=$9,preco_copos_pacote=$10,qtd_copos_pacote=$11,peso_tara_kg=$12 WHERE id=$13 RETURNING *`,
          [nome, preco, categoria, ordem, ativo, !!venda_avulso, medicao, ...copoVals, req.params.id]
        )
      : await query(
          `UPDATE produtos SET nome=$1,preco=$2,categoria=$3,ordem=$4,ativo=$5,venda_avulso=$6,tipo_medicao=$7,em_stock_turno=$8,
           venda_por_copo=$9,kg_por_copo=$10,preco_copos_pacote=$11,qtd_copos_pacote=$12,peso_tara_kg=$13 WHERE id=$14 RETURNING *`,
          [nome, preco, categoria, ordem, ativo, !!venda_avulso, medicao, noTurno, ...copoVals, req.params.id]
        );
    try {
      await recordProdutoPrecoHistoricoIfChanged(parseInt(req.params.id, 10), old, np, pcp, qcp, req.body);
    } catch (e) {
      console.warn('[PUT produtos hist]', e.message);
    }
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/produtos/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await query('UPDATE produtos SET ativo=false WHERE id=$1', [req.params.id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ARMAZÉM ────────────────────────────────────────────────────
async function processArmazemCompraLine(client, req, body, opts) {
  opts = opts || {};
  const faturaId = opts.fatura_id != null ? opts.fatura_id : null;
  const fornecedorHeader = opts.fornecedor_header || '';
  const {
    produto_id,
    quantidade,
    caixas,
    qtd_por_caixa,
    preco_unitario,
    fornecedor,
    notas,
    novo_produto
  } = body || {};
  const caixasNum = parseFloat(caixas) || 0;
  const qtdPorCaixaNum = parseFloat(qtd_por_caixa) || 0;
  const qtyRaw = parseFloat(quantidade);
  const qty = (caixasNum > 0 && qtdPorCaixaNum > 0) ? (caixasNum * qtdPorCaixaNum) : qtyRaw;
  const precoUnit = parseFloat(preco_unitario);
  if (!qty || qty <= 0) throw new Error('Quantidade inválida');
  if (!precoUnit || precoUnit <= 0) throw new Error('Preço unitário inválido');

  let pid = produto_id;
  if (!pid && novo_produto && novo_produto.nome) {
    const nome = String(novo_produto.nome || '').trim();
    if (!nome) throw new Error('Nome do novo produto é obrigatório');
    const categoria = ['menu','ingredientes','bebida','outro'].includes(novo_produto.categoria) ? novo_produto.categoria : 'outro';
    const tipoMedicao = novo_produto.tipo_medicao === 'peso' ? 'peso' : 'unidade';
    const precoProduto = parseFloat(novo_produto.preco) || 0;
    const maxOrdem = await client.query('SELECT COALESCE(MAX(ordem),0)+1 as n FROM produtos');
    const up = await client.query(
      `INSERT INTO produtos (nome, preco, categoria, ordem, tipo_medicao)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (nome) DO UPDATE SET ativo=true
       RETURNING id`,
      [nome, precoProduto, categoria, maxOrdem.rows[0].n, tipoMedicao]
    );
    pid = up.rows[0].id;
  }
  if (!pid) throw new Error('produto_id é obrigatório');

  const total = qty * precoUnit;
  const forn = (fornecedor || '').trim() || fornecedorHeader;
  const notaLine = (notas || '').trim();
  const compra = await client.query(
    `INSERT INTO armazem_compras
     (produto_id, quantidade, caixas, qtd_por_caixa, preco_unitario, valor_total, fornecedor, notas, criado_por, fatura_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [pid, qty, caixasNum, qtdPorCaixaNum, precoUnit, total, forn, notaLine, String(req.user.id || ''), faturaId]
  );

  const prev = await client.query('SELECT quantidade, custo_medio FROM armazem_stock WHERE produto_id=$1', [pid]);
  const oldQty = prev.rows.length ? parseFloat(prev.rows[0].quantidade) || 0 : 0;
  const oldCusto = prev.rows.length ? parseFloat(prev.rows[0].custo_medio) || 0 : 0;
  const newQty = oldQty + qty;
  const newCusto = newQty > 0 ? (((oldQty * oldCusto) + total) / newQty) : precoUnit;

  await client.query(
    `INSERT INTO armazem_stock (produto_id, quantidade, custo_medio, atualizado_em)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (produto_id) DO UPDATE
     SET quantidade=$2, custo_medio=$3, atualizado_em=NOW()`,
    [pid, newQty, newCusto]
  );
  return compra.rows[0];
}

/** Recalcula stock e custo médio a partir de todas as linhas de compra do produto (após editar/apagar linha). */
async function recalculateArmazemStockForProduct(client, produtoId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(quantidade),0) AS q_sum, COALESCE(SUM(valor_total),0) AS v_sum
     FROM armazem_compras WHERE produto_id=$1`,
    [produtoId]
  );
  const q = parseFloat(r.rows[0].q_sum) || 0;
  const v = parseFloat(r.rows[0].v_sum) || 0;
  const custo = q > 0 ? v / q : 0;
  await client.query(
    `INSERT INTO armazem_stock (produto_id, quantidade, custo_medio, atualizado_em)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (produto_id) DO UPDATE
     SET quantidade=$2, custo_medio=$3, atualizado_em=NOW()`,
    [produtoId, q, custo]
  );
}

/** Actualiza total da fatura; se não restarem linhas, apaga o cabeçalho da fatura. */
async function refreshFaturaTotalAgg(client, faturaId) {
  const cnt = await client.query(`SELECT COUNT(*)::int AS n FROM armazem_compras WHERE fatura_id=$1`, [faturaId]);
  if (!cnt.rows[0].n) {
    await client.query(`DELETE FROM armazem_faturas WHERE id=$1`, [faturaId]);
    return { deletedFatura: true };
  }
  const s = await client.query(
    `SELECT COALESCE(SUM(valor_total),0) AS t FROM armazem_compras WHERE fatura_id=$1`,
    [faturaId]
  );
  const t = parseFloat(s.rows[0].t) || 0;
  await client.query(`UPDATE armazem_faturas SET total_valor=$1 WHERE id=$2`, [t, faturaId]);
  return { deletedFatura: false };
}

async function ensureFornecedores() {
  await query(`CREATE TABLE IF NOT EXISTS fornecedores (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    notas TEXT NOT NULL DEFAULT '',
    ativo BOOLEAN NOT NULL DEFAULT true,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    criado_por TEXT NOT NULL DEFAULT ''
  )`);
  await query(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS fornecedor_id INTEGER`).catch(() => {});
  await query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'armazem_faturas_fornecedor_id_fkey') THEN
      ALTER TABLE armazem_faturas ADD CONSTRAINT armazem_faturas_fornecedor_id_fkey
      FOREIGN KEY (fornecedor_id) REFERENCES fornecedores(id) ON DELETE SET NULL;
    END IF;
  END $$`).catch(() => {});
}

app.get('/api/fornecedores', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureFornecedores();
    const todos = req.query.todos === '1';
    const r = await query(
      `SELECT * FROM fornecedores ${todos ? '' : 'WHERE ativo = true'} ORDER BY LOWER(nome)`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/fornecedores', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureFornecedores();
    const { nome, notas } = req.body || {};
    const n = String(nome || '').trim();
    if (!n) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const r = await query(
      `INSERT INTO fornecedores (nome, notas, criado_por) VALUES ($1, $2, $3) RETURNING *`,
      [n, String(notas || '').trim(), String(req.user.id || '')]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.put('/api/fornecedores/:id', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureFornecedores();
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ erro: 'ID inválido' });
    const { nome, notas, ativo } = req.body || {};
    const row = await query('SELECT * FROM fornecedores WHERE id=$1', [id]);
    if (!row.rows.length) return res.status(404).json({ erro: 'Fornecedor não encontrado' });
    const nomeF = nome != null ? String(nome).trim() : row.rows[0].nome;
    if (!nomeF) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const notasF = notas != null ? String(notas).trim() : row.rows[0].notas;
    const ativoF = ativo !== undefined && ativo !== null ? !!ativo : row.rows[0].ativo;
    const r = await query(
      `UPDATE fornecedores SET nome=$1, notas=$2, ativo=$3 WHERE id=$4 RETURNING *`,
      [nomeF, notasF, ativoF, id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

async function ensureArmazemTables() {
  const pidCheck = await query(
    `SELECT data_type
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='produtos' AND column_name='id'`
  ).catch(() => ({ rows: [] }));
  const pidType = (pidCheck.rows[0] && pidCheck.rows[0].data_type) || 'integer';
  const pidCol = pidType === 'uuid' ? 'UUID' : 'INTEGER';

  const stockType = await query(
    `SELECT data_type
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='armazem_stock' AND column_name='produto_id'`
  ).catch(() => ({ rows: [] }));
  const comprasType = await query(
    `SELECT data_type
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='armazem_compras' AND column_name='produto_id'`
  ).catch(() => ({ rows: [] }));

  if (stockType.rows.length && stockType.rows[0].data_type !== pidType) {
    await query(`DROP TABLE IF EXISTS armazem_stock CASCADE`);
  }
  if (comprasType.rows.length && comprasType.rows[0].data_type !== pidType) {
    await query(`DROP TABLE IF EXISTS armazem_compras CASCADE`);
  }
  const invDiaType = await query(
    `SELECT data_type
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='armazem_inventario_diario' AND column_name='produto_id'`
  ).catch(() => ({ rows: [] }));
  if (invDiaType.rows.length && invDiaType.rows[0].data_type !== pidType) {
    await query(`DROP TABLE IF EXISTS armazem_inventario_diario CASCADE`);
  }

  await query(`CREATE TABLE IF NOT EXISTS armazem_faturas (
    id SERIAL PRIMARY KEY,
    numero_fatura TEXT NOT NULL DEFAULT '',
    fornecedor TEXT NOT NULL DEFAULT '',
    data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
    notas TEXT NOT NULL DEFAULT '',
    total_valor NUMERIC(15,2) NOT NULL DEFAULT 0,
    criado_por TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS armazem_stock (
    id SERIAL PRIMARY KEY,
    produto_id ${pidCol} NOT NULL UNIQUE REFERENCES produtos(id) ON DELETE CASCADE,
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
    custo_medio NUMERIC(15,2) NOT NULL DEFAULT 0,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS armazem_compras (
    id SERIAL PRIMARY KEY,
    produto_id ${pidCol} NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
    fatura_id INTEGER REFERENCES armazem_faturas(id) ON DELETE SET NULL,
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
    caixas NUMERIC(12,3) NOT NULL DEFAULT 0,
    qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0,
    preco_unitario NUMERIC(15,2) NOT NULL DEFAULT 0,
    valor_total NUMERIC(15,2) NOT NULL DEFAULT 0,
    fornecedor TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    criado_por TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS caixas NUMERIC(12,3) NOT NULL DEFAULT 0`).catch(()=>{});
  await query(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0`).catch(()=>{});
  await query(`ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS fatura_id INTEGER REFERENCES armazem_faturas(id) ON DELETE SET NULL`).catch(()=>{});
  await ensureTurnoSaidas();
  await query(`CREATE TABLE IF NOT EXISTS armazem_libertacoes (
    id SERIAL PRIMARY KEY,
    data DATE NOT NULL,
    valor NUMERIC(15,2) NOT NULL,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    criado_por TEXT NOT NULL DEFAULT ''
  )`).catch(() => {});
  await query(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS justificacao_excesso TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await query(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS turno_saida_id INTEGER`).catch(() => {});
  await query(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS foto_fatura_url TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'armazem_faturas_turno_saida_id_fkey') THEN
      ALTER TABLE armazem_faturas ADD CONSTRAINT armazem_faturas_turno_saida_id_fkey
      FOREIGN KEY (turno_saida_id) REFERENCES turno_saidas(id) ON DELETE SET NULL;
    END IF;
  END $$`).catch(() => {});
  await query(`CREATE TABLE IF NOT EXISTS armazem_inventario_diario (
    id SERIAL PRIMARY KEY,
    data DATE NOT NULL,
    produto_id ${pidCol} NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    encontrado NUMERIC(12,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(12,3) NOT NULL DEFAULT 0,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(data, produto_id)
  )`).catch(() => {});
  await ensureFornecedores();
}

app.get('/api/armazem/saldo', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const data = req.query.data || new Date().toISOString().split('T')[0];
    const lib = await query(`SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1`, [data]);
    const fat = await query(`SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1`, [data]);
    const lis = await query(
      `SELECT l.*, u.nome as criado_por_nome FROM armazem_libertacoes l
       LEFT JOIN utilizadores u ON u.id::text = l.criado_por::text
       WHERE l.data=$1 ORDER BY l.criado_em DESC`,
      [data]
    );
    const totalLib = parseFloat(lib.rows[0].t) || 0;
    const totalFat = parseFloat(fat.rows[0].t) || 0;
    res.json({
      data,
      total_libertacoes: totalLib,
      total_faturas: totalFat,
      saldo: totalLib - totalFat,
      libertacoes: lis.rows
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/armazem/saidas-dia', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureTurnoSaidas();
    const data = req.query.data || new Date().toISOString().split('T')[0];
    const r = await query(
      `SELECT s.id, s.turno_id, s.descricao, s.valor, s.notas, s.criado_em, t.nome as turno_nome
       FROM turno_saidas s
       JOIN turnos t ON t.id = s.turno_id
       WHERE t.data = $1
       ORDER BY s.criado_em DESC`,
      [data]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/armazem/libertacoes', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const { data, valor, notas } = req.body || {};
    const d = (data || new Date().toISOString().split('T')[0]).trim();
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ erro: 'Indique um valor positivo para a libertação.' });
    const r = await query(
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      [d, v, String(notas || '').trim(), String(req.user.id || '')]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(400).json({ erro: e.message }); }
});

app.delete('/api/armazem/libertacoes/:id', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const r = await query('DELETE FROM armazem_libertacoes WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Libertação não encontrada' });
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ erro: e.message }); }
});

app.get('/api/armazem/inventario', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const dataDia = (req.query.data || '').trim();
    const hasData = /^\d{4}-\d{2}-\d{2}$/.test(dataDia);
    if (hasData) {
      const r = await query(
        `SELECT p.id as produto_id, p.nome as produto_nome, p.categoria, p.tipo_medicao, p.ativo,
                COALESCE(a.quantidade, 0) as quantidade,
                COALESCE(a.custo_medio, 0) as custo_medio,
                a.atualizado_em,
                COALESCE(d.encontrado, 0) as armazem_encontrado,
                COALESCE(d.deixado, 0) as armazem_deixado,
                d.atualizado_em as armazem_diario_atualizado_em
         FROM produtos p
         LEFT JOIN armazem_stock a ON a.produto_id = p.id
         LEFT JOIN armazem_inventario_diario d ON d.produto_id = p.id AND d.data = $1::date
         WHERE p.ativo=true
         ORDER BY p.ordem, p.nome`,
        [dataDia]
      );
      return res.json(r.rows);
    }
    const r = await query(
      `SELECT p.id as produto_id, p.nome as produto_nome, p.categoria, p.tipo_medicao, p.ativo,
              COALESCE(a.quantidade, 0) as quantidade,
              COALESCE(a.custo_medio, 0) as custo_medio,
              a.atualizado_em
       FROM produtos p
       LEFT JOIN armazem_stock a ON a.produto_id = p.id
       WHERE p.ativo=true
       ORDER BY p.ordem, p.nome`
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/armazem/inventario-diario', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const { data, produto_id, encontrado, deixado } = req.body || {};
    const d = String(data || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ erro: 'Indica a data (YYYY-MM-DD).' });
    if (produto_id == null || produto_id === '') return res.status(400).json({ erro: 'produto_id é obrigatório.' });
    const enc = parseFloat(encontrado);
    const deix = parseFloat(deixado);
    if (!Number.isFinite(enc) || enc < 0) return res.status(400).json({ erro: '«Encontrado» inválido.' });
    if (!Number.isFinite(deix) || deix < 0) return res.status(400).json({ erro: '«Deixado» inválido.' });
    const r = await query(
      `INSERT INTO armazem_inventario_diario (data, produto_id, encontrado, deixado)
       VALUES ($1::date, $2, $3, $4)
       ON CONFLICT (data, produto_id) DO UPDATE SET
         encontrado = EXCLUDED.encontrado,
         deixado = EXCLUDED.deixado,
         atualizado_em = NOW()
       RETURNING *`,
      [d, produto_id, enc, deix]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.get('/api/armazem/compras', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '80', 10)));
    const dataDia = (req.query.data || '').trim();
    const filtroDia = /^\d{4}-\d{2}-\d{2}$/.test(dataDia);
    const r = filtroDia
      ? await query(
          `SELECT c.*, p.nome as produto_nome, p.tipo_medicao, u.nome as criado_por_nome, f.numero_fatura as fatura_numero
           FROM armazem_compras c
           JOIN produtos p ON p.id = c.produto_id
           LEFT JOIN utilizadores u ON u.id::text = c.criado_por::text
           LEFT JOIN armazem_faturas f ON f.id = c.fatura_id
           WHERE (c.fatura_id IS NOT NULL AND f.data_emissao = $1::date)
              OR (c.fatura_id IS NULL AND c.criado_em::date = $1::date)
           ORDER BY c.criado_em DESC
           LIMIT ${limit}`,
          [dataDia]
        )
      : await query(
          `SELECT c.*, p.nome as produto_nome, p.tipo_medicao, u.nome as criado_por_nome, f.numero_fatura as fatura_numero
           FROM armazem_compras c
           JOIN produtos p ON p.id = c.produto_id
           LEFT JOIN utilizadores u ON u.id::text = c.criado_por::text
           LEFT JOIN armazem_faturas f ON f.id = c.fatura_id
           ORDER BY c.criado_em DESC
           LIMIT ${limit}`
        );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/armazem/compras', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  await ensureArmazemTables();
  let rowId = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await processArmazemCompraLine(client, req, req.body, {});
    rowId = row.id;
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ erro: e.message });
  } finally {
    await client.release();
  }
  const merged = await query(
    `SELECT c.*, p.nome as produto_nome, p.tipo_medicao
     FROM armazem_compras c
     JOIN produtos p ON p.id=c.produto_id
     WHERE c.id=$1`,
    [rowId]
  );
  res.json(merged.rows[0]);
});

app.delete('/api/armazem/compras/:id', auth, requireRole('admin'), async (req, res) => {
  await ensureArmazemTables();
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ erro: 'ID inválido' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query('SELECT * FROM armazem_compras WHERE id=$1', [id]);
    if (!old.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Linha não encontrada' });
    }
    const row = old.rows[0];
    const pid = row.produto_id;
    const fid = row.fatura_id;
    await client.query('DELETE FROM armazem_compras WHERE id=$1', [id]);
    await recalculateArmazemStockForProduct(client, pid);
    let fatura_deleted = false;
    if (fid != null) {
      const r = await refreshFaturaTotalAgg(client, fid);
      fatura_deleted = r.deletedFatura;
    }
    await client.query('COMMIT');
    res.json({ ok: true, fatura_deleted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ erro: e.message });
  } finally {
    await client.release();
  }
});

app.put('/api/armazem/compras/:id', auth, requireRole('admin'), async (req, res) => {
  await ensureArmazemTables();
  const id = parseInt(String(req.params.id || ''), 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ erro: 'ID inválido' });
  const body = req.body || {};
  const caixasNum = parseFloat(body.caixas) || 0;
  const qtdPorCaixaNum = parseFloat(body.qtd_por_caixa) || 0;
  const qtyRaw = parseFloat(body.quantidade);
  const qty = caixasNum > 0 && qtdPorCaixaNum > 0 ? caixasNum * qtdPorCaixaNum : qtyRaw;
  const precoUnit = parseFloat(body.preco_unitario);
  const pidNew = body.produto_id != null && body.produto_id !== '' ? body.produto_id : null;
  if (!qty || qty <= 0) return res.status(400).json({ erro: 'Quantidade inválida' });
  if (!precoUnit || precoUnit <= 0) return res.status(400).json({ erro: 'Preço unitário inválido' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query('SELECT * FROM armazem_compras WHERE id=$1', [id]);
    if (!old.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Linha não encontrada' });
    }
    const row = old.rows[0];
    const pidOld = row.produto_id;
    const pid = pidNew != null ? pidNew : pidOld;
    const chk = await client.query('SELECT 1 FROM produtos WHERE id=$1', [pid]);
    if (!chk.rows.length) throw new Error('Produto inválido');
    const total = qty * precoUnit;
    const forn = String(body.fornecedor != null ? body.fornecedor : row.fornecedor || '').trim();
    const notaLine = String(body.notas != null ? body.notas : row.notas || '').trim();
    await client.query(
      `UPDATE armazem_compras SET produto_id=$1, quantidade=$2, caixas=$3, qtd_por_caixa=$4,
       preco_unitario=$5, valor_total=$6, fornecedor=$7, notas=$8 WHERE id=$9`,
      [pid, qty, caixasNum, qtdPorCaixaNum, precoUnit, total, forn, notaLine, id]
    );
    const pids = new Set([String(pidOld), String(pid)]);
    for (const p of pids) {
      await recalculateArmazemStockForProduct(client, p);
    }
    if (row.fatura_id != null) await refreshFaturaTotalAgg(client, row.fatura_id);
    await client.query('COMMIT');
    const merged = await query(
      `SELECT c.*, p.nome as produto_nome, p.tipo_medicao
       FROM armazem_compras c JOIN produtos p ON p.id=c.produto_id WHERE c.id=$1`,
      [id]
    );
    res.json(merged.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ erro: e.message });
  } finally {
    await client.release();
  }
});

app.get('/api/armazem/faturas', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '40', 10)));
    const dataDia = (req.query.data || '').trim();
    const filtroDia = /^\d{4}-\d{2}-\d{2}$/.test(dataDia);
    const r = filtroDia
      ? await query(
          `SELECT * FROM armazem_faturas WHERE data_emissao = $1::date ORDER BY criado_em DESC LIMIT ${limit}`,
          [dataDia]
        )
      : await query(
          `SELECT * FROM armazem_faturas ORDER BY data_emissao DESC, criado_em DESC LIMIT ${limit}`
        );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/armazem/faturas/:id', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const f = await query('SELECT * FROM armazem_faturas WHERE id=$1', [req.params.id]);
    if (!f.rows.length) return res.status(404).json({ erro: 'Fatura não encontrada' });
    const linhas = await query(
      `SELECT c.*, p.nome as produto_nome, p.tipo_medicao
       FROM armazem_compras c JOIN produtos p ON p.id=c.produto_id
       WHERE c.fatura_id=$1 ORDER BY c.id`,
      [req.params.id]
    );
    res.json({ ...f.rows[0], linhas: linhas.rows });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/armazem/faturas', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  await ensureArmazemTables();
  let fid = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      numero_fatura,
      fornecedor,
      data_emissao,
      notas,
      linhas,
      justificacao_excesso,
      turno_saida_id,
      foto_fatura_base64,
      fornecedor_id: fornecedorIdBody
    } = req.body || {};
    if (!Array.isArray(linhas) || !linhas.length) throw new Error('Adicione pelo menos uma linha à fatura');
    const dataFat = (data_emissao || new Date().toISOString().split('T')[0]).trim();

    let fornecedorNome = (fornecedor || '').trim();
    let fornecedorId = null;
    if (fornecedorIdBody != null && fornecedorIdBody !== '') {
      const fid = parseInt(fornecedorIdBody, 10);
      if (!Number.isNaN(fid)) {
        const fr = await client.query(
          'SELECT id, nome FROM fornecedores WHERE id=$1 AND ativo IS TRUE',
          [fid]
        );
        if (fr.rows.length) {
          fornecedorId = fr.rows[0].id;
          fornecedorNome = String(fr.rows[0].nome || '').trim();
        }
      }
    }
    const libRow = await client.query(`SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1`, [dataFat]);
    const fatRow = await client.query(`SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1`, [dataFat]);
    const totalLib = parseFloat(libRow.rows[0].t) || 0;
    const totalFatExistente = parseFloat(fatRow.rows[0].t) || 0;
    const saldoDisponivel = totalLib - totalFatExistente;

    let sumTotal = 0;
    for (const linha of linhas) {
      const qty = (() => {
        const caixasNum = parseFloat(linha.caixas) || 0;
        const qtdPor = parseFloat(linha.qtd_por_caixa) || 0;
        const qtyRaw = parseFloat(linha.quantidade);
        return (caixasNum > 0 && qtdPor > 0) ? (caixasNum * qtdPor) : qtyRaw;
      })();
      const pu = parseFloat(linha.preco_unitario);
      if (!qty || qty <= 0 || !pu || pu <= 0) throw new Error('Cada linha válida precisa de quantidade e preço unitário.');
      sumTotal += qty * pu;
    }

    let just = String(justificacao_excesso || '').trim();
    let tsid = turno_saida_id != null && turno_saida_id !== '' ? parseInt(turno_saida_id, 10) : null;
    if (Number.isNaN(tsid)) tsid = null;

    if (sumTotal > saldoDisponivel + 0.005) {
      if (just.length < 8) {
        throw new Error(
          'O total da fatura excede o saldo disponível para este dia (libertações − faturas já registadas). ' +
          'Indica uma justificação da origem do dinheiro (ex.: saída de caixa, outro fundo).'
        );
      }
      if (tsid != null) {
        const chk = await client.query(
          `SELECT s.id FROM turno_saidas s JOIN turnos t ON t.id = s.turno_id WHERE s.id = $1 AND t.data = $2`,
          [tsid, dataFat]
        );
        if (!chk.rows.length) {
          throw new Error('A saída de caixa seleccionada não pertence ao mesmo dia da fatura.');
        }
      }
    } else {
      just = '';
      tsid = null;
    }

    const ins = await client.query(
      `INSERT INTO armazem_faturas (numero_fatura, fornecedor, data_emissao, notas, criado_por, justificacao_excesso, turno_saida_id, fornecedor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        (numero_fatura || '').trim(),
        fornecedorNome,
        dataFat,
        (notas || '').trim(),
        String(req.user.id || ''),
        just,
        tsid,
        fornecedorId
      ]
    );
    fid = ins.rows[0].id;
    const forn = fornecedorNome;
    sumTotal = 0;
    for (const linha of linhas) {
      const row = await processArmazemCompraLine(client, req, linha, { fatura_id: fid, fornecedor_header: forn });
      sumTotal += parseFloat(row.valor_total) || 0;
    }
    await client.query('UPDATE armazem_faturas SET total_valor=$1 WHERE id=$2', [sumTotal, fid]);
    const fotoRaw = String(foto_fatura_base64 || '').trim();
    if (fotoRaw) await applyFaturaFotoUrl(client, fid, fotoRaw);
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ erro: e.message });
  } finally {
    await client.release();
  }
  const fat = await query('SELECT * FROM armazem_faturas WHERE id=$1', [fid]);
  const linhasOut = await query(
    `SELECT c.*, p.nome as produto_nome, p.tipo_medicao
     FROM armazem_compras c JOIN produtos p ON p.id=c.produto_id
     WHERE c.fatura_id=$1 ORDER BY c.id`,
    [fid]
  );
  res.json({ ...fat.rows[0], linhas: linhasOut.rows });
});

// ── TURNOS ────────────────────────────────────────────────────
app.get('/api/dia', auth, async (req, res) => {
  try {
    const data = req.query.data || new Date().toISOString().split('T')[0];
    const resumo =
      req.query.resumo === '1' ||
      req.query.resumo === 'true' ||
      String(req.query.resumo || '').toLowerCase() === 'yes';
    const turnoOnlyRaw = req.query.turno_id;
    const turnoOnlyId =
      !resumo && turnoOnlyRaw != null && String(turnoOnlyRaw).trim() !== ''
        ? parseInt(String(turnoOnlyRaw).trim(), 10)
        : NaN;
    const turnoOnlyFilter = Number.isFinite(turnoOnlyId) && turnoOnlyId > 0 ? turnoOnlyId : null;

    const turnos = await query(
      turnoOnlyFilter
        ? `SELECT t.*, u.nome as utilizador_nome FROM turnos t
           LEFT JOIN utilizadores u ON t.utilizador_id=u.id
           WHERE t.data=$1 AND t.id=$2`
        : `SELECT t.*, u.nome as utilizador_nome FROM turnos t
           LEFT JOIN utilizadores u ON t.utilizador_id=u.id
           WHERE t.data=$1
           ORDER BY CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`,
      turnoOnlyFilter ? [data, turnoOnlyFilter] : [data]
    );

    if (!turnos.rows.length) {
      return res.json([]);
    }

    const ids = turnos.rows.map((t) => t.id);

    /** Vista lista (página Dia, depósitos): sem linhas de stock nem comparação com turno anterior — muito mais rápido. */
    if (resumo) {
      const [caixaAll, vendasAgg] = await Promise.all([
        query(`SELECT * FROM turno_caixa WHERE turno_id = ANY($1::int[])`, [ids]),
        query(
          `SELECT ts.turno_id,
             COALESCE(SUM(${sqlTsValorVendaLinha()}), 0)::numeric AS total_vendas
           FROM turno_stock ts
           INNER JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
           INNER JOIN turnos t ON t.id = ts.turno_id
           WHERE ts.turno_id = ANY($1::int[])
           GROUP BY ts.turno_id`,
          [ids]
        )
      ]);
      const caixaByTurno = {};
      for (const row of caixaAll.rows) {
        caixaByTurno[row.turno_id] = row;
      }
      const vendasByTurno = {};
      for (const row of vendasAgg.rows) {
        vendasByTurno[row.turno_id] = parseFloat(row.total_vendas) || 0;
      }
      const result = [];
      for (const turno of turnos.rows) {
        const c = caixaByTurno[turno.id] || { tpa: null, transferencia: null, dinheiro: null, saida: 0 };
        const totalGerado = sumCaixaGeradoRow(c);
        const totalFinal =
          totalGerado === null ? null : totalGerado - parseFloat(c.saida || 0);
        result.push({
          ...turno,
          stock: [],
          caixa: { ...c, total_gerado: totalGerado, total_final: totalFinal },
          total_vendas: vendasByTurno[turno.id] || 0
        });
      }
      return res.json(result);
    }

    const [stockAll, caixaAll] = await Promise.all([
      query(
        `SELECT ts.*, p.nome as produto_nome,
                ${sqlPPrecoNaData()} AS preco,
                p.categoria, p.ordem, p.tipo_medicao,
                COALESCE(p.peso_tara_kg, 0)::numeric AS peso_tara_kg
         FROM turno_stock ts
         JOIN produtos p ON ts.produto_id=p.id
         JOIN turnos t ON t.id = ts.turno_id
         WHERE ts.turno_id = ANY($1::int[]) AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
         ORDER BY ts.turno_id, p.ordem, p.nome`,
        [ids]
      ),
      query(`SELECT * FROM turno_caixa WHERE turno_id = ANY($1::int[])`, [ids])
    ]);

    const stockByTurno = {};
    for (const row of stockAll.rows) {
      if (!stockByTurno[row.turno_id]) stockByTurno[row.turno_id] = [];
      stockByTurno[row.turno_id].push(row);
    }
    const caixaByTurno = {};
    for (const row of caixaAll.rows) {
      caixaByTurno[row.turno_id] = row;
    }

    const prevKeys = new Set();
    const prevPairs = [];
    for (const turno of turnos.rows) {
      const p = prevTurno(turno.nome, data);
      const k = `${p.data}\t${p.nome}`;
      if (!prevKeys.has(k)) {
        prevKeys.add(k);
        prevPairs.push([p.data, p.nome]);
      }
    }

    const prevMapByDN = {};
    if (prevPairs.length) {
      const conds = prevPairs.map((_, i) => `(t.data = $${i * 2 + 1} AND t.nome = $${i * 2 + 2})`).join(' OR ');
      const params = prevPairs.flat();
      const prevStock = await query(
        `SELECT ts.produto_id, ts.deixado, t.data, t.nome
         FROM turno_stock ts
         JOIN turnos t ON ts.turno_id=t.id
         JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
         WHERE ${conds}`,
        params
      );
      for (const r of prevStock.rows) {
        const dk = `${normDataPostgres(r.data)}|${r.nome}`;
        if (!prevMapByDN[dk]) prevMapByDN[dk] = {};
        prevMapByDN[dk][r.produto_id] = parseFloat(r.deixado);
      }
    }

    const result = [];
    for (const turno of turnos.rows) {
      const stock = stockByTurno[turno.id] || [];
      const prev = prevTurno(turno.nome, data);
      const prevMap = prevMapByDN[`${normDataPostgres(prev.data)}|${prev.nome}`] || {};

      const stockFinal = stock.map((s) => {
        const enc =
          s.encontrado != null && s.encontrado !== '' ? parseFloat(s.encontrado) : NaN;
        const ent = parseFloat(s.entrada);
        const dei = s.deixado != null && s.deixado !== '' ? parseFloat(s.deixado) : NaN;
        const vend =
          Number.isFinite(enc) && Number.isFinite(dei)
            ? Math.max(0, enc + (Number.isFinite(ent) ? ent : 0) - dei)
            : null;
        const snap = s.valor_vendas_reportado_kz;
        const val =
          snap != null && snap !== '' && !Number.isNaN(parseFloat(snap))
            ? parseFloat(snap)
            : vend === null
              ? null
              : vend * parseFloat(s.preco);

        let comparacao = null;
        if (prevMap[s.produto_id] !== undefined && Number.isFinite(enc)) {
          const diff = enc - prevMap[s.produto_id];
          if (Math.abs(diff) < 0.001) comparacao = 'igual';
          else if (diff < 0) comparacao = `falta ${Math.abs(diff)}`;
          else comparacao = `sobra ${diff}`;
        }
        const prevDeixado = prevMap[s.produto_id] !== undefined ? prevMap[s.produto_id] : null;
        return { ...s, vendido: vend, valor: val, comparacao, prev_deixado: prevDeixado };
      });

      const c = caixaByTurno[turno.id] || { tpa: null, transferencia: null, dinheiro: null, saida: 0 };
      const totalGerado = sumCaixaGeradoRow(c);
      const totalFinal =
        totalGerado === null ? null : totalGerado - parseFloat(c.saida || 0);
      const totalVendas = stockFinal.reduce(
        (sum, s) => sum + (typeof s.valor === 'number' && Number.isFinite(s.valor) ? s.valor : 0),
        0
      );

      result.push({
        ...turno,
        stock: stockFinal,
        caixa: { ...c, total_gerado: totalGerado, total_final: totalFinal },
        total_vendas: totalVendas
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** Lista leve de turnos num mês (calendário): id, data, nome, estado. */
app.get('/api/calendario-turnos', auth, async (req, res) => {
  try {
    const y = parseInt(req.query.ano, 10);
    const m = parseInt(req.query.mes, 10);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
      return res.status(400).json({ erro: 'Parâmetros ano e mes (1–12) são obrigatórios.' });
    }
    const pad = (n) => String(n).padStart(2, '0');
    const dataIni = `${y}-${pad(m)}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const dataFim = `${y}-${pad(m)}-${pad(lastDay)}`;
    const r = await query(
      `SELECT id, data, nome, estado FROM turnos
       WHERE data >= $1::date AND data <= $2::date
       ORDER BY data, CASE nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 9 END`,
      [dataIni, dataFim]
    );
    const rows = r.rows.map((row) => ({
      id: row.id,
      data: normDataPostgres(row.data),
      nome: row.nome,
      estado: row.estado
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/turnos/abrir', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { data, nome } = req.body;
    if (!data || !nome) throw new Error('Data e nome obrigatórios');
    assertPodeAbrirTurno(data, nome);

    const exists = await client.query('SELECT id FROM turnos WHERE data=$1 AND nome=$2', [data, nome]);
    if (exists.rows.length) throw new Error(`Turno ${nome} já existe para ${data}`);

    const turno = await client.query(
      'INSERT INTO turnos (data, nome, utilizador_id) VALUES ($1,$2,$3) RETURNING *',
      [data, nome, req.user.id]
    );
    const turnoId = turno.rows[0].id;

    // Stock do turno: só produtos activos marcados para a folha de stock
    const produtos = await client.query(
      `SELECT id FROM produtos WHERE ativo=true AND em_stock_turno IS TRUE AND ${SQL_STOCK_CATEGORIAS} ORDER BY ordem`
    );
    for (const p of produtos.rows) {
      await client.query(
        'INSERT INTO turno_stock (turno_id, produto_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [turnoId, p.id]
      );
    }

    // Criar entrada de caixa
    await client.query('INSERT INTO turno_caixa (turno_id) VALUES ($1) ON CONFLICT DO NOTHING', [turnoId]);

    await client.query('COMMIT');
    res.json(turno.rows[0]);
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({ erro: e.message });
  } finally { client.release(); }
});

app.post('/api/turnos/:id/fechar', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      "UPDATE turnos SET estado='fechado', fechado_em=NOW() WHERE id=$1 AND estado='aberto' RETURNING *",
      [req.params.id]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Turno não encontrado ou já fechado' });
    }
    const turnoId = parseInt(req.params.id, 10);
    const eqReal = await client.query(
      'SELECT 1 FROM turno_equipa_real WHERE turno_id=$1 LIMIT 1',
      [turnoId]
    );
    if (!eqReal.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        erro:
          'Regista pelo menos uma pessoa em «Quem realmente trabalhou» (separador Escala) antes de fechar o turno.'
      });
    }
    await client.query(
      `UPDATE turno_stock ts
       SET valor_vendas_reportado_kz = (${sqlFechoTurnoStockValorKz()})
       FROM produtos p, turnos tu
       WHERE ts.produto_id = p.id AND ts.turno_id = tu.id AND ts.turno_id = $1`,
      [turnoId]
    );
    await client.query(
      `UPDATE turno_vendas tv
       SET ${sqlFechoTurnoVendasSnapshotsSet()}
       FROM produtos p, turnos tu
       WHERE tv.produto_id = p.id AND tv.turno_id = tu.id AND tv.turno_id = $1`,
      [turnoId]
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

/** Só admin: voltar a permitir edição após fecho (correcção de erros). */
app.post('/api/turnos/:id/reabrir', auth, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      "UPDATE turnos SET estado='aberto', fechado_em=NULL WHERE id=$1 AND estado='fechado' RETURNING *",
      [req.params.id]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Turno não encontrado ou já está aberto' });
    }
    const turnoId = parseInt(req.params.id, 10);
    await client.query(`UPDATE turno_stock SET valor_vendas_reportado_kz = NULL WHERE turno_id=$1`, [turnoId]);
    await client.query(
      `UPDATE turno_vendas SET preco_unit_snapshot = NULL, preco_copos_pacote_snapshot = NULL, qtd_copos_pacote_snapshot = NULL WHERE turno_id=$1`,
      [turnoId]
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

function parseOptionalNumericBody(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Soma TPA+transf+din só quando os três têm valor; senão null. */
function sumCaixaGeradoRow(row) {
  if (!row) return null;
  const t = parseOptionalNumericBody(row.tpa);
  const tr = parseOptionalNumericBody(row.transferencia);
  const d = parseOptionalNumericBody(row.dinheiro);
  if (t === null || tr === null || d === null) return null;
  return t + tr + d;
}

app.put('/api/turnos/:id/stock', auth, async (req, res) => {
  try {
    const { produto_id, encontrado, deixado, fechados } = req.body;
    const chk = await query(
      `SELECT 1 FROM produtos WHERE id=$1 AND em_stock_turno IS TRUE AND ${SQL_STOCK_CATEGORIAS}`,
      [produto_id]
    );
    if (!chk.rows.length) {
      return res.status(400).json({
        erro: 'Este produto não está incluído na folha de stock do turno. Activa «Stock no turno» em Produtos.'
      });
    }
    const enc = parseOptionalNumericBody(encontrado);
    const deix = parseOptionalNumericBody(deixado);
    const r = await query(
      `INSERT INTO turno_stock (turno_id, produto_id, encontrado, deixado, fechados)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (turno_id, produto_id)
       DO UPDATE SET encontrado=$3, deixado=$4, fechados=$5
       RETURNING *`,
      [req.params.id, produto_id, enc, deix, fechados || 0]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── TURNO: entradas de stock + saídas de caixa (caixa.saida = despesas + compras stock) ──
async function ensureTurnoEntradas() {
  await query(`CREATE TABLE IF NOT EXISTS turno_entradas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    tipo VARCHAR(10) NOT NULL DEFAULT 'entrada',
    origem VARCHAR(10) NOT NULL DEFAULT 'armazem',
    preco NUMERIC(15,2) NOT NULL DEFAULT 0,
    quantidade NUMERIC(10,3) NOT NULL DEFAULT 0,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`ALTER TABLE turno_entradas ADD COLUMN IF NOT EXISTS tipo VARCHAR(10) NOT NULL DEFAULT 'entrada'`).catch(()=>{});
  await query(`ALTER TABLE turno_entradas ADD COLUMN IF NOT EXISTS origem VARCHAR(10) NOT NULL DEFAULT 'armazem'`).catch(()=>{});
  await query(`ALTER TABLE turno_entradas ADD COLUMN IF NOT EXISTS preco NUMERIC(15,2) NOT NULL DEFAULT 0`).catch(()=>{});
}

app.get('/api/turnos/:id/entradas', auth, async (req, res) => {
  try {
    const r = await query(
      `SELECT te.*, p.nome as produto_nome, p.tipo_medicao
       FROM turno_entradas te JOIN produtos p ON te.produto_id=p.id
       WHERE te.turno_id=$1 ORDER BY te.criado_em DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) {
    if (e.message.includes('does not exist')) {
      try { await ensureTurnoEntradas(); res.json([]); } catch(e2) { res.status(500).json({ erro: e2.message }); }
    } else { res.status(500).json({ erro: e.message }); }
  }
});

app.post('/api/turnos/:id/entradas', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const turnoId = req.params.id;
    const { produto_id, tipo, origem, preco, quantidade, notas } = req.body;
    if (!produto_id || !quantidade || parseFloat(quantidade) <= 0)
      throw new Error('produto_id e quantidade (> 0) são obrigatórios');
    const notasVal = String(notas != null ? notas : '').trim();
    const tipoVal   = tipo   === 'tirar'  ? 'tirar'  : 'entrada';
    const origemVal = origem === 'compra' ? 'compra' : 'armazem';
    const precoVal  = origemVal === 'compra' ? (parseFloat(preco) || 0) : 0;

    const emStock = await client.query(
      `SELECT 1 FROM produtos WHERE id=$1 AND em_stock_turno IS TRUE AND ${SQL_STOCK_CATEGORIAS}`,
      [produto_id]
    );
    if (!emStock.rows.length) {
      throw new Error(
        'Este produto não está na folha de stock do turno. Activa «Stock no turno» em Produtos ou regista no armazém.'
      );
    }

    const registo = await client.query(
      'INSERT INTO turno_entradas (turno_id, produto_id, tipo, origem, preco, quantidade, notas) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [turnoId, produto_id, tipoVal, origemVal, precoVal, quantidade, notasVal]
    );

    // entrada = soma das entradas - soma das saídas
    await client.query(
      `UPDATE turno_stock SET entrada=(
         SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END),0)
         FROM turno_entradas WHERE turno_id=$1 AND produto_id=$2
       ) WHERE turno_id=$1 AND produto_id=$2`,
      [turnoId, produto_id]
    );

    // Se for compra, recalcular saida da caixa
    if (origemVal === 'compra') {
      const novasSaida = await calcSaidaTotal(turnoId, client);
      await client.query(`UPDATE turno_caixa SET saida=$1 WHERE turno_id=$2`, [novasSaida, turnoId]).catch(()=>{});
    }

    await client.query('COMMIT');
    res.json(registo.rows[0]);
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    if (e.message.includes('does not exist')) {
      try { await ensureTurnoEntradas(); } catch(_) {}
    }
    res.status(400).json({ erro: e.message });
  } finally { client.release(); }
});

// saida = despesas directas + compras de stock
async function calcSaidaTotal(turnoId, client) {
  const q = client ? (s, p) => client.query(s, p) : query;
  const despesas = await q(`SELECT COALESCE(SUM(valor),0) as t FROM turno_saidas WHERE turno_id=$1`, [turnoId]).catch(() => ({ rows: [{ t: 0 }] }));
  const compras  = await q(`SELECT COALESCE(SUM(preco),0) as t FROM turno_entradas WHERE turno_id=$1 AND origem='compra' AND tipo='entrada'`, [turnoId]).catch(() => ({ rows: [{ t: 0 }] }));
  return parseFloat(despesas.rows[0].t) + parseFloat(compras.rows[0].t);
}

app.put('/api/turnos/:id/notas', auth, async (req, res) => {
  try {
    const { notas } = req.body;
    const r = await query(
      'UPDATE turnos SET notas=$1 WHERE id=$2 RETURNING notas',
      [notas || '', req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Turno não encontrado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/turnos/:id/caixa', auth, async (req, res) => {
  try {
    const { tpa, transferencia, dinheiro } = req.body;
    const saida = await calcSaidaTotal(req.params.id, null);
    const tpaV = parseOptionalNumericBody(tpa);
    const trV = parseOptionalNumericBody(transferencia);
    const diV = parseOptionalNumericBody(dinheiro);
    const r = await query(
      `INSERT INTO turno_caixa (turno_id, tpa, transferencia, dinheiro, saida)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (turno_id)
       DO UPDATE SET tpa=$2, transferencia=$3, dinheiro=$4, saida=$5
       RETURNING *`,
      [req.params.id, tpaV, trV, diV, saida]
    );
    const c = r.rows[0];
    const tg = sumCaixaGeradoRow(c);
    c.total_gerado = tg;
    c.total_final = tg === null ? null : tg - parseFloat(c.saida || 0);
    res.json(c);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

async function ensureTurnoSaidas() {
  await query(`CREATE TABLE IF NOT EXISTS turno_saidas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL DEFAULT '',
    valor NUMERIC(15,2) NOT NULL DEFAULT 0,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

app.get('/api/turnos/:id/saidas', auth, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM turno_saidas WHERE turno_id=$1 ORDER BY criado_em DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) {
    if (e.message.includes('does not exist')) {
      try { await ensureTurnoSaidas(); res.json([]); } catch(e2) { res.status(500).json({ erro: e2.message }); }
    } else { res.status(500).json({ erro: e.message }); }
  }
});

app.post('/api/turnos/:id/saidas', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const turnoId = req.params.id;
    const { descricao, valor, notas } = req.body;
    if (!descricao || !descricao.trim()) throw new Error('Descrição é obrigatória');
    if (!valor || parseFloat(valor) <= 0) throw new Error('Valor deve ser maior que 0');
    const notasVal = String(notas != null ? notas : '').trim();

    const r = await client.query(
      'INSERT INTO turno_saidas (turno_id, descricao, valor, notas) VALUES ($1,$2,$3,$4) RETURNING *',
      [turnoId, descricao.trim(), valor, notasVal]
    );
    // Recalcular saida na caixa (despesas + compras)
    const novasSaida = await calcSaidaTotal(turnoId, client);
    await client.query(`UPDATE turno_caixa SET saida=$1 WHERE turno_id=$2`, [novasSaida, turnoId]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    if (e.message.includes('does not exist')) { try { await ensureTurnoSaidas(); } catch(_) {} }
    res.status(400).json({ erro: e.message });
  } finally { client.release(); }
});

/** Resposta de /escala/semana (template muda raramente). */
const _escalaSemanaCache = new Map();
const ESCALA_SEMANA_CACHE_MS = Math.max(
  5000,
  (parseInt(process.env.ESCALA_SEMANA_CACHE_SEC || '45', 10) || 45) * 1000
);
function clearEscalaSemanaCache() {
  _escalaSemanaCache.clear();
}

app.get('/api/depositos', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const data = (req.query.data || '').trim();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '80', 10)));
    let sql = `SELECT d.*, u.nome AS criado_por_nome, t.nome AS turno_nome, t.data AS turno_data
               FROM depositos_banco d
               JOIN turnos t ON t.id = d.turno_id
               LEFT JOIN utilizadores u ON u.id::text = d.criado_por::text`;
    const params = [];
    if (data) {
      sql += ` WHERE t.data = $1`;
      params.push(data);
    }
    sql += ` ORDER BY t.data DESC, CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END, d.criado_em DESC LIMIT ${limit}`;
    const r = await query(sql, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/depositos', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const { turno_id, data_deposito, valor_tpa, referencia, notas } = req.body || {};
    let pv;
    try {
      pv = parseDepositoValores(req.body || {});
    } catch (e) {
      return res.status(400).json({ erro: e.message });
    }
    if (!pv) return res.status(400).json({ erro: 'Indique o valor bruto (antes de saídas) ou o valor líquido depositado.' });
    const v = pv.valor;
    const vsaida = pv.valor_saidas;
    const saidasDestino = sanitizeSaidasDestino(req.body?.saidas_destino);
    if (vsaida > 0 && !saidasDestino) {
      return res.status(400).json({ erro: 'Indica o que foi comprado para o armazém / stock (obrigatório quando há valor retirado do depósito).' });
    }
    const vtpa = parseFloat(valor_tpa);
    if (Number.isNaN(vtpa) || vtpa < 0) return res.status(400).json({ erro: 'Indique o valor registado no TPA (≥ 0).' });
    await assertTurnoFechado(turno_id);
    const ddep = (data_deposito || new Date().toISOString().split('T')[0]).trim();
    const r = await query(
      `INSERT INTO depositos_banco (turno_id, data_deposito, valor, valor_tpa, valor_saidas, saidas_destino, referencia, notas, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (turno_id) DO UPDATE SET
         data_deposito = EXCLUDED.data_deposito,
         valor = EXCLUDED.valor,
         valor_tpa = EXCLUDED.valor_tpa,
         valor_saidas = EXCLUDED.valor_saidas,
         saidas_destino = EXCLUDED.saidas_destino,
         referencia = EXCLUDED.referencia,
         notas = EXCLUDED.notas,
         criado_em = NOW()
       RETURNING *`,
      [
        parseInt(turno_id, 10),
        ddep,
        v,
        vtpa,
        vsaida,
        vsaida > 0 ? saidasDestino : '',
        String(referencia || '').trim(),
        String(notas || '').trim(),
        String(req.user.id || '')
      ]
    );
    const row = r.rows[0];
    const u = await query('SELECT nome FROM utilizadores WHERE id=$1', [req.user.id]).catch(() => ({ rows: [] }));
    const tn = await query(`SELECT nome, data FROM turnos WHERE id = $1`, [row.turno_id]).catch(() => ({ rows: [] }));
    res.json({
      ...row,
      criado_por_nome: u.rows[0]?.nome || '',
      turno_nome: tn.rows[0]?.nome || '',
      turno_data: tn.rows[0]?.data || null
    });
  } catch(e) {
    res.status(400).json({ erro: e.message });
  }
});

app.post('/api/depositos/lote', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const { itens, valor_saidas_total, saidas_destino: saidasDestinoBody, bordero_foto_base64 } = req.body || {};
    const saidasTotalRaw = parseFloat(valor_saidas_total);
    const saidasTotal = Number.isNaN(saidasTotalRaw) ? 0 : Math.max(0, saidasTotalRaw);
    const saidasDestino = sanitizeSaidasDestino(saidasDestinoBody);
    if (saidasTotal > 0 && !saidasDestino) {
      return res.status(400).json({ erro: 'Indica o que foi comprado para o armazém / stock (obrigatório quando há valor retirado do depósito).' });
    }
    if (!Array.isArray(itens) || !itens.length) {
      return res.status(400).json({ erro: 'Envia os depósitos por turno (lista itens).' });
    }
    const valid = [];
    for (const raw of itens) {
      const tid = parseInt(raw.turno_id, 10);
      if (!tid) continue;
      let pv;
      try {
        const rawSemSaidasPorTurno = { ...raw, valor_saidas: 0 };
        pv = parseDepositoValores(rawSemSaidasPorTurno);
      } catch (e) {
        return res.status(400).json({ erro: e.message });
      }
      if (!pv) continue;
      const v = pv.valor;
      const vtpa = parseFloat(raw.valor_tpa);
      if (Number.isNaN(vtpa) || vtpa < 0) {
        return res.status(400).json({ erro: 'Indica o valor registado no TPA (≥ 0) em cada turno com depósito.' });
      }
      await assertTurnoFechado(tid);
      valid.push({
        turno_id: tid,
        data_deposito: (raw.data_deposito || new Date().toISOString().split('T')[0]).trim(),
        valor: v,
        valor_saidas: 0,
        saidas_destino: '',
        valor_tpa: vtpa,
        referencia: String(raw.referencia || '').trim(),
        notas: String(raw.notas || '').trim()
      });
    }
    if (!valid.length) {
      return res.status(400).json({ erro: 'Indica pelo menos um turno fechado com dinheiro depositado (> 0).' });
    }
    const seen = new Set();
    const dedup = valid.filter((row) => {
      if (seen.has(row.turno_id)) return false;
      seen.add(row.turno_id);
      return true;
    });
    const ids = dedup.map((r) => r.turno_id);
    const tr = await query(`SELECT id, nome FROM turnos WHERE id = ANY($1::int[])`, [ids]);
    const nomeById = Object.fromEntries(tr.rows.map((x) => [x.id, x.nome]));
    dedup.sort((a, b) => ordemTurnoNome(nomeById[a.turno_id]) - ordemTurnoNome(nomeById[b.turno_id]));
    const sumBruto = dedup.reduce((s, r) => s + (parseFloat(r.valor) || 0), 0);
    if (saidasTotal > sumBruto) {
      return res.status(400).json({ erro: 'O valor para compras de armazém não pode ser maior que a soma dos valores brutos.' });
    }
    if (sumBruto - saidasTotal <= 0) {
      return res.status(400).json({ erro: 'O líquido depositado (brutos menos compras de armazém) tem de ser positivo.' });
    }
    dedup[0].valor_saidas = saidasTotal;
    dedup[0].saidas_destino = saidasTotal > 0 ? saidasDestino : '';
    let out = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of dedup) {
        const r = await client.query(
          `INSERT INTO depositos_banco (turno_id, data_deposito, valor, valor_tpa, valor_saidas, saidas_destino, referencia, notas, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (turno_id) DO UPDATE SET
             data_deposito = EXCLUDED.data_deposito,
             valor = EXCLUDED.valor,
             valor_tpa = EXCLUDED.valor_tpa,
             valor_saidas = EXCLUDED.valor_saidas,
             saidas_destino = EXCLUDED.saidas_destino,
             referencia = EXCLUDED.referencia,
             notas = EXCLUDED.notas,
             criado_em = NOW()
           RETURNING *`,
          [
            row.turno_id,
            row.data_deposito,
            row.valor,
            row.valor_tpa,
            row.valor_saidas,
            row.saidas_destino || '',
            row.referencia,
            row.notas,
            String(req.user.id || '')
          ]
        );
        out.push(r.rows[0]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await client.release();
    }
    if (bordero_foto_base64 && String(bordero_foto_base64).trim() && out.length) {
      const td = await query('SELECT data::text FROM turnos WHERE id=$1', [dedup[0].turno_id]);
      const calendarDay = (td.rows[0]?.data || dedup[0].data_deposito || '').toString().slice(0, 10);
      await applyBorderoFotoCanonicalDay(calendarDay, out[0].id, bordero_foto_base64);
    }
    res.json({ ok: true, registos: out.length, rows: out });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.post('/api/depositos/bordero-dia', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const dataStr = (req.body?.data || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
      return res.status(400).json({ erro: 'Indica a data (YYYY-MM-DD).' });
    }
    const cid = await getCanonicalDepositIdForDay(dataStr);
    if (!cid) return res.status(404).json({ erro: 'Não há depósitos registados neste dia.' });
    await applyBorderoFotoCanonicalDay(dataStr, cid, req.body?.foto_base64);
    const u = await query('SELECT bordero_foto_url FROM depositos_banco WHERE id=$1', [cid]);
    res.json({ ok: true, bordero_foto_url: u.rows[0]?.bordero_foto_url || '' });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.delete('/api/depositos/bordero-dia', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const dataStr = (req.query.data || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
      return res.status(400).json({ erro: 'Indica ?data=YYYY-MM-DD.' });
    }
    await purgeBorderoUrlsForDayAndStorage(dataStr);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ── HISTÓRICO ─────────────────────────────────────────────────
/** Uma linha por turno: total_vendas (stock×preço), total_gerado e total_final (caixa), como em GET /dia. */
app.get('/api/historico', auth, async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    const d1 = inicio || '2020-01-01';
    const d2 = fim || new Date().toISOString().split('T')[0];
    const r = await query(
      `SELECT
         t.id AS turno_id,
         t.data,
         t.nome,
         t.estado,
         COALESCE(v.total_vendas, 0)::numeric AS total_vendas,
         (COALESCE(tc.tpa,0)+COALESCE(tc.transferencia,0)+COALESCE(tc.dinheiro,0))::numeric AS total_gerado,
         (COALESCE(tc.tpa,0)+COALESCE(tc.transferencia,0)+COALESCE(tc.dinheiro,0)-COALESCE(tc.saida,0))::numeric AS total_final
       FROM turnos t
       LEFT JOIN turno_caixa tc ON tc.turno_id = t.id
       LEFT JOIN (
         SELECT ts.turno_id,
           COALESCE(SUM(${sqlTsValorVendaLinha()}), 0)::numeric AS total_vendas
         FROM turno_stock ts
         INNER JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
         INNER JOIN turnos t ON t.id = ts.turno_id
         GROUP BY ts.turno_id
       ) v ON v.turno_id = t.id
       WHERE t.data BETWEEN $1::date AND $2::date
       ORDER BY t.data DESC,
         CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 9 END`,
      [d1, d2]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── RECEITAS ──────────────────────────────────────────────────
app.get('/api/receitas', auth, async (req, res) => {
  try {
    const r = await query(
      `SELECT r.*, p.nome as componente_nome, p.categoria
       FROM receitas r JOIN produtos p ON r.componente_id=p.id
       ORDER BY r.produto_id, p.categoria, p.nome`
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/receitas/:produto_id', auth, async (req, res) => {
  try {
    const r = await query(
      `SELECT r.*, p.nome as componente_nome, p.categoria
       FROM receitas r JOIN produtos p ON r.componente_id=p.id
       WHERE r.produto_id=$1 ORDER BY p.categoria, p.nome`,
      [req.params.produto_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/receitas', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const { produto_id, componente_id, quantidade } = req.body;
    const r = await query(
      `INSERT INTO receitas (produto_id,componente_id,quantidade) VALUES ($1,$2,$3)
       ON CONFLICT (produto_id,componente_id) DO UPDATE SET quantidade=$3 RETURNING *`,
      [produto_id, componente_id, quantidade||1]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/receitas/:id', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const r = await query('UPDATE receitas SET quantidade=$1 WHERE id=$2 RETURNING *', [req.body.quantidade, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/receitas/:id', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    await query('DELETE FROM receitas WHERE id=$1', [req.params.id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── VENDAS DE MENU ─────────────────────────────────────────────
app.get('/api/turnos/:id/vendas', auth, async (req, res) => {
  try {
    const r = await query(
      `SELECT tv.id, tv.turno_id, tv.produto_id, tv.quantidade,
              tv.preco_unit_snapshot, tv.preco_copos_pacote_snapshot, tv.qtd_copos_pacote_snapshot,
              p.nome AS produto_nome,
              ${sqlVendaListaPrecoUnit()} AS preco,
              p.venda_por_copo, p.kg_por_copo,
              ${sqlVendaListaPrecoCopoPacote()} AS preco_copos_pacote,
              ${sqlVendaListaQtdCoposPacote()} AS qtd_copos_pacote
       FROM turno_vendas tv
       JOIN produtos p ON tv.produto_id=p.id
       JOIN turnos tu ON tu.id = tv.turno_id
       WHERE tv.turno_id=$1 ORDER BY p.nome`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

async function produtoPermitePedidoVenda(client, produto_id) {
  const r = await client.query(
    `SELECT categoria, venda_avulso, venda_por_copo, kg_por_copo, nome FROM produtos WHERE id=$1`,
    [produto_id]
  );
  if (!r.rows.length) return { ok: false, msg: 'Produto inválido' };
  const p = r.rows[0];
  const nome = String(p.nome || '')
    .trim()
    .toLowerCase();
  if (nome === 'fino barril') return { ok: false, msg: 'Produto não disponível em pedidos' };
  if (p.categoria === 'menu') return { ok: true };
  if (p.categoria === 'bebida') {
    if (p.venda_por_copo === true && parseFloat(p.kg_por_copo) > 0) return { ok: true };
    return { ok: false, msg: 'Bebidas por unidade: use o registo de stock, não pedidos ao balcão' };
  }
  if (p.venda_avulso === true && p.categoria !== 'menu' && p.categoria !== 'bebida') return { ok: true };
  return { ok: false, msg: 'Este produto não pode ser vendido em pedido ao balcão' };
}

const TIPOS_PAGAMENTO_PEDIDO = ['dinheiro', 'tpa', 'transferencia', 'mbway', 'outro'];

app.get('/api/turnos/:id/pedidos', auth, async (req, res) => {
  try {
    await ensureTurnoPedidos();
    const turnoId = req.params.id;
    const r = await query(
      `SELECT tp.id, tp.turno_id, tp.cliente_nome, tp.tipo_pagamento, tp.criado_em,
              tpl.id AS linha_id, tpl.produto_id, tpl.quantidade,
              p.nome AS produto_nome, p.preco, p.venda_por_copo, p.kg_por_copo,
              p.preco_copos_pacote, p.qtd_copos_pacote
       FROM turno_pedidos tp
       LEFT JOIN turno_pedido_linhas tpl ON tpl.pedido_id = tp.id
       LEFT JOIN produtos p ON p.id = tpl.produto_id
       WHERE tp.turno_id = $1
       ORDER BY tp.criado_em DESC, tpl.id ASC`,
      [turnoId]
    );
    const map = new Map();
    for (const row of r.rows) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          turno_id: row.turno_id,
          cliente_nome: row.cliente_nome,
          tipo_pagamento: row.tipo_pagamento || 'dinheiro',
          criado_em: row.criado_em,
          linhas: []
        });
      }
      if (row.linha_id != null && row.produto_id != null) {
        map.get(row.id).linhas.push({
          produto_id: row.produto_id,
          quantidade: parseFloat(row.quantidade),
          produto_nome: row.produto_nome,
          preco: parseFloat(row.preco) || 0,
          venda_por_copo: row.venda_por_copo,
          kg_por_copo: parseFloat(row.kg_por_copo) || 0,
          preco_copos_pacote: parseFloat(row.preco_copos_pacote) || 0,
          qtd_copos_pacote: parseInt(row.qtd_copos_pacote, 10) || 0
        });
      }
    }
    const list = [...map.values()];
    for (const ped of list) {
      let total = 0;
      for (const ln of ped.linhas) {
        const copo = ln.venda_por_copo === true && ln.kg_por_copo > 0;
        if (copo) {
          const c = Math.floor(parseFloat(ln.quantidade));
          const u = ln.preco;
          const n = ln.qtd_copos_pacote;
          const p = ln.preco_copos_pacote;
          total += n >= 2 && p > 0 ? Math.floor(c / n) * p + (c % n) * u : c * u;
        } else {
          total += parseFloat(ln.quantidade) * ln.preco;
        }
      }
      ped.total_kz = total;
    }
    res.json(list);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/turnos/:id/pedidos', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTurnoPedidos();
    await client.query('BEGIN');
    const turnoId = parseInt(req.params.id, 10);
    const { cliente_nome, linhas, tipo_pagamento } = req.body;
    const tCheck = await client.query(`SELECT id, estado FROM turnos WHERE id=$1`, [turnoId]);
    if (!tCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Turno não encontrado' });
    }
    if (tCheck.rows[0].estado !== 'aberto') {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Só é possível registar pedidos com o turno aberto.' });
    }
    if (!Array.isArray(linhas) || linhas.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Adicione pelo menos uma linha ao pedido.' });
    }
    const normalized = [];
    for (const raw of linhas) {
      const pid = raw.produto_id;
      let q = parseFloat(raw.quantidade);
      if (!Number.isFinite(q) || q <= 0) continue;
      const check = await produtoPermitePedidoVenda(client, pid);
      if (!check.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: check.msg || 'Produto inválido' });
      }
      const pinf = await client.query(
        `SELECT venda_por_copo, kg_por_copo FROM produtos WHERE id=$1`,
        [pid]
      );
      const isCopo = pinf.rows[0].venda_por_copo === true && parseFloat(pinf.rows[0].kg_por_copo) > 0;
      if (isCopo) q = Math.floor(q);
      normalized.push({ produto_id: pid, quantidade: q });
    }
    if (normalized.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Nenhuma linha válida (quantidade > 0).' });
    }
    let tpag = String(tipo_pagamento || 'dinheiro')
      .trim()
      .toLowerCase()
      .slice(0, 24);
    if (!TIPOS_PAGAMENTO_PEDIDO.includes(tpag)) tpag = 'dinheiro';
    const pedidoIns = await client.query(
      `INSERT INTO turno_pedidos (turno_id, cliente_nome, tipo_pagamento) VALUES ($1, $2, $3) RETURNING id, criado_em`,
      [turnoId, String(cliente_nome || '').trim().slice(0, 200), tpag]
    );
    const pedidoId = pedidoIns.rows[0].id;
    for (const line of normalized) {
      await client.query(
        `INSERT INTO turno_pedido_linhas (pedido_id, produto_id, quantidade) VALUES ($1,$2,$3)`,
        [pedidoId, line.produto_id, line.quantidade]
      );
      const oldRow = await client.query(
        `SELECT quantidade FROM turno_vendas WHERE turno_id=$1 AND produto_id=$2`,
        [turnoId, line.produto_id]
      );
      const oldQ = oldRow.rows.length ? parseFloat(oldRow.rows[0].quantidade) : 0;
      await applyTurnoVendaQuantity(client, turnoId, line.produto_id, oldQ + line.quantidade);
    }
    await client.query('COMMIT');
    res.json({ id: pedidoId, sucesso: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/turnos/:id/vendas', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const turnoId = req.params.id;
    const { produto_id, quantidade } = req.body;

    const prodInfo = await client.query(
      'SELECT venda_por_copo, kg_por_copo FROM produtos WHERE id=$1',
      [produto_id]
    );
    const prow = prodInfo.rows[0];
    const isCopo =
      prow && prow.venda_por_copo === true && parseFloat(prow.kg_por_copo) > 0;

    let newQty = parseFloat(quantidade);
    if (isCopo) newQty = Math.max(0, Math.floor(newQty));

    await applyTurnoVendaQuantity(client, turnoId, produto_id, newQty);

    await client.query('COMMIT');
    res.json({ sucesso: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: e.message });
  } finally { client.release(); }
});

// ── UTILIZADORES ──────────────────────────────────────────────
app.get('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureUsernameColumn();
    const r = await query('SELECT id,email,nome,username,role,ativo FROM utilizadores ORDER BY nome');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureUsernameColumn();
    const { email, nome, role, username } = req.body;
    const un = normalizeUsername(username);
    if (!email || !String(email).trim()) return res.status(400).json({ erro: 'Email é obrigatório' });
    if (!isValidUsername(un)) {
      return res.status(400).json({ erro: 'Nome de utilizador: 3 a 50 caracteres (letras minúsculas, números, . _ -)' });
    }
    const dup = await query(
      'SELECT id FROM utilizadores WHERE LOWER(username)=LOWER($1)',
      [un]
    );
    if (dup.rows.length) return res.status(400).json({ erro: 'Nome de utilizador já em uso' });
    const r = await query(
      'INSERT INTO utilizadores (email,nome,username,role,senha_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,nome,username,role',
      [String(email).trim(), nome, un, role || 'operador', hashPassword('StockOS2025!')]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/utilizadores/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureUsernameColumn();
    const { nome, role, ativo, password, username } = req.body;
    const un = normalizeUsername(username);
    if (un && !isValidUsername(un)) {
      return res.status(400).json({ erro: 'Nome de utilizador: 3 a 50 caracteres (letras minúsculas, números, . _ -)' });
    }
    if (un) {
      const dup = await query(
        'SELECT id FROM utilizadores WHERE LOWER(username)=LOWER($1) AND id <> $2',
        [un, req.params.id]
      );
      if (dup.rows.length) return res.status(400).json({ erro: 'Nome de utilizador já em uso' });
    }
    if (password) {
      await query('UPDATE utilizadores SET senha_hash=$1 WHERE id=$2', [hashPassword(password), req.params.id]);
    }
    const r = un
      ? await query(
          'UPDATE utilizadores SET nome=$1,role=$2,ativo=$3,username=$4 WHERE id=$5 RETURNING id,email,nome,username,role,ativo',
          [nome, role, ativo, un, req.params.id]
        )
      : await query(
          'UPDATE utilizadores SET nome=$1,role=$2,ativo=$3 WHERE id=$4 RETURNING id,email,nome,username,role,ativo',
          [nome, role, ativo, req.params.id]
        );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ESCALA ────────────────────────────────────────────────────
async function ensureEscala() {
  await query(`CREATE TABLE IF NOT EXISTS escala (
    id SERIAL PRIMARY KEY,
    data DATE NOT NULL,
    turno VARCHAR(10) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
    utilizador_id TEXT,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(data, turno, utilizador_id)
  )`);
  await query(`ALTER TABLE escala ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`).catch(()=>{});
  await query(`ALTER TABLE escala DROP CONSTRAINT IF EXISTS escala_data_turno_key`).catch(()=>{});
  await query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='escala_data_turno_utilizador_key') THEN ALTER TABLE escala ADD CONSTRAINT escala_data_turno_utilizador_key UNIQUE (data, turno, utilizador_id); END IF; END $$`).catch(()=>{});
  await query(`ALTER TABLE escala ADD COLUMN IF NOT EXISTS area_trabalho SMALLINT`).catch(()=>{});
}

/** Uma ida HTTP: escala da semana + template (página Dia). */
app.get('/api/escala/semana', auth, async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    if (!data_inicio || !data_fim) return res.status(400).json({ erro: 'data_inicio e data_fim são obrigatórios' });
    const cacheKey = `${data_inicio}\t${data_fim}`;
    const now = Date.now();
    const hit = _escalaSemanaCache.get(cacheKey);
    if (hit && now - hit.at < ESCALA_SEMANA_CACHE_MS) {
      return res.json(hit.body);
    }
    const [sem, tpl] = await Promise.all([
      query(
        `SELECT e.id, e.data, e.turno, e.notas, e.utilizador_id, e.area_trabalho,
                u.nome as utilizador_nome, u.role as utilizador_role
         FROM escala e
         LEFT JOIN utilizadores u ON e.utilizador_id::text = u.id::text
         WHERE e.data >= $1 AND e.data <= $2
         ORDER BY e.data, CASE e.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`,
        [data_inicio, data_fim]
      ),
      query(`
        SELECT et.id, et.dia_semana, et.turno, et.utilizador_id, et.notas, et.area_trabalho, u.nome as utilizador_nome
        FROM escala_template et
        LEFT JOIN utilizadores u ON et.utilizador_id::text = u.id::text
        ORDER BY et.dia_semana, CASE et.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END, u.nome
      `)
    ]);
    const body = { semana: sem.rows, template: tpl.rows };
    _escalaSemanaCache.set(cacheKey, { at: now, body });
    if (_escalaSemanaCache.size > 120) {
      const cutoff = now - ESCALA_SEMANA_CACHE_MS;
      for (const [k, v] of _escalaSemanaCache) {
        if (!v || v.at < cutoff) _escalaSemanaCache.delete(k);
      }
    }
    res.json(body);
  } catch (e) {
    if (String(e.message || '').includes('does not exist')) {
      try {
        await ensureEscala();
        await ensureEscalaTemplate();
        res.json({ semana: [], template: [] });
      } catch (e2) {
        res.status(500).json({ erro: e2.message });
      }
    } else {
      res.status(500).json({ erro: e.message });
    }
  }
});

app.get('/api/escala', auth, async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    if (!data_inicio || !data_fim) return res.status(400).json({ erro: 'data_inicio e data_fim são obrigatórios' });
    const r = await query(
      `SELECT e.id, e.data, e.turno, e.notas, e.utilizador_id, e.area_trabalho,
              u.nome as utilizador_nome, u.role as utilizador_role
       FROM escala e
       LEFT JOIN utilizadores u ON e.utilizador_id::text = u.id::text
       WHERE e.data >= $1 AND e.data <= $2
       ORDER BY e.data, CASE e.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`,
      [data_inicio, data_fim]
    );
    res.json(r.rows);
  } catch(e) {
    if (e.message.includes('does not exist')) {
      try { await ensureEscala(); res.json([]); } catch(e2) { res.status(500).json({ erro: e2.message }); }
    } else { res.status(500).json({ erro: e.message }); }
  }
});

function parseAreaTrabalhoBody(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 3) return false;
  return n;
}

app.put('/api/escala', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const { data, turno, utilizador_id, notas, area_trabalho } = req.body;
    if (!data || !turno) return res.status(400).json({ erro: 'Data e turno obrigatórios' });
    const area = parseAreaTrabalhoBody(area_trabalho);
    if (area === false) return res.status(400).json({ erro: 'area_trabalho deve ser 1, 2 ou 3' });
    if (utilizador_id) {
      const r = await query(
        `INSERT INTO escala (data, turno, utilizador_id, notas, area_trabalho)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (data, turno, utilizador_id) DO UPDATE SET notas = EXCLUDED.notas, area_trabalho = EXCLUDED.area_trabalho
         RETURNING *`,
        [data, turno, utilizador_id, notas || '', area]
      );
      clearEscalaSemanaCache();
      res.json(r.rows[0]);
    } else {
      await query(`DELETE FROM escala WHERE data=$1 AND turno=$2`, [data, turno]);
      clearEscalaSemanaCache();
      res.json({ sucesso: true });
    }
  } catch(e) {
    if (e.message.includes('does not exist')) {
      try { await ensureEscala(); res.status(400).json({ erro: 'Tabela criada, tenta novamente' }); } catch(e2) { res.status(500).json({ erro: e2.message }); }
    } else { res.status(500).json({ erro: e.message }); }
  }
});

// ── ESCALA TEMPLATE ───────────────────────────────────────────
async function ensureEscalaTemplate() {
  await query(`CREATE TABLE IF NOT EXISTS escala_template (
    id SERIAL PRIMARY KEY,
    dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
    turno VARCHAR(10) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
    utilizador_id TEXT,
    notas TEXT NOT NULL DEFAULT '',
    UNIQUE(dia_semana, turno, utilizador_id)
  )`);
  await query(`ALTER TABLE escala_template ALTER COLUMN utilizador_id DROP NOT NULL`).catch(()=>{});
  await query(`ALTER TABLE escala_template ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text`).catch(()=>{});
  await query(`ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`).catch(()=>{});
  await query(`ALTER TABLE escala_template DROP CONSTRAINT IF EXISTS escala_template_dia_semana_turno_key`).catch(()=>{});
  await query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='escala_template_dia_turno_utilizador_key') THEN ALTER TABLE escala_template ADD CONSTRAINT escala_template_dia_turno_utilizador_key UNIQUE (dia_semana, turno, utilizador_id); END IF; END $$`).catch(()=>{});
  await query(`ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS area_trabalho SMALLINT`).catch(()=>{});
}

app.get('/api/escala/template', auth, async (req, res) => {
  try {
    const r = await query(`
      SELECT et.id, et.dia_semana, et.turno, et.utilizador_id, et.notas, et.area_trabalho, u.nome as utilizador_nome
      FROM escala_template et
      LEFT JOIN utilizadores u ON et.utilizador_id::text = u.id::text
      ORDER BY et.dia_semana, CASE et.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END, u.nome
    `);
    res.json(r.rows);
  } catch(e) {
    if (e.message.includes('does not exist')) {
      try { await ensureEscalaTemplate(); res.json([]); } catch(e2) { res.status(500).json({ erro: e2.message }); }
    } else { res.status(500).json({ erro: e.message }); }
  }
});

app.post('/api/escala/template', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const { dia_semana, turno, utilizador_id, notas, area_trabalho } = req.body;
    if (dia_semana === undefined || !turno) return res.status(400).json({ erro: 'dia_semana e turno são obrigatórios' });
    const u = utilizador_id || null;
    if (!u) return res.status(400).json({ erro: 'Seleciona um funcionário' });
    const n = notas || '';
    const area = parseAreaTrabalhoBody(area_trabalho);
    if (area === false) return res.status(400).json({ erro: 'area_trabalho deve ser 1, 2 ou 3' });
    const ins = await query(
      `INSERT INTO escala_template (dia_semana, turno, utilizador_id, notas, area_trabalho)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dia_semana, turno, utilizador_id) DO UPDATE SET notas=EXCLUDED.notas, area_trabalho=EXCLUDED.area_trabalho
       RETURNING *`,
      [dia_semana, turno, u, n, area]
    );
    clearEscalaSemanaCache();
    res.json(ins.rows[0] || { sucesso: true });
  } catch(e) {
    if (e.message.includes('does not exist')) {
      try { await ensureEscalaTemplate(); res.status(400).json({ erro: 'Tabela criada, tenta novamente' }); } catch(e2) { res.status(500).json({ erro: e2.message }); }
    } else { res.status(500).json({ erro: e.message }); }
  }
});

app.delete('/api/escala/template/:id', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    await query(`DELETE FROM escala_template WHERE id=$1`, [req.params.id]);
    clearEscalaSemanaCache();
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/escala/template/:id', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const { area_trabalho } = req.body;
    const area = parseAreaTrabalhoBody(area_trabalho);
    if (area === false) return res.status(400).json({ erro: 'area_trabalho deve ser 1, 2 ou 3' });
    const r = await query(`UPDATE escala_template SET area_trabalho=$1 WHERE id=$2 RETURNING *`, [area, req.params.id]);
    clearEscalaSemanaCache();
    if (!r.rows.length) return res.status(404).json({ erro: 'Registo não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/equipa/pessoas', auth, async (req, res) => {
  try {
    const r = await query('SELECT id,nome,role,ativo FROM utilizadores WHERE ativo=true ORDER BY nome');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/turnos/:id/equipa-real', auth, async (req, res) => {
  try {
    const r = await query(
      `SELECT er.*,
              u.nome AS utilizador_nome, u.role AS utilizador_role,
              uc.nome AS cobrindo_utilizador_nome
       FROM turno_equipa_real er
       LEFT JOIN utilizadores u ON er.utilizador_id::text = u.id::text
       LEFT JOIN utilizadores uc ON er.cobrindo_utilizador_id::text = uc.id::text
       WHERE er.turno_id=$1
       ORDER BY er.criado_em ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) {
      try {
        await query(`CREATE TABLE IF NOT EXISTS turno_equipa_real (
          id SERIAL PRIMARY KEY,
          turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
          utilizador_id TEXT NOT NULL,
          cobrindo_utilizador_id TEXT,
          hora_extra BOOLEAN NOT NULL DEFAULT FALSE,
          motivo_falta TEXT NOT NULL DEFAULT '',
          notas TEXT NOT NULL DEFAULT '',
          criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(turno_id, utilizador_id)
        )`);
        await query(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS cobrindo_utilizador_id TEXT`).catch(()=>{});
        await query(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS hora_extra BOOLEAN NOT NULL DEFAULT FALSE`).catch(()=>{});
        await query(`ALTER TABLE turno_equipa_real ADD COLUMN IF NOT EXISTS motivo_falta TEXT NOT NULL DEFAULT ''`).catch(()=>{});
        const r2 = await query(
          `SELECT er.*,
                  u.nome AS utilizador_nome, u.role AS utilizador_role,
                  uc.nome AS cobrindo_utilizador_nome
           FROM turno_equipa_real er
           LEFT JOIN utilizadores u ON er.utilizador_id::text = u.id::text
           LEFT JOIN utilizadores uc ON er.cobrindo_utilizador_id::text = uc.id::text
           WHERE er.turno_id=$1
           ORDER BY er.criado_em ASC`,
          [req.params.id]
        );
        return res.json(r2.rows);
      } catch (e2) { return res.status(500).json({ erro: e2.message }); }
    }
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/turnos/:id/equipa-real', auth, async (req, res) => {
  try {
    const { utilizador_id, cobrindo_utilizador_id, hora_extra, motivo_falta, notas } = req.body || {};
    if (!utilizador_id) return res.status(400).json({ erro: 'utilizador_id é obrigatório' });
    const cobre = cobrindo_utilizador_id ? String(cobrindo_utilizador_id) : null;
    const he = !!hora_extra;
    const motivo = (motivo_falta || '').trim();
    if (cobre && !motivo) return res.status(400).json({ erro: 'motivo_falta é obrigatório quando há cobertura' });
    const r = await query(
      `INSERT INTO turno_equipa_real (turno_id, utilizador_id, cobrindo_utilizador_id, hora_extra, motivo_falta, notas)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (turno_id, utilizador_id) DO UPDATE
       SET cobrindo_utilizador_id=EXCLUDED.cobrindo_utilizador_id,
           hora_extra=EXCLUDED.hora_extra,
           motivo_falta=EXCLUDED.motivo_falta,
           notas=EXCLUDED.notas
       RETURNING *`,
      [req.params.id, String(utilizador_id), cobre, he, motivo, (notas || '').trim()]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/turnos/:id/equipa-real/:utilizador_id', auth, async (req, res) => {
  try {
    await query('DELETE FROM turno_equipa_real WHERE turno_id=$1 AND utilizador_id=$2', [req.params.id, req.params.utilizador_id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/turnos/:id/faltas', auth, async (req, res) => {
  try {
    const r = await query(
      `SELECT f.*, u.nome AS utilizador_nome, u.role AS utilizador_role
       FROM turno_faltas f
       LEFT JOIN utilizadores u ON f.utilizador_id::text = u.id::text
       WHERE f.turno_id=$1
       ORDER BY f.criado_em ASC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) {
      try {
        await query(`CREATE TABLE IF NOT EXISTS turno_faltas (
          id SERIAL PRIMARY KEY,
          turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
          utilizador_id TEXT NOT NULL,
          motivo_falta TEXT NOT NULL DEFAULT '',
          criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(turno_id, utilizador_id)
        )`);
        const r2 = await query(
          `SELECT f.*, u.nome AS utilizador_nome, u.role AS utilizador_role
           FROM turno_faltas f
           LEFT JOIN utilizadores u ON f.utilizador_id::text = u.id::text
           WHERE f.turno_id=$1
           ORDER BY f.criado_em ASC`,
          [req.params.id]
        );
        return res.json(r2.rows);
      } catch (e2) { return res.status(500).json({ erro: e2.message }); }
    }
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/turnos/:id/faltas', auth, async (req, res) => {
  try {
    const { utilizador_id, motivo_falta } = req.body || {};
    if (!utilizador_id) return res.status(400).json({ erro: 'utilizador_id é obrigatório' });
    const motivo = (motivo_falta || '').trim();
    if (!motivo) return res.status(400).json({ erro: 'motivo_falta é obrigatório' });
    const r = await query(
      `INSERT INTO turno_faltas (turno_id, utilizador_id, motivo_falta)
       VALUES ($1,$2,$3)
       ON CONFLICT (turno_id, utilizador_id) DO UPDATE SET motivo_falta=EXCLUDED.motivo_falta
       RETURNING *`,
      [req.params.id, String(utilizador_id), motivo]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/turnos/:id/faltas/:utilizador_id', auth, async (req, res) => {
  try {
    await query('DELETE FROM turno_faltas WHERE turno_id=$1 AND utilizador_id=$2', [req.params.id, req.params.utilizador_id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => console.log(`StockOS v3 na porta ${PORT}`));
module.exports = app;
