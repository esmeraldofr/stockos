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

const SQL_STOCK_CATEGORIAS = "categoria IN ('menu','ingredientes','bebida')";
const SQL_P_STOCK_CATEGORIAS = "p.categoria IN ('menu','ingredientes','bebida')";
const SQL_ORD_H = `(CASE h.valid_from_turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 0 END)`;
let _sqlUsePrecoHistorico = true;

function sqlWhereHistLteTurno(turnAlias) {
  const ordT = `(CASE ${turnAlias}.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 0 END)`;
  return `(h.valid_from < ${turnAlias}.data OR (h.valid_from = ${turnAlias}.data AND ${SQL_ORD_H} <= ${ordT}))`;
}
function sqlPPrecoNaData() {
  if (!_sqlUsePrecoHistorico) return `p.preco::numeric`;
  return `COALESCE((SELECT h.preco FROM produto_preco_historico h WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('t')} ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1), p.preco)::numeric`;
}
function sqlGteStockVendido() {
  return `GREATEST(0::numeric, COALESCE(ts.encontrado,0)::numeric + COALESCE(ts.entrada,0)::numeric - COALESCE(ts.deixado,0)::numeric)`;
}
function sqlTsValorVendaLinha() {
  if (!_sqlUsePrecoHistorico) {
    return `CASE WHEN ts.valor_vendas_reportado_kz IS NOT NULL THEN ts.valor_vendas_reportado_kz::numeric ELSE GREATEST(0::numeric, COALESCE(ts.encontrado,0)::numeric + COALESCE(ts.entrada,0)::numeric - COALESCE(ts.deixado,0)::numeric) * p.preco::numeric END`;
  }
  return `CASE WHEN ts.valor_vendas_reportado_kz IS NOT NULL THEN ts.valor_vendas_reportado_kz::numeric ELSE GREATEST(0::numeric, COALESCE(ts.encontrado,0)::numeric + COALESCE(ts.entrada,0)::numeric - COALESCE(ts.deixado,0)::numeric) * ${sqlPPrecoNaData()} END`;
}
function sqlBackfillTurnoStockValorKz() {
  const g = sqlGteStockVendido();
  if (!_sqlUsePrecoHistorico) return `${g} * p.preco::numeric`;
  return `${g} * COALESCE((SELECT h.preco FROM produto_preco_historico h WHERE h.produto_id = ts.produto_id AND ${sqlWhereHistLteTurno('t')} ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1), p.preco)::numeric`;
}
function sqlFechoTurnoStockValorKz() {
  const g = sqlGteStockVendido();
  if (!_sqlUsePrecoHistorico) return `${g} * p.preco::numeric`;
  return `${g} * COALESCE((SELECT h.preco FROM produto_preco_historico h WHERE h.produto_id = ts.produto_id AND ${sqlWhereHistLteTurno('tu')} ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1), p.preco)::numeric`;
}
// SET clause para snapshot de preços em turno_vendas — alias 't' (backfill de fechados antigos)
function sqlBackfillTurnoVendasSnapshotsSet() {
  const precoUnit = !_sqlUsePrecoHistorico
    ? `p.preco::numeric`
    : `COALESCE((SELECT h.preco FROM produto_preco_historico h WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('t')} ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1), p.preco)::numeric`;
  return `preco_unit_snapshot = ${precoUnit}, preco_copos_pacote_snapshot = p.preco_copos_pacote, qtd_copos_pacote_snapshot = p.qtd_copos_pacote`;
}
// SET clause para snapshot de preços em turno_vendas — alias 'tu' (fecho em tempo real)
function sqlFechoTurnoVendasSnapshotsSet() {
  const precoUnit = !_sqlUsePrecoHistorico
    ? `p.preco::numeric`
    : `COALESCE((SELECT h.preco FROM produto_preco_historico h WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('tu')} ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1), p.preco)::numeric`;
  return `preco_unit_snapshot = ${precoUnit}, preco_copos_pacote_snapshot = p.preco_copos_pacote, qtd_copos_pacote_snapshot = p.qtd_copos_pacote`;
}

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
  /** Serverless + pooler em modo transacção: poucos slots por instância (limite Supavisor 200 client conns). */
  max: Math.min(10, Math.max(1, parseInt(process.env.PG_POOL_MAX || '2', 10) || 2)),
  /** Liberta ligações ociosas rapidamente para não saturar o pooler (200 conns globais). */
  idle_timeout: 10,
  max_lifetime: 60 * 5,
  /** Era 15s — em cold start várias candidates falham × 15s → curl atinge 60s.
   *  6s é suficiente para handshake SSL ao Supabase quando a rede está ok. */
  connect_timeout: 6
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

function resetPgSingleton() {
  const s = _pgSingleton;
  _pgSingleton = null;
  // fire-and-forget: não aguardar end() para não bloquear o retry durante 5s extra.
  if (s) s.end({ timeout: 3 }).catch(() => {});
}

/** Garante uma ligação persistente; tenta URLs candidatas só até a primeira funcionar. */
async function ensurePgSingleton() {
  if (_pgSingleton) return _pgSingleton;
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const url of getDbCandidates()) {
      let sqlConn = null;
      try {
        sqlConn = postgres(url, {
          ..._sqlOpts,
          /** Pooler do Supabase fecha sockets idle no lado deles; reciclar a singleton
           *  para que o próximo pedido reabra em vez de tentar escrever num socket morto. */
          onclose: () => { if (_pgSingleton === sqlConn) _pgSingleton = null; }
        });
        // Timeout explícito: connect_timeout cobre o handshake TCP/SSL mas não a execução do SELECT.
        // Se o Supavisor aceitar TCP mas não responder à query, pendurava indefinidamente.
        // 4s é suficiente: SELECT 1 numa ligação sã demora < 1s; zombie falha em 4s vs 10s antes.
        await Promise.race([
          sqlConn`SELECT 1`,
          new Promise((_, reject) => setTimeout(() => reject(new Error('SELECT 1 timeout (4s)')), 4000))
        ]);
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sql = await ensurePgSingleton();
      // Timeout de 6s: zombies detectados rapidamente; queries sãs terminam em < 2s.
      // "query timeout" casa com o regex transient → resetPgSingleton() + retry com ligação nova.
      const rows = await Promise.race([
        sql.unsafe(text, params || []),
        new Promise((_, reject) => setTimeout(() => reject(new Error('query timeout (6s)')), 6000))
      ]);
      return { rows: Array.from(rows) };
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const transient =
        attempt < 2 &&
        (/ECONNRESET|ECONNREFUSED|ENETUNREACH|EPIPE|Connection|terminated|closed|destroyed|socket|timeout|53300|57P01|57P02|57P03|MaxClientsInSessionMode|pool_size|EMAXCONN|max client connections/i.test(msg) ||
          e.code === 'ECONNRESET' ||
          e.code === 'ENETUNREACH' ||
          e.code === 'EPIPE');
      if (transient) {
        await resetPgSingleton();
        // backoff curto para EMAXCONN (esperar conexões libertarem no pooler)
        if (/EMAXCONN|max client connections/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 250)));
        }
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
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const sql = await ensurePgSingleton();
      let reserved;
      try {
        reserved = await Promise.race([
          sql.reserve(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Pool connection timeout (10s) — servidor ocupado, tenta de novo')), 10000)
          )
        ]);
        return {
          query: async (text, params) => {
            const rows = await reserved.unsafe(text, params || []);
            return { rows: Array.from(rows) };
          },
          release: async () => {
            await reserved.release().catch(() => {});
          }
        };
      } catch (e) {
        lastErr = e;
        const msg = String(e && e.message ? e.message : e);
        const transient =
          attempt < 2 &&
          /EMAXCONN|max client connections|MaxClientsInSessionMode|pool_size|ECONNRESET|EPIPE|Connection|terminated|closed|destroyed|socket/i.test(msg);
        if (transient) {
          await resetPgSingleton();
          await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 400)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
};

/** Evita correr a migração de depósitos em cada pedido (scan completo à BD). */
let depositosSaidasMigrationDone = false;
let depositosBancoReady = false;
let fornecedoresReady = false;
let armazemTablesReady = false;
let produtoFaltasReady = false;
let turnoEntradasReady = false;
let turnoSaidasReady = false;
let turnoPedidosReady = false;
let turnoPedidosEntregaReady = false;
let presencasReady = false;
let precosVendasSnapshotsReady = false;
let irregularidadeDecisoesReady = false;
let irregularidadeComentariosReady = false;
let presencaJustificacoesReady = false;
/** ALTER/enum de utilizadores só na primeira vez por processo. */
let usernameColumnEnsured = false;

/**
 * Garante que lock e unlock correm na mesma sessão PostgreSQL (pool.connect → conexão dedicada).
 * Com Supavisor em transaction mode, cada query() pode ir a um backend diferente — advisory locks
 * de sessão só funcionam se lock e unlock usam o mesmo cliente reservado.
 * Retorna true se o lock foi adquirido e fn() correu; false se outra instância detinha o lock.
 */
async function withAdvisoryLock(lockId, fn) {
  let client;
  try { client = await pool.connect(); } catch (e) {
    console.warn('[advisory lock] connect:', e.message);
    return false;
  }
  let locked = false;
  try {
    const r = await client.query(`SELECT pg_try_advisory_lock($1)`, [lockId]);
    locked = r.rows[0].pg_try_advisory_lock;
    if (!locked) return false;
    await fn();
    return true;
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]).catch(() => {});
    await client.release().catch(() => {});
  }
}

async function qry(sql, params, label) {
  try { await query(sql, params); }
  catch(e) { console.error(`[initDB:${label}]`, e.message); }
}

/** Índices leves (IF NOT EXISTS) — aceleram /dia, escala. Corre após init. */
async function ensureStockosPerfIndexes() {
  // Fast path: já feito numa cold start anterior — evita 6 CREATE INDEX + advisory lock por arranque.
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='perf_indexes_v1'`);
    if (r.rows.length) return;
  } catch (_) {}
  const stmts = [
    'CREATE INDEX IF NOT EXISTS idx_turnos_data ON turnos (data)',
    'CREATE INDEX IF NOT EXISTS idx_turno_stock_turno_id ON turno_stock (turno_id)',
    'CREATE INDEX IF NOT EXISTS idx_turno_stock_turno_prod ON turno_stock (turno_id, produto_id)',
    'CREATE INDEX IF NOT EXISTS idx_turno_vendas_turno_id ON turno_vendas (turno_id)',
    'CREATE INDEX IF NOT EXISTS idx_turno_caixa_turno_id ON turno_caixa (turno_id)',
    'CREATE INDEX IF NOT EXISTS idx_escala_data ON escala (data)'
  ];
  await withAdvisoryLock(7654321001, async () => {
    // Re-verificar dentro do lock (outra instância pode ter terminado enquanto esperávamos).
    try {
      const r2 = await query(`SELECT v FROM stockos_meta WHERE k='perf_indexes_v1'`);
      if (r2.rows.length) return;
    } catch (_) {}
    for (let i = 0; i < stmts.length; i++) {
      try { await query(stmts[i]); } catch (e) { console.warn('[idx]', i, (e && e.message) || e); }
    }
    await query(`INSERT INTO stockos_meta (k,v) VALUES ('perf_indexes_v1','done') ON CONFLICT (k) DO NOTHING`);
  }).catch(e => console.warn('[idx setup]', e && e.message));
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
const STOCKOS_BOOTSTRAP_VERSION = '2026-07-07-registo-deixados';

/** Versão das migrações realmente aplicada na BD (lida de stockos_meta.bootstrap).
 *  Cacheada para que /api/health não bata na BD a cada pedido. */
let STOCKOS_DB_APPLIED = null;

async function initDB() {
  await qry(`CREATE TABLE IF NOT EXISTS stockos_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`, [], 'stockos_meta');
  try {
    const chk = await query(`SELECT v FROM stockos_meta WHERE k = $1`, ['bootstrap']);
    if (chk.rows.length) STOCKOS_DB_APPLIED = chk.rows[0].v;
    if (chk.rows.length && chk.rows[0].v === STOCKOS_BOOTSTRAP_VERSION) {
      /** Fast-path bootstrap-skip: o esquema já está aplicado. Marca login E db como prontos
       *  IMEDIATAMENTE e move TODAS as verificações idempotentes para background.
       *  Endpoints (/dia, /produtos, …) deixam de esperar 30-60s no primeiro pedido após cold start. */
      markLoginReady();
      markDbReady();
      console.log('DB ready (bootstrap skip — optimized fast-path without background DDLs)');
      return;
    }
  } catch (e) {
    console.warn('[initDB] bootstrap check:', e && e.message);
    // Erro de ligação → não correr 70+ DDL queries com uma BD inacessível.
    const msg = (e && e.message) || '';
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|timeout|EMAXCONN|pool|connect/i.test(msg)) throw e;
  }

  await qry(`CREATE TABLE IF NOT EXISTS utilizadores (
    id SERIAL PRIMARY KEY, nome VARCHAR(150) NOT NULL, email VARCHAR(200) NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL DEFAULT '', role VARCHAR(20) NOT NULL DEFAULT 'operador',
    ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'utilizadores');
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
  await qry(`ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS encontrado_caixa NUMERIC(10,3)`, [], 'turno_stock-encontrado-caixa');
  await qry(`ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS deixado_caixa NUMERIC(10,3)`, [], 'turno_stock-deixado-caixa');
  await qry(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS encontrados_fechados_em TIMESTAMPTZ`, [], 'turnos-encontrados-fechados-em');
  await qry(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS deixados_fechados_em TIMESTAMPTZ`, [], 'turnos-deixados-fechados-em');
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
    'produtos-venda-por-copo'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS kg_por_copo NUMERIC(10,4) NOT NULL DEFAULT 0`,
    [],
    'produtos-kg-por-copo'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_copos_pacote NUMERIC(15,2) NOT NULL DEFAULT 0`,
    [],
    'produtos-preco-copos-pacote'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS qtd_copos_pacote SMALLINT NOT NULL DEFAULT 0`,
    [],
    'produtos-qtd-copos-pacote'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS forca_pacote BOOLEAN`,
    [],
    'produtos-forca-pacote'
  );
  await qry(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS imagem TEXT`,
    [],
    'produtos-imagem'
  );
  await qry(
    `UPDATE produtos SET venda_por_copo = true, kg_por_copo = 0.27, preco = 400, preco_copos_pacote = 1000, qtd_copos_pacote = 3, tipo_medicao = 'peso'
     WHERE lower(trim(nome)) = 'fino' AND categoria = 'bebida' AND COALESCE(kg_por_copo, 0) = 0`,
    [],
    'produtos-fino-copo-default'
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
  await ensurePresencas();
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
  STOCKOS_DB_APPLIED = STOCKOS_BOOTSTRAP_VERSION;
  console.log('DB ready');
}
/** Pré-aquecer o singleton postgres no top-level. Evita que o primeiro pedido após
 *  cold start espere pelo handshake SSL ao Supabase. Não bloqueia initDB nem o app.listen. */
ensurePgSingleton().catch((e) => console.warn('[boot] ensurePgSingleton prewarm:', e && e.message));

/** Optimistic ready: assume que o esquema já está aplicado (caso normal em produção)
 *  e desbloqueia o login + endpoints imediatamente. initDB() corre em background para
 *  validar e aplicar migrações se necessário. Se o esquema realmente faltar, as queries
 *  individuais dão erro com a mensagem específica (melhor do que pendurar 60s+ esperando
 *  pelo handshake do pool em cold start). */
markLoginReady();
markDbReady();

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
const STOCKOS_API_BUILD = '2026-03-31-venda-copo-fino';

/** Build-info gerado em postinstall (scripts/write-build-info.js). Identifica
 *  univocamente cada deploy (sha + commit time + build time). Permite verificar
 *  visualmente qual ambiente está mais actualizado. */
let STOCKOS_BUILD_INFO = null;
try {
  const path = require('path');
  const fs = require('fs');
  const p = path.join(__dirname, '..', 'build-info.json');
  if (fs.existsSync(p)) {
    STOCKOS_BUILD_INFO = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
} catch (e) {
  console.warn('[build-info] não encontrado ou inválido:', (e && e.message) || e);
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
    read_only: isStockosApiReadOnly(),
    git_ref: (STOCKOS_BUILD_INFO && STOCKOS_BUILD_INFO.ref) || process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_GIT_BRANCH || null,
    git_sha: (STOCKOS_BUILD_INFO && STOCKOS_BUILD_INFO.sha) || (process.env.VERCEL_GIT_COMMIT_SHA ? String(process.env.VERCEL_GIT_COMMIT_SHA).slice(0, 7) : null),
    commit_at: (STOCKOS_BUILD_INFO && STOCKOS_BUILD_INFO.commitAt) || null,
    built_at: (STOCKOS_BUILD_INFO && STOCKOS_BUILD_INFO.builtAt) || null,
    commit_msg: (STOCKOS_BUILD_INFO && STOCKOS_BUILD_INFO.msg) || null,
    db_target: STOCKOS_BOOTSTRAP_VERSION,
    db_applied: STOCKOS_DB_APPLIED || null
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
    if (!r.rows.length) {
      auditLoginAttempt(req, res, 401, login, null);
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }
    const user = r.rows[0];
    // Conta registada SEM password (funcionário sem acesso ao sistema):
    // nunca autentica — não existe password padrão.
    if (!user.senha_hash) {
      auditLoginAttempt(req, res, 401, login, user);
      return res.status(401).json({ erro: 'Esta conta não tem password definida — pede ao administrador para definir uma.' });
    }
    if (user.senha_hash !== hashPassword(password)) {
      auditLoginAttempt(req, res, 401, login, user);
      return res.status(401).json({ erro: 'Credenciais inválidas' });
    }
    const empresaId = parseInt(user.empresa_id, 10) || 1;
    const token = createToken({ id: user.id, email: user.email, nome: user.nome, role: user.role, username: user.username, empresa_id: empresaId });
    auditLoginAttempt(req, res, 200, login, user);
    // Lojas da empresa (multi-ponto de venda). Sem tabela ainda → loja 1.
    let lojas = [{ id: 1, nome: 'Loja 1' }];
    try {
      await ensureEmpresasLojas();
      const lr = await query(`SELECT id, nome FROM lojas WHERE empresa_id=$1 AND ativo IS TRUE ORDER BY id`, [empresaId]);
      if (lr.rows.length) lojas = lr.rows;
    } catch (_) {}
    res.json({
      token,
      lojas,
      user: {
        id: user.id, email: user.email, nome: user.nome, role: user.role, username: user.username,
        empresa_id: empresaId,
        loja_id: user.loja_id != null ? (parseInt(user.loja_id, 10) || null) : null,
        has_face: user.face_descriptor != null, face_foto_url: user.face_foto_url || ''
      }
    });
  } catch (e) {
    console.error('[auth/login]', pgErrText(e));
    res.status(500).json({
      erro:
        'Não foi possível autenticar. Verifica o email/username e a password. Se persistir, o user da DATABASE_URL precisa de GRANT SELECT (e UPDATE nas colunas usadas) em public.utilizadores.'
    });
  }
});

/** Regista tentativa de login na auditoria (sem expor a password). */
function auditLoginAttempt(req, res, status, loginInput, user) {
  setImmediate(async () => {
    try {
      await ensureAuditoria();
      const ip =
        (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
        req.ip || '';
      const desc = status === 200 ? 'Sessão iniciada' : 'Falha de login';
      await query(
        `INSERT INTO auditoria (utilizador_id, utilizador_nome, utilizador_role, metodo, caminho, acao, descricao, status, ip, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          user && user.id != null ? String(user.id) : null,
          user ? user.nome : null,
          user ? user.role : null,
          'POST',
          '/api/auth/login',
          desc,
          status === 200 ? '' : `tentativa: ${String(loginInput || '').slice(0, 80)}`,
          status,
          ip || null,
          null
        ]
      );
    } catch (e) {
      console.warn('[auditoria] login:', e && e.message);
    }
  });
}
app.use(express.static('public'));
app.use(async (req, res, next) => { try { await dbReady; next(); } catch(e) { res.status(500).json({ erro: 'DB não disponível' }); } });

// ── AUDITORIA ─────────────────────────────────────────────────
let auditoriaReady = false;
async function ensureAuditoria() {
  if (auditoriaReady) return;
  // Fast path via meta flag — evita CREATE INDEX em auditoria (avg 21s) em cada cold start.
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='auditoria_ddl_v1'`);
    if (r.rows.length) { auditoriaReady = true; return; }
  } catch (_) {}
  try {
    await withAdvisoryLock(7654321002, async () => {
      // Re-verificar dentro do lock.
      try {
        const r2 = await query(`SELECT v FROM stockos_meta WHERE k='auditoria_ddl_v1'`);
        if (r2.rows.length) { auditoriaReady = true; return; }
      } catch (_) {}
      await query(`CREATE TABLE IF NOT EXISTS auditoria (
        id BIGSERIAL PRIMARY KEY,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        utilizador_id TEXT,
        utilizador_nome TEXT,
        utilizador_role TEXT,
        metodo VARCHAR(8) NOT NULL,
        caminho TEXT NOT NULL,
        acao TEXT NOT NULL,
        descricao TEXT NOT NULL DEFAULT '',
        status SMALLINT NOT NULL DEFAULT 0,
        ip TEXT,
        payload JSONB
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_auditoria_criado_em ON auditoria (criado_em DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_auditoria_utilizador ON auditoria (utilizador_id, criado_em DESC)`);
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('auditoria_ddl_v1','done') ON CONFLICT (k) DO NOTHING`);
    });
    // ok=false: outra instância detinha o lock — marcar ready na mesma
    auditoriaReady = true;
  } catch (e) {
    console.warn('[auditoria] ensure:', e && e.message);
  }
}

/** Mapa rota → descrição amigável (para a aba Auditoria). */
const AUDIT_ROUTE_LABELS = [
  // Auth & utilizadores
  { re: /^\/api\/auth\/login$/i, m: 'POST', label: 'Sessão iniciada' },
  { re: /^\/api\/auth\/alterar-password$/i, m: 'POST', label: 'Password do próprio alterada' },
  { re: /^\/api\/utilizadores$/i, m: 'POST', label: 'Utilizador criado' },
  { re: /^\/api\/utilizadores\/[^/]+$/i, m: 'PUT', label: 'Utilizador editado' },
  // Produtos / receitas
  { re: /^\/api\/produtos$/i, m: 'POST', label: 'Produto criado' },
  { re: /^\/api\/produtos\/[^/]+$/i, m: 'PUT', label: 'Produto editado' },
  { re: /^\/api\/produtos\/[^/]+$/i, m: 'DELETE', label: 'Produto removido' },
  { re: /^\/api\/receitas$/i, m: 'POST', label: 'Receita guardada' },
  { re: /^\/api\/receitas\/[^/]+$/i, m: 'PUT', label: 'Receita editada' },
  { re: /^\/api\/receitas\/[^/]+$/i, m: 'DELETE', label: 'Receita removida' },
  // Fornecedores / armazém
  { re: /^\/api\/fornecedores$/i, m: 'POST', label: 'Fornecedor guardado' },
  { re: /^\/api\/armazem\/libertacoes$/i, m: 'POST', label: 'Libertação para turno' },
  { re: /^\/api\/armazem\/compras$/i, m: 'POST', label: 'Compra registada' },
  { re: /^\/api\/armazem\/faturas$/i, m: 'POST', label: 'Fatura registada' },
  // Turnos
  { re: /^\/api\/turnos\/abrir$/i, m: 'POST', label: 'Turno aberto' },
  { re: /^\/api\/turnos\/[^/]+\/fechar$/i, m: 'POST', label: 'Turno fechado' },
  { re: /^\/api\/turnos\/[^/]+\/reabrir$/i, m: 'POST', label: 'Turno reaberto' },
  { re: /^\/api\/turnos\/[^/]+\/stock$/i, m: 'PUT', label: 'Stock do turno guardado' },
  { re: /^\/api\/turnos\/[^/]+\/caixa$/i, m: 'PUT', label: 'Caixa do turno guardada' },
  { re: /^\/api\/turnos\/[^/]+\/entradas$/i, m: 'POST', label: 'Entrada de stock' },
  { re: /^\/api\/turnos\/[^/]+\/entradas\/[^/]+$/i, m: 'DELETE', label: 'Entrada removida' },
  { re: /^\/api\/turnos\/[^/]+\/saidas$/i, m: 'POST', label: 'Saída de caixa' },
  { re: /^\/api\/turnos\/[^/]+\/saidas\/[^/]+$/i, m: 'DELETE', label: 'Saída removida' },
  { re: /^\/api\/turnos\/[^/]+\/vendas$/i, m: 'POST', label: 'Venda de menu actualizada' },
  { re: /^\/api\/turnos\/[^/]+\/pedidos$/i, m: 'POST', label: 'Pedido ao balcão registado' },
  { re: /^\/api\/turnos\/[^/]+\/pedidos\/[^/]+$/i, m: 'DELETE', label: 'Pedido ao balcão removido' },
  { re: /^\/api\/turnos\/[^/]+\/equipa-real$/i, m: 'POST', label: 'Presença registada' },
  { re: /^\/api\/turnos\/[^/]+\/equipa-real\/[^/]+$/i, m: 'DELETE', label: 'Presença removida' },
  { re: /^\/api\/turnos\/[^/]+\/faltas$/i, m: 'POST', label: 'Motivo de falta guardado' },
  { re: /^\/api\/turnos\/[^/]+\/faltas\/[^/]+$/i, m: 'DELETE', label: 'Motivo de falta removido' },
  // Depósitos
  { re: /^\/api\/depositos$/i, m: 'POST', label: 'Depósito guardado' },
  { re: /^\/api\/depositos\/lote$/i, m: 'POST', label: 'Depósitos do dia guardados' },
  { re: /^\/api\/depositos\/bordero-dia$/i, m: 'POST', label: 'Borderô do dia carregado' },
  { re: /^\/api\/depositos\/bordero-dia$/i, m: 'DELETE', label: 'Borderô do dia removido' },
  // Escala
  { re: /^\/api\/escala$/i, m: 'POST', label: 'Escala do dia guardada' },
  { re: /^\/api\/escala\/[^/]+$/i, m: 'PUT', label: 'Escala do dia editada' },
  { re: /^\/api\/escala\/[^/]+$/i, m: 'DELETE', label: 'Escala do dia removida' },
  { re: /^\/api\/escala\/template$/i, m: 'POST', label: 'Modelo da escala guardado' },
  { re: /^\/api\/escala\/template\/[^/]+$/i, m: 'PUT', label: 'Modelo da escala editado' },
  { re: /^\/api\/escala\/template\/[^/]+$/i, m: 'DELETE', label: 'Modelo da escala removido' },
  // Manutenção
  { re: /^\/api\/migrate$/i, m: 'POST', label: 'Migração executada' },
  { re: /^\/api\/reseed-produtos$/i, m: 'POST', label: 'Re-seed de produtos' }
];
function auditDescribeAction(method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').split('?')[0];
  for (const entry of AUDIT_ROUTE_LABELS) {
    if (entry.m === m && entry.re.test(p)) return entry.label;
  }
  return `${m} ${p}`;
}

/** Body sanitizado: nunca regista passwords, fotos base64 e tokens. */
function auditSanitizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  const REDACT_KEYS = new Set([
    'password', 'passwordAtual', 'passwordNova', 'senha', 'senha_hash',
    'token', 'authorization', 'foto_base64', 'bordero_foto_base64'
  ]);
  function clean(v) {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        if (REDACT_KEYS.has(k)) { o[k] = '[REDACTED]'; continue; }
        if (typeof val === 'string' && val.length > 4000) { o[k] = val.slice(0, 4000) + '…'; continue; }
        o[k] = clean(val);
      }
      return o;
    }
    return v;
  }
  try {
    const c = clean(body);
    return c && Object.keys(c).length ? c : null;
  } catch (_) { return null; }
}

/** Middleware: regista POST/PUT/DELETE /api/* depois da resposta. Não bloqueia o pedido. */
// ── Limpeza automática da auditoria: retém só os últimos 30 dias ──────
// Corre no máximo 1×/dia (marcador em stockos_meta partilhado entre
// instâncias; trinco em memória evita bater na meta a cada pedido).
let __auditoriaLimpezaTs = 0;
async function limparAuditoriaAntiga() {
  const agora = Date.now();
  if (agora - __auditoriaLimpezaTs < 6 * 3600000) return;
  __auditoriaLimpezaTs = agora;
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const m = await query(`SELECT v FROM stockos_meta WHERE k='auditoria_limpeza'`);
    if (m.rows.length && m.rows[0].v >= hoje) return;
    await query(
      `INSERT INTO stockos_meta (k,v) VALUES ('auditoria_limpeza',$1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [hoje]);
    const r = await query(`DELETE FROM auditoria WHERE criado_em < NOW() - INTERVAL '30 days'`);
    if (r.rowCount) console.log(`[auditoria] limpeza diária: ${r.rowCount} registos com mais de 30 dias removidos`);
    // Idempotência: só é útil durante a janela de re-tentativas da fila
    // offline — 14 dias de retenção chegam e sobram.
    const r2 = await query(`DELETE FROM ops_idempotencia WHERE criado_em < NOW() - INTERVAL '14 days'`).catch(() => ({ rowCount: 0 }));
    if (r2.rowCount) console.log(`[idempotencia] limpeza diária: ${r2.rowCount} registos removidos`);
  } catch (_) { /* melhor esforço — tenta de novo no dia seguinte */ }
}

app.use(function auditMiddleware(req, res, next) {
  const m = String(req.method || '').toUpperCase();
  if (m !== 'POST' && m !== 'PUT' && m !== 'DELETE') return next();
  const p = (req.path || req.url || '').split('?')[0];
  if (!p.startsWith('/api/')) return next();
  if (p === '/api/auditoria') return next(); // não regista as próprias leituras
  // RUÍDO de alta frequência fora da auditoria (98% do tamanho da tabela):
  // auto-guardar da folha de stock (um PUT por célula tocada), sonda de
  // internet (10 s) e heartbeat do monitoramento (60 s).
  if (p === '/api/ping' || p === '/api/monitor/heartbeat') return next();
  if (m === 'PUT' && /^\/api\/turnos\/[^/]+\/stock$/.test(p)) return next();
  res.on('finish', () => {
    /** await assíncrono — não bloqueamos a resposta. */
    (async () => {
      try {
        await ensureAuditoria();
        const u = req.user || {};
        const payload = auditSanitizeBody(req.body);
        const ip =
          (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
          req.ip || '';
        await query(
          `INSERT INTO auditoria (utilizador_id, utilizador_nome, utilizador_role, metodo, caminho, acao, descricao, status, ip, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            u.id != null ? String(u.id) : null,
            u.nome || null,
            u.role || null,
            m,
            p,
            auditDescribeAction(m, p),
            '',
            res.statusCode || 0,
            ip || null,
            payload ? JSON.stringify(payload) : null
          ]
        );
      } catch (e) {
        console.warn('[auditoria] insert:', e && e.message);
      }
      limparAuditoriaAntiga().catch(() => {});
    })();
  });
  next();
});

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

// ── IDEMPOTÊNCIA DAS ESCRITAS OFFLINE ─────────────────────────
// A fila offline do frontend repete escritas (POST/PUT/DELETE) até obter
// resposta. Com rede fraca, um pedido pode ter chegado sem o cliente saber
// (timeout) — na repetição, o client_ref permite devolver a resposta já
// gravada em vez de duplicar o registo.
let opsIdemReady = false;
async function ensureOpsIdempotencia() {
  if (opsIdemReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='ops_idempotencia_v1'`);
    if (r.rows.length) { opsIdemReady = true; return; }
  } catch (_) {}
  await qry(
    `CREATE TABLE IF NOT EXISTS ops_idempotencia (
      client_ref TEXT PRIMARY KEY,
      metodo TEXT,
      caminho TEXT,
      status INTEGER,
      resposta TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    [],
    'ops-idempotencia'
  );
  try {
    const chk = await query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='ops_idempotencia'`
    );
    if (chk.rows.length) {
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('ops_idempotencia_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
      await query(`DELETE FROM ops_idempotencia WHERE criado_em < NOW() - INTERVAL '60 days'`).catch(() => {});
      opsIdemReady = true;
    }
  } catch (_) {}
}

app.use(function idempotenciaMiddleware(req, res, next) {
  const m = String(req.method || '').toUpperCase();
  if (m !== 'POST' && m !== 'PUT' && m !== 'DELETE' && m !== 'PATCH') return next();
  let p = req.path || '';
  if (!p && req.url) p = String(req.url).split('?')[0] || '';
  if (!p.startsWith('/api/')) return next();
  const clientRef = String((req.body && req.body.client_ref) || '').trim().slice(0, 64);
  if (!clientRef) return next();
  (async () => {
    try { await ensureOpsIdempotencia(); } catch (_) {}
    if (opsIdemReady) {
      try {
        const dup = await query(`SELECT status, resposta FROM ops_idempotencia WHERE client_ref=$1`, [clientRef]);
        if (dup.rows.length) {
          const st = parseInt(dup.rows[0].status, 10) || 200;
          let body = {};
          try { body = JSON.parse(dup.rows[0].resposta || '{}'); } catch (_) {}
          if (body && typeof body === 'object' && !Array.isArray(body)) body.duplicado = true;
          return res.status(st).json(body);
        }
      } catch (_) {}
      const origJson = res.json.bind(res);
      res.json = (body) => {
        try {
          const st = res.statusCode || 200;
          if (st >= 200 && st < 300) {
            query(
              `INSERT INTO ops_idempotencia (client_ref, metodo, caminho, status, resposta)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_ref) DO NOTHING`,
              [clientRef, m, p, st, JSON.stringify(body == null ? {} : body).slice(0, 200000)]
            ).catch(() => {});
          }
        } catch (_) {}
        return origJson(body);
      };
    }
    next();
  })().catch(() => { try { next(); } catch (_) {} });
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
const __authUserCache = new Map();
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ','');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ erro: 'Não autenticado' });
  try {
    // Lê role/empresa/loja da BD com cache curto (15 s) — corta uma ida à
    // BD por pedido (latência) mantendo mudanças de perfil quase imediatas.
    let u = null;
    const hitAuth = __authUserCache.get(String(payload.id));
    if (hitAuth && Date.now() - hitAuth.at < 15000) {
      u = hitAuth.u;
    } else {
      let r;
      try {
        r = await query(`SELECT ativo, role::text AS role, empresa_id, loja_id FROM utilizadores WHERE id=$1`, [payload.id]);
      } catch (_) {
        r = await query(`SELECT ativo FROM utilizadores WHERE id=$1`, [payload.id]);
      }
      u = r.rows.length ? r.rows[0] : null;
      if (__authUserCache.size > 300) __authUserCache.clear();
      __authUserCache.set(String(payload.id), { at: Date.now(), u });
    }
    if (!u || !u.ativo) {
      return res.status(401).json({ erro: 'Conta inactiva' });
    }
    if (u.role) payload.role = u.role;
    if (u.empresa_id != null) payload.empresa_id = parseInt(u.empresa_id, 10) || 1;
    payload.loja_id = u.loja_id != null ? (parseInt(u.loja_id, 10) || null) : null;
  } catch (e) {
    console.warn('[auth] verificação ativo falhou:', e.message);
  }
  req.user = payload;
  await resolverContextoAcesso(req).catch(() => {});
  // Guarda central: qualquer /api/turnos/<id>/… só é acessível se o turno
  // pertencer ao âmbito do utilizador (empresa do gestor; loja fixa do
  // operador; admin passa sempre). Cobre stock, caixa, pedidos, fechos,
  // entradas, saídas, equipa, fotos do TPA, etc. de uma só vez.
  const mTurno = String(req.path || '').match(/^\/api\/turnos\/(\d+)(\/|$)/);
  if (mTurno) {
    const ok = await turnoNoContexto(req, parseInt(mTurno[1], 10)).catch(() => true);
    if (!ok) return res.status(404).json({ erro: 'Turno não encontrado' });
  }
  next();
}

/** O turno pertence ao âmbito do pedido? (admin: sempre; gestor: empresa;
 *  operador/compras: a sua loja fixa). BD antiga sem loja_id → permite. */
const __turnoLojaCache = new Map();
async function turnoLojaId(turnoId) {
  const k = String(turnoId);
  const hit = __turnoLojaCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.loja;
  try {
    const r = await query(`SELECT loja_id FROM turnos WHERE id=$1`, [turnoId]);
    const loja = r.rows.length ? (parseInt(r.rows[0].loja_id, 10) || 1) : null;
    if (__turnoLojaCache.size > 500) __turnoLojaCache.clear();
    __turnoLojaCache.set(k, { loja, at: Date.now() });
    return loja;
  } catch (_) {
    return undefined; // coluna inexistente — sem como validar
  }
}
async function turnoNoContexto(req, turnoId) {
  const role = String((req.user && req.user.role) || '');
  if (role === 'admin') return true;
  const loja = await turnoLojaId(turnoId);
  if (loja === undefined) return true; // BD antiga
  if (loja === null) return false; // turno não existe
  if (role === 'operador' || role === 'compras') {
    const fixa = parseInt(req.user && req.user.loja_id, 10);
    return Number.isFinite(fixa) && fixa > 0 ? loja === fixa : true;
  }
  // gestor: loja do turno tem de ser da sua empresa
  const mapa = await mapaLojaEmpresa();
  if (!mapa || mapa[String(loja)] == null) return true;
  return mapa[String(loja)] === (parseInt(req.user && req.user.empresa_id, 10) || 1);
}

// ── Contexto de acesso por perfil ─────────────────────────────
// admin           → todas as empresas e lojas (migra com ?empresa= / ?loja=)
// gestor          → só a sua empresa; migra entre as lojas dela (?loja=)
// operador/compras→ presos à sua loja fixa (utilizadores.loja_id)
const __lojaEmpresaCache = { at: 0, map: null };
async function mapaLojaEmpresa() {
  if (__lojaEmpresaCache.map && Date.now() - __lojaEmpresaCache.at < 60000) return __lojaEmpresaCache.map;
  try {
    const r = await query(`SELECT id, empresa_id FROM lojas`);
    const m = {};
    r.rows.forEach((x) => { m[String(x.id)] = parseInt(x.empresa_id, 10) || 1; });
    __lojaEmpresaCache.map = m;
    __lojaEmpresaCache.at = Date.now();
    return m;
  } catch (_) { return __lojaEmpresaCache.map || null; }
}

async function resolverContextoAcesso(req) {
  const role = String((req.user && req.user.role) || '');
  const empresaPropria = parseInt(req.user && req.user.empresa_id, 10) || 1;
  // Empresa efectiva: só o admin migra de empresa.
  let empresa = empresaPropria;
  if (role === 'admin') {
    const qE = parseInt(req.query && req.query.empresa, 10);
    if (Number.isFinite(qE) && qE > 0) empresa = qE;
  }
  req.empresaEfetiva = empresa;
  // Loja pedida (query/header).
  const qL = parseInt(req.query && req.query.loja, 10);
  const hL = parseInt(req.headers && req.headers['x-loja'], 10);
  const pedida = Number.isFinite(qL) && qL > 0 ? qL : (Number.isFinite(hL) && hL > 0 ? hL : null);
  // Operador / operador de sistema: loja FIXA — o pedido não manda.
  if (role === 'operador' || role === 'compras') {
    req.lojaEfetiva = (req.user && req.user.loja_id) || pedida || 1;
    return;
  }
  // Admin / gestor: a loja pedida tem de pertencer à empresa efectiva.
  let loja = pedida;
  const mapa = await mapaLojaEmpresa();
  if (mapa && Object.keys(mapa).length) {
    if (loja != null && mapa[String(loja)] != null && mapa[String(loja)] !== empresa) loja = null;
    if (loja == null) {
      const primeira = Object.keys(mapa).map(Number).sort((a, b) => a - b).find((k) => mapa[String(k)] === empresa);
      loja = primeira || 1;
    }
  }
  req.lojaEfetiva = loja || 1;
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ erro: 'Sem permissão' });
    next();
  };
}

// ── MULTI-EMPRESA / MULTI-LOJA (fase 1) ───────────────────────
// O sistema serve várias empresas, cada uma com vários pontos de venda.
// Fase 1: turnos (e tudo o que deles depende), presenças e depósitos são
// POR LOJA; utilizadores/produtos/fornecedores pertencem à empresa. Os
// dados existentes migram automaticamente para empresa 1 / loja 1 (via
// DEFAULT 1). Escala/armazém por loja e isolamento total entre empresas
// entram na fase 2 — NÃO registar uma 2.ª empresa antes disso.
let empresasLojasReady = false;
async function ensureEmpresasLojas() {
  if (empresasLojasReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='empresas_lojas_v6'`);
    if (r.rows.length) { empresasLojasReady = true; return; }
  } catch (_) {}
  await qry(`CREATE TABLE IF NOT EXISTS empresas (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'empresas');
  await qry(`CREATE TABLE IF NOT EXISTS lojas (
    id SERIAL PRIMARY KEY,
    empresa_id INTEGER NOT NULL DEFAULT 1,
    nome TEXT NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'lojas');
  await qry(`INSERT INTO empresas (nome) SELECT 'Empresa 1' WHERE NOT EXISTS (SELECT 1 FROM empresas)`, [], 'seed-empresa');
  // Não existe «loja principal» — todas as lojas são iguais, cada uma com
  // a sua ficha. O seed dá só um nome neutro à primeira (renomeável).
  await qry(`INSERT INTO lojas (empresa_id, nome) SELECT 1, 'Loja 1' WHERE NOT EXISTS (SELECT 1 FROM lojas)`, [], 'seed-loja');
  await qry(`UPDATE lojas SET nome='Loja 1' WHERE id=1 AND nome='Loja principal'`, [], 'loja-sem-principal');
  // Ficha da loja (perfil completo, como fornecedores/funcionários).
  await qry(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS morada TEXT NOT NULL DEFAULT ''`, [], 'lojas-morada');
  await qry(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS telefone TEXT NOT NULL DEFAULT ''`, [], 'lojas-telefone');
  await qry(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`, [], 'lojas-email');
  await qry(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS nif TEXT NOT NULL DEFAULT ''`, [], 'lojas-nif');
  await qry(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS responsavel TEXT NOT NULL DEFAULT ''`, [], 'lojas-responsavel');
  await qry(`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`, [], 'lojas-notas');
  // Isolamento por empresa (fase 2): dados de gestão marcados por empresa.
  await qry(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'faturas-empresa');
  await qry(`ALTER TABLE armazem_libertacoes ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'libertacoes-empresa');
  await qry(`ALTER TABLE armazem_proformas ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'proformas-empresa');
  await qry(`ALTER TABLE escala ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'escala-empresa');
  await qry(`ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'escala-template-empresa');
  await qry(`ALTER TABLE produto_faltas ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'produto-faltas-empresa');
  // Escala e armazém POR LOJA.
  await qry(`ALTER TABLE escala ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'escala-loja');
  await qry(`ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'escala-template-loja');
  await qry(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'faturas-loja');
  await qry(`ALTER TABLE armazem_libertacoes ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'libertacoes-loja');
  await qry(`ALTER TABLE armazem_proformas ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'proformas-loja');
  await qry(`ALTER TABLE armazem_inventario_diario ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'inventario-loja');
  await qry(`ALTER TABLE produto_faltas ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'produto-faltas-loja');
  // Ficha da empresa (perfil completo, como lojas/fornecedores).
  await qry(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS nif TEXT NOT NULL DEFAULT ''`, [], 'empresas-nif');
  await qry(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS morada TEXT NOT NULL DEFAULT ''`, [], 'empresas-morada');
  await qry(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS telefone TEXT NOT NULL DEFAULT ''`, [], 'empresas-telefone');
  await qry(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`, [], 'empresas-email');
  await qry(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS responsavel TEXT NOT NULL DEFAULT ''`, [], 'empresas-responsavel');
  await qry(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`, [], 'empresas-notas');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'utilizadores-empresa');
  // Loja fixa do funcionário (operador / operador de sistema). NULL para
  // admin (todas as empresas) e gestor (todas as lojas da sua empresa).
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS loja_id INTEGER`, [], 'utilizadores-loja');
  await qry(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'turnos-loja');
  await qry(`ALTER TABLE presencas ADD COLUMN IF NOT EXISTS loja_id INTEGER NOT NULL DEFAULT 1`, [], 'presencas-loja');
  await qry(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'produtos-empresa');
  await qry(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 1`, [], 'fornecedores-empresa');
  await qry(`CREATE INDEX IF NOT EXISTS idx_turnos_loja_data ON turnos (loja_id, data)`, [], 'idx-turnos-loja');
  try {
    const chk = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='turnos' AND column_name='loja_id'`
    );
    if (chk.rows.length) {
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('empresas_lojas_v6','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
      empresasLojasReady = true;
    }
  } catch (_) {}
}

/** Loja activa do pedido, já validada por perfil no auth() (loja fixa para
 *  operador/compras; lojas da empresa para gestor; livre para admin). */
function lojaDe(req) {
  if (req.lojaEfetiva) return req.lojaEfetiva;
  const q = parseInt(req.query && req.query.loja, 10);
  if (Number.isFinite(q) && q > 0) return q;
  const h = parseInt(req.headers && req.headers['x-loja'], 10);
  if (Number.isFinite(h) && h > 0) return h;
  return 1;
}
/** Empresa efectiva do pedido (admin pode migrar; restantes ficam na sua). */
function empresaDe(req) {
  if (req.empresaEfetiva) return req.empresaEfetiva;
  return parseInt(req.user && req.user.empresa_id, 10) || 1;
}

/** Isolamento por empresa com fallback: tenta a consulta filtrada; numa BD
 *  ainda sem as colunas empresa_id/loja_id, corre a versão antiga. */
async function queryEmpresa(sqlNovo, paramsNovo, sqlAntigo, paramsAntigo) {
  try {
    return await query(sqlNovo, paramsNovo);
  } catch (e) {
    if (!/empresa_id|loja_id/.test(String(e.message || ''))) throw e;
    return await query(sqlAntigo, paramsAntigo);
  }
}
/** Dentro de transacções não se pode tentar-e-falhar (aborta o BEGIN) —
 *  verifica primeiro se a coluna empresa_id existe (com cache). */
const __colunaCache = {};
async function colunaDisponivel(tabela, coluna) {
  const k = tabela + '.' + coluna;
  if (__colunaCache[k]) return true;
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [tabela, coluna]
    );
    if (r.rows.length) { __colunaCache[k] = true; return true; }
  } catch (_) {}
  return false;
}
function colunaEmpresaDisponivel(tabela) { return colunaDisponivel(tabela, 'empresa_id'); }
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

/** Detecta em runtime o tipo PG de produtos.id (UUID ou INTEGER) e devolve as DDLs adequadas. */
async function pphDdlStatementsForCurrentDb() {
  let pidType = 'INTEGER';
  try {
    const r = await query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='produtos' AND column_name='id'`
    );
    const dt = r.rows[0]?.data_type ? String(r.rows[0].data_type).toLowerCase() : '';
    if (dt === 'uuid') pidType = 'UUID';
    else if (dt === 'text') pidType = 'TEXT';
    else if (dt === 'integer' || dt === 'bigint' || dt === 'smallint') pidType = dt.toUpperCase();
  } catch (e) {
    console.warn('[pphDdlStatementsForCurrentDb] não consegui detectar produtos.id, assumo INTEGER:', e && e.message);
  }
  return [
    `CREATE TABLE IF NOT EXISTS produto_preco_historico (
        id SERIAL PRIMARY KEY,
        produto_id ${pidType} NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
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
}

/** Mantido para compatibilidade — usado em legacy paths que esperam um array fixo. */
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

/**
 * Verifica em runtime se a tabela `produto_preco_historico` existe e atualiza a flag.
 * Se não existir, tenta cria-la (idempotente). Útil em cold-starts no fast-path em que
 * `preco_snap_ddl_v1` está em meta mas a tabela foi entretanto removida ou nunca criada.
 */
async function ensureProdutoPrecoHistoricoLive() {
  let exists = await produtoPrecoHistoricoTableExists();
  if (!exists) {
    console.warn('[ensureProdutoPrecoHistoricoLive] tabela ausente — tentar criar com tipo correcto de produtos.id.');
    const ddls = await pphDdlStatementsForCurrentDb();
    for (const ddl of ddls) {
      try { await query(ddl); }
      catch (e) { console.warn('[ensureProdutoPrecoHistoricoLive] DDL falhou:', e && e.message); }
    }
    exists = await produtoPrecoHistoricoTableExists();
  }
  _sqlUsePrecoHistorico = exists;
  if (!exists) {
    console.warn('[StockOS] produto_preco_historico continua ausente — leituras usam só produtos.preco.');
  }
}

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
  if (precosVendasSnapshotsReady) return;
  // Fast path: meta flag set by a previous successful run — avoids 24+ DDL queries on every cold-start
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='preco_snap_ddl_v1'`);
    if (r.rows.length) { precosVendasSnapshotsReady = true; return; }
  } catch (_) {}
  await withAdvisoryLock(7654321007, async () => {
    // Re-check inside lock (another instance may have set the flag while we waited)
    try {
      const r2 = await query(`SELECT v FROM stockos_meta WHERE k='preco_snap_ddl_v1'`);
      if (r2.rows.length) { precosVendasSnapshotsReady = true; return; }
    } catch (_) {}
    await ensureProdutoPrecoHistorico();
    await ensureTurnoStockEncontradoNullable();
    await ensureTurnoStockDeixadoNullable();
    await ensureTurnoCaixaEntradasNullable();
    await qry(`ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS valor_vendas_reportado_kz NUMERIC(15,2)`, [], 'turno_stock-valor-snap');
    await qry(`ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS preco_unit_snapshot NUMERIC(15,2)`, [], 'turno_vendas-precio-snap');
    await qry(`ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS preco_copos_pacote_snapshot NUMERIC(15,2)`, [], 'turno_vendas-preco-copo-snap');
    await qry(`ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS qtd_copos_pacote_snapshot INTEGER`, [], 'turno_vendas-qtd-copo-snap');
    // Garante o UNIQUE (turno_id, produto_id) — caso a tabela tenha sido criada
    // sem ele (ambientes antigos), o INSERT ... ON CONFLICT (turno_id, produto_id)
    // falhava com "there is no unique or exclusion constraint matching the ON
    // CONFLICT specification" ao registar pedidos.
    try {
      const hasUnique = await query(
        `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='turno_vendas'
           AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%turno_id%' AND indexdef ILIKE '%produto_id%'`
      );
      if (!hasUnique.rows.length) {
        // Remove duplicados (mantém o id mais alto) antes de aplicar o UNIQUE.
        await query(`DELETE FROM turno_vendas a USING turno_vendas b
          WHERE a.turno_id=b.turno_id AND a.produto_id=b.produto_id AND a.id<b.id`).catch(() => {});
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS turno_vendas_turno_id_produto_id_key ON turno_vendas(turno_id, produto_id)`);
      }
    } catch (e) {
      console.warn('[ensureTurnoVendasUnique]', e && e.message);
    }
    await qry(`INSERT INTO stockos_meta(k,v) VALUES('preco_snap_ddl_v1','done') ON CONFLICT(k) DO UPDATE SET v='done'`, [], 'preco-snap-meta');
    precosVendasSnapshotsReady = true;
    // Backfill runs in background — never blocks markDbReady()
    setImmediate(async () => {
      try {
        await query(`UPDATE turno_stock ts SET valor_vendas_reportado_kz = (${sqlBackfillTurnoStockValorKz()}) FROM produtos p, turnos t WHERE ts.produto_id = p.id AND ts.turno_id = t.id AND t.estado = 'fechado' AND ts.valor_vendas_reportado_kz IS NULL`);
      } catch (e) { console.warn('[ensurePrecosVendasSnapshots ts backfill]', e.message); }
      try {
        await query(`UPDATE turno_vendas tv SET ${sqlBackfillTurnoVendasSnapshotsSet()} FROM produtos p, turnos t WHERE tv.produto_id = p.id AND tv.turno_id = t.id AND t.estado = 'fechado' AND tv.preco_unit_snapshot IS NULL`);
      } catch (e) { console.warn('[ensurePrecosVendasSnapshots tv backfill]', e.message); }
    });
  });
  if (!precosVendasSnapshotsReady) {
    try { _sqlUsePrecoHistorico = await produtoPrecoHistoricoTableExists(); } catch (_) {}
  }
}

async function ensureTurnoPedidos() {
  if (turnoPedidosReady) return;
  // Fast path: meta flag set by a previous successful run
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='turno_pedidos_ddl_v1'`);
    if (r.rows.length) { turnoPedidosReady = true; return; }
  } catch (_) {}
  try {
    await withAdvisoryLock(7654321005, async () => {
      // Re-check inside lock
      try {
        const r2 = await query(`SELECT v FROM stockos_meta WHERE k='turno_pedidos_ddl_v1'`);
        if (r2.rows.length) { turnoPedidosReady = true; return; }
      } catch (_) {}
      /** Alinhar produto_id ao tipo de produtos.id (INTEGER vs UUID — FK falha se diferir). */
      const _pidCheck = await query(
        `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='produtos' AND column_name='id'`
      ).catch(() => ({ rows: [] }));
      const _pidType = _pidCheck.rows.length > 0 ? String(_pidCheck.rows[0].data_type).toLowerCase() : 'integer';
      const pidSql = _pidType === 'uuid' ? 'UUID' : _pidType === 'bigint' ? 'BIGINT' : 'INTEGER';

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
      await query(`CREATE TABLE IF NOT EXISTS turno_pedidos (
        id SERIAL PRIMARY KEY,
        turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
        cliente_nome TEXT NOT NULL DEFAULT '',
        tipo_pagamento VARCHAR(24) NOT NULL DEFAULT 'dinheiro',
        com_entrega BOOLEAN NOT NULL DEFAULT FALSE,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await query(`ALTER TABLE turno_pedidos ADD COLUMN IF NOT EXISTS tipo_pagamento VARCHAR(24) NOT NULL DEFAULT 'dinheiro'`, []);
      await query(`ALTER TABLE turno_pedidos ADD COLUMN IF NOT EXISTS com_entrega BOOLEAN NOT NULL DEFAULT FALSE`, []);
      await query(`ALTER TABLE turno_pedidos ADD COLUMN IF NOT EXISTS valor_entrega NUMERIC(15,2) NOT NULL DEFAULT 0`, []);
      await query(`CREATE TABLE IF NOT EXISTS turno_pedido_linhas (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER NOT NULL REFERENCES turno_pedidos(id) ON DELETE CASCADE,
        produto_id ${pidSql} NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
        quantidade NUMERIC(10,3) NOT NULL DEFAULT 0
      )`);
      await query(`CREATE INDEX IF NOT EXISTS idx_turno_pedidos_turno ON turno_pedidos(turno_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_turno_pedido_linhas_pedido ON turno_pedido_linhas(pedido_id)`);
      await qry(`INSERT INTO stockos_meta(k,v) VALUES('turno_pedidos_ddl_v1','done') ON CONFLICT(k) DO UPDATE SET v='done'`, [], 'turno-pedidos-meta');
      turnoPedidosReady = true;
    });
    turnoPedidosReady = true; // if lock not acquired, another instance is running DDL — treat as ready
  } catch (e) {
    console.error('[ensureTurnoPedidos]', e && e.message, e && e.stack);
  }
}

/** Garante a coluna valor_entrega em turno_pedidos mesmo se a v1 já está marcada. */
async function ensureTurnoPedidosEntrega() {
  if (turnoPedidosEntregaReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='turno_pedidos_entrega_v1'`);
    if (r.rows.length) { turnoPedidosEntregaReady = true; return; }
  } catch (_) {}
  try {
    await query(`ALTER TABLE turno_pedidos ADD COLUMN IF NOT EXISTS valor_entrega NUMERIC(15,2) NOT NULL DEFAULT 0`);
    await query(`INSERT INTO stockos_meta (k,v) VALUES ('turno_pedidos_entrega_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
    turnoPedidosEntregaReady = true;
  } catch (e) {
    console.warn('[ensureTurnoPedidosEntrega]', e && e.message);
  }
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

  // Upsert SEM ON CONFLICT (não depende do índice único existir na BD —
  // algumas BDs/ambientes têm turno_vendas sem a constraint, e a app pode
  // não ter permissão para a criar).
  if (old.rows.length) {
    await client.query(
      `UPDATE turno_vendas SET quantidade=$3 WHERE turno_id=$1 AND produto_id=$2`,
      [turnoId, produto_id, nq]
    );
  } else {
    await client.query(
      `INSERT INTO turno_vendas (turno_id,produto_id,quantidade) VALUES ($1,$2,$3)`,
      [turnoId, produto_id, nq]
    );
  }

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
    if (emailAlias) {
      const byAlias = await query(
        `SELECT * FROM utilizadores WHERE ativo=true AND LOWER(email)=$1`,
        [emailAlias]
      );
      if (byAlias.rows.length > 0) return byAlias;
    }
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
  } else {
    console.warn('[ensureUsernameColumn] Coluna username ausente — aplica supabase/grant_stockos_app.sql e migrações como postgres, ou POST /api/migrate.');
  }

  await query(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS face_foto_url TEXT NOT NULL DEFAULT ''`).catch(() => {});
  usernameColumnEnsured = true;
}

function loginFromBody(req) {
  const v = (req.body.login || req.body.email || '').trim();
  return v;
}

async function ensureDepositosBanco() {
  if (depositosBancoReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='depositos_banco_ddl_v3'`);
    if (r.rows.length) { depositosBancoReady = true; depositosSaidasMigrationDone = true; return; }
  } catch (_) {}
  try {
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
    try { await query(`ALTER TABLE depositos_banco ALTER COLUMN turno_id SET NOT NULL`); } catch (_) {}
    try { await query(`CREATE UNIQUE INDEX IF NOT EXISTS depositos_banco_turno_id_key ON depositos_banco(turno_id)`); } catch (_) {}
    await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS valor_tpa NUMERIC(15,2) NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS valor_transferencia NUMERIC(15,2) NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS valor_saidas NUMERIC(15,2) NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS saidas_destino TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS bordero_foto_url TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await query(`ALTER TABLE depositos_banco ADD COLUMN IF NOT EXISTS fechado BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    if (!depositosSaidasMigrationDone) {
      try {
        await migrateDepositosSaidasAntigasAgrupadas();
        depositosSaidasMigrationDone = true;
      } catch (e) {
        console.error('migrateDepositosSaidasAntigasAgrupadas', e);
      }
    }
    await query(`INSERT INTO stockos_meta (k,v) VALUES ('depositos_banco_ddl_v3','done') ON CONFLICT (k) DO NOTHING`);
    depositosBancoReady = true;
  } catch (e) {
    console.warn('[ensureDepositosBanco]', e && e.message);
  }
}

function sanitizeSaidasDestino(s) {
  return String(s ?? '')
    .trim()
    .slice(0, 2000);
}

const BORDERO_BUCKET = 'depositos-bordero';
const FACE_FOTO_PREFIX = 'faces';

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

async function uploadFaceFotoToSupabase(buffer, uid, contentType, ext) {
  const { url: base, key: serviceKey } = getSupabaseEnv();
  if (!base || !serviceKey) return null;
  const key = `${FACE_FOTO_PREFIX}/${uid}.${ext}`;
  const uploadUrl = `${base}/storage/v1/object/${BORDERO_BUCKET}/${key}`;
  const r = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buffer
  });
  if (!r.ok) return null;
  return `${base}/storage/v1/object/public/${BORDERO_BUCKET}/${key}`;
}

async function deleteFaceFotoFromSupabase(publicUrl) {
  const { url: base, key: serviceKey } = getSupabaseEnv();
  if (!base || !serviceKey || !publicUrl) return;
  const marker = `/storage/v1/object/public/${BORDERO_BUCKET}/`;
  const i = publicUrl.indexOf(marker);
  if (i < 0) return;
  const path = publicUrl.slice(i + marker.length);
  if (!path) return;
  await fetch(`${base}/storage/v1/object/${BORDERO_BUCKET}/${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey }
  }).catch(() => {});
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

// Sonda de ligação REAL do frontend (a faixa de estado usa isto — o
// navigator.onLine só diz se o Wi-Fi/dados estão ligados). Sem auth, sem BD.
app.post('/api/ping', (req, res) => res.json({ ok: true }));
app.get('/api/ping', (req, res) => res.json({ ok: true }));

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
    'produtos-venda-por-copo'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS kg_por_copo NUMERIC(10,4) NOT NULL DEFAULT 0`,
    'produtos-kg-por-copo'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_copos_pacote NUMERIC(15,2) NOT NULL DEFAULT 0`,
    'produtos-preco-copos-pacote'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS qtd_copos_pacote SMALLINT NOT NULL DEFAULT 0`,
    'produtos-qtd-copos-pacote'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS vendavel BOOLEAN NOT NULL DEFAULT FALSE`,
    'produtos-vendavel'
  );
  await run(
    `ALTER TABLE produtos ADD COLUMN IF NOT EXISTS imagem TEXT`,
    'produtos-imagem'
  );
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='produtos_vendavel_backfill_v1'`);
    if (!r.rows.length) {
      await query(
        `UPDATE produtos SET vendavel = TRUE
         WHERE vendavel = FALSE
           AND (categoria IN ('menu','bebida') OR venda_avulso = TRUE)`
      );
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('produtos_vendavel_backfill_v1','done') ON CONFLICT (k) DO NOTHING`);
    }
  } catch (e) { console.warn('[vendavel backfill]', e.message); }
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
/** Indica se a coluna produtos.forca_pacote está disponível.
 *  A BD da app pode usar um role SEM permissão de owner (erro "must be owner
 *  of table produtos"), por isso NÃO podemos depender de ALTER. Detectamos a
 *  existência via information_schema (leitura, não precisa de owner) e, só se
 *  faltar, tentamos criar — falhando em silêncio se não houver permissão.
 *  Quando indisponível, o resto do código trata forca_pacote como false. */
let _forcaPacoteAvail = null; // null/false=re-verifica; true=fica fixo
async function forcaPacoteAvailable() {
  // Só cacheamos o resultado positivo: uma vez que a coluna existe, não
  // desaparece. Se ainda for false/desconhecido, RE-VERIFICAMOS sempre —
  // assim, quando a coluna for criada (por um owner), é apanhada sem ser
  // preciso reiniciar o servidor (evita instância quente colada em false).
  if (_forcaPacoteAvail === true) return true;
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='produtos' AND column_name='forca_pacote' LIMIT 1`
    );
    _forcaPacoteAvail = r.rows.length > 0;
  } catch (e) {
    console.warn('[forcaPacoteAvailable]', e && e.message);
    _forcaPacoteAvail = false;
  }
  return _forcaPacoteAvail;
}

/** Indica se a coluna turno_pedido_linhas.qtd_devolvida existe (devoluções
 *  por unidade). Apenas leitura via information_schema; nunca tenta ALTER
 *  em runtime (a app pode não ter permissão). */
let _qtdDevolvidaAvail = null;
async function qtdDevolvidaAvailable() {
  if (_qtdDevolvidaAvail === true) return true;
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='turno_pedido_linhas' AND column_name='qtd_devolvida' LIMIT 1`
    );
    _qtdDevolvidaAvail = r.rows.length > 0;
  } catch (e) {
    console.warn('[qtdDevolvidaAvailable]', e && e.message);
    _qtdDevolvidaAvail = false;
  }
  return _qtdDevolvidaAvail;
}

app.get('/api/produtos', auth, async (req, res) => {
  try {
    const hasFP = await forcaPacoteAvailable();
    const todos = req.query.todos === '1';
    // Quando a coluna não existe, devolve forca_pacote=false para o frontend
    // não depender dela. Quando existe, p.* já a inclui.
    const fpSel = hasFP ? '' : ', false AS forca_pacote';
    const emp = empresaDe(req);
    const r = await queryEmpresa(
      `SELECT p.*${fpSel}, EXISTS(SELECT 1 FROM receitas r WHERE r.componente_id = p.id) AS is_ingrediente
       FROM produtos p WHERE p.empresa_id=$1 ${todos ? '' : 'AND p.ativo=true'} ORDER BY p.ordem, p.nome`,
      [emp],
      `SELECT p.*${fpSel}, EXISTS(SELECT 1 FROM receitas r WHERE r.componente_id = p.id) AS is_ingrediente
       FROM produtos p ${todos ? '' : 'WHERE p.ativo=true'} ORDER BY p.ordem, p.nome`,
      []
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/produtos', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    const { nome, preco, categoria, venda_avulso, tipo_medicao, em_stock_turno, vendavel } = req.body;
    const {
      venda_por_copo,
      kg_por_copo,
      preco_copos_pacote,
      qtd_copos_pacote,
      forca_pacote,
      comissao_pct,
      imagem
    } = req.body;
    const medicao = tipo_medicao === 'peso' ? 'peso' : 'unidade';
    const maxOrdem = await query('SELECT COALESCE(MAX(ordem),0)+1 as n FROM produtos');
    const noTurno = em_stock_turno === undefined || em_stock_turno === null ? true : !!em_stock_turno;
    const cat = categoria || 'outro';
    const vendavelFinal = vendavel === undefined || vendavel === null
      ? (cat === 'menu' || cat === 'bebida' || !!venda_avulso)
      : !!vendavel;
    const vpc = !!venda_por_copo;
    const kgc = parseFloat(kg_por_copo) || 0;
    const pcp = parseFloat(preco_copos_pacote) || 0;
    const qcp = Math.min(999, Math.max(0, parseInt(qtd_copos_pacote, 10) || 0));
    const cpct = Math.max(0, Math.min(100, parseFloat(comissao_pct) || 0));
    const img = typeof imagem === 'string' && imagem.trim() ? imagem.trim() : null;
    const fp = !!forca_pacote && qcp >= 2;
    const paramsProd = [
      nome,
      preco || 0,
      cat,
      maxOrdem.rows[0].n,
      !!venda_avulso,
      medicao,
      noTurno,
      vpc,
      kgc,
      pcp,
      qcp,
      vendavelFinal,
      cpct,
      img
    ];
    const r = await queryEmpresa(
      `INSERT INTO produtos (nome,preco,categoria,ordem,venda_avulso,tipo_medicao,em_stock_turno,venda_por_copo,kg_por_copo,preco_copos_pacote,qtd_copos_pacote,vendavel,comissao_pct,imagem,empresa_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [...paramsProd, empresaDe(req)],
      `INSERT INTO produtos (nome,preco,categoria,ordem,venda_avulso,tipo_medicao,em_stock_turno,venda_por_copo,kg_por_copo,preco_copos_pacote,qtd_copos_pacote,vendavel,comissao_pct,imagem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      paramsProd
    );
    const row = r.rows[0];
    // forca_pacote em escrita separada e opcional (coluna pode não existir
    // se a BD não permitir ALTER — feature degrada sem partir o save).
    if (await forcaPacoteAvailable()) {
      try {
        await query(`UPDATE produtos SET forca_pacote=$1 WHERE id=$2`, [fp, row.id]);
        row.forca_pacote = fp;
      } catch (e) { console.warn('[produtos POST forca_pacote]', e && e.message); }
    } else {
      row.forca_pacote = false;
    }
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
    // Isolamento: só produtos da empresa efectiva podem ser editados.
    const chkEmp = await queryEmpresa(
      `SELECT 1 FROM produtos WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT 1 FROM produtos WHERE id=$1`, [req.params.id]
    );
    if (!chkEmp.rows.length) return res.status(404).json({ erro: 'Produto não encontrado' });
    const { nome, preco, categoria, ordem, ativo, venda_avulso, tipo_medicao, em_stock_turno, vendavel } = req.body;
    const {
      venda_por_copo,
      kg_por_copo,
      preco_copos_pacote,
      qtd_copos_pacote,
      forca_pacote,
      comissao_pct,
      imagem
    } = req.body;
    const medicao = tipo_medicao === 'peso' ? 'peso' : 'unidade';
    const noTurno =
      em_stock_turno === undefined || em_stock_turno === null ? undefined : !!em_stock_turno;
    const vendavelFinal =
      vendavel === undefined || vendavel === null
        ? (categoria === 'menu' || categoria === 'bebida' || !!venda_avulso)
        : !!vendavel;
    const vpc = !!venda_por_copo;
    const kgc = parseFloat(kg_por_copo) || 0;
    const pcp = parseFloat(preco_copos_pacote) || 0;
    const qcp = Math.min(999, Math.max(0, parseInt(qtd_copos_pacote, 10) || 0));
    const fp = !!forca_pacote && qcp >= 2;
    const cpct = comissao_pct === undefined || comissao_pct === null
      ? undefined
      : Math.max(0, Math.min(100, parseFloat(comissao_pct) || 0));
    // imagem: undefined → não alterar; null/'' → limpar; string → guardar.
    let imgArg;
    if (imagem === undefined) imgArg = undefined;
    else if (imagem === null || (typeof imagem === 'string' && imagem.trim() === '')) imgArg = null;
    else imgArg = String(imagem).trim();
    const r =
      noTurno === undefined
        ? await query(
            `UPDATE produtos SET nome=$1,preco=$2,categoria=$3,ordem=$4,ativo=$5,venda_avulso=$6,tipo_medicao=$7,
             venda_por_copo=$8,kg_por_copo=$9,preco_copos_pacote=$10,qtd_copos_pacote=$11,vendavel=$12,
             comissao_pct=COALESCE($13, comissao_pct),
             imagem = CASE WHEN $14::boolean THEN $15::text ELSE imagem END
             WHERE id=$16 RETURNING *`,
            [
              nome,
              preco,
              categoria,
              ordem,
              ativo,
              !!venda_avulso,
              medicao,
              vpc,
              kgc,
              pcp,
              qcp,
              vendavelFinal,
              cpct === undefined ? null : cpct,
              imgArg !== undefined,
              imgArg === undefined ? null : imgArg,
              req.params.id
            ]
          )
        : await query(
            `UPDATE produtos SET nome=$1,preco=$2,categoria=$3,ordem=$4,ativo=$5,venda_avulso=$6,tipo_medicao=$7,em_stock_turno=$8,
             venda_por_copo=$9,kg_por_copo=$10,preco_copos_pacote=$11,qtd_copos_pacote=$12,vendavel=$13,
             comissao_pct=COALESCE($14, comissao_pct),
             imagem = CASE WHEN $15::boolean THEN $16::text ELSE imagem END
             WHERE id=$17 RETURNING *`,
            [
              nome,
              preco,
              categoria,
              ordem,
              ativo,
              !!venda_avulso,
              medicao,
              noTurno,
              vpc,
              kgc,
              pcp,
              qcp,
              vendavelFinal,
              cpct === undefined ? null : cpct,
              imgArg !== undefined,
              imgArg === undefined ? null : imgArg,
              req.params.id
            ]
          );
    const out = r.rows[0];
    // forca_pacote em escrita separada e opcional.
    if (out && await forcaPacoteAvailable()) {
      try {
        await query(`UPDATE produtos SET forca_pacote=$1 WHERE id=$2`, [fp, req.params.id]);
        out.forca_pacote = fp;
      } catch (e) { console.warn('[produtos PUT forca_pacote]', e && e.message); }
    } else if (out) {
      out.forca_pacote = false;
    }
    res.json(out);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/produtos/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await query('UPDATE produtos SET ativo=false WHERE id=$1', [req.params.id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── EM FALTA ──────────────────────────────────────────────────
async function ensureProdutoFaltas() {
  if (produtoFaltasReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='produto_faltas_ddl_v4'`);
    if (r.rows.length) { produtoFaltasReady = true; return; }
  } catch (_) {}
  const pidCheck = await query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='produtos' AND column_name='id'`
  ).catch(() => ({ rows: [] }));
  const pidType = (pidCheck.rows[0] && pidCheck.rows[0].data_type) || 'integer';
  const pidCol = pidType === 'uuid' ? 'UUID' : 'INTEGER';
  await query(`CREATE TABLE IF NOT EXISTS produto_faltas (
    id SERIAL PRIMARY KEY,
    produto_id ${pidCol} REFERENCES produtos(id) ON DELETE SET NULL,
    produto_nome_livre TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    reportado_por TEXT NOT NULL DEFAULT '',
    reportado_por_nome TEXT NOT NULL DEFAULT '',
    reportado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolvido_em TIMESTAMPTZ,
    resolvido_por TEXT NOT NULL DEFAULT '',
    resolvido_por_nome TEXT NOT NULL DEFAULT '',
    resolvido_foto_base64 TEXT,
    atribuido_a TEXT,
    atribuido_a_nome TEXT,
    atribuido_em TIMESTAMPTZ
  )`).catch(() => {});
  await query(`ALTER TABLE produto_faltas ALTER COLUMN produto_id DROP NOT NULL`).catch(() => {});
  await query(`ALTER TABLE produto_faltas ADD COLUMN IF NOT EXISTS produto_nome_livre TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await query(`ALTER TABLE produto_faltas ADD COLUMN IF NOT EXISTS resolvido_foto_base64 TEXT`).catch(() => {});
  await query(`ALTER TABLE produto_faltas ADD COLUMN IF NOT EXISTS atribuido_a TEXT`).catch(() => {});
  await query(`ALTER TABLE produto_faltas ADD COLUMN IF NOT EXISTS atribuido_a_nome TEXT`).catch(() => {});
  await query(`ALTER TABLE produto_faltas ADD COLUMN IF NOT EXISTS atribuido_em TIMESTAMPTZ`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS produto_faltas_pendentes_idx ON produto_faltas (resolvido_em) WHERE resolvido_em IS NULL`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS produto_faltas_reportado_idx ON produto_faltas (reportado_em DESC)`).catch(() => {});
  await query(`INSERT INTO stockos_meta (k,v) VALUES ('produto_faltas_ddl_v4','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
  produtoFaltasReady = true;
}

/** Lista de avisos «em falta». status=pendentes (default) | resolvidas | todas. */
app.get('/api/faltas', auth, async (req, res) => {
  try {
    await ensureProdutoFaltas();
    const status = String(req.query.status || 'pendentes').toLowerCase();
    let where = '';
    if (status === 'pendentes') where = 'WHERE f.resolvido_em IS NULL';
    else if (status === 'resolvidas') where = "WHERE f.resolvido_em IS NOT NULL AND f.resolvido_em > NOW() - INTERVAL '30 days'";
    const selFal = `SELECT f.id, f.produto_id, f.produto_nome_livre, f.notas,
              f.reportado_por, f.reportado_por_nome, f.reportado_em,
              f.resolvido_em, f.resolvido_por, f.resolvido_por_nome,
              (f.resolvido_foto_base64 IS NOT NULL) AS tem_foto,
              f.atribuido_a, f.atribuido_a_nome, f.atribuido_em,
              COALESCE(p.nome, f.produto_nome_livre) AS produto_nome,
              p.categoria AS produto_categoria, p.tipo_medicao AS produto_tipo_medicao,
              (f.produto_id IS NULL) AS produto_livre
       FROM produto_faltas f
       LEFT JOIN produtos p ON p.id = f.produto_id`;
    const ordFal = ` ORDER BY (f.resolvido_em IS NULL) DESC, f.reportado_em DESC LIMIT 200`;
    const whereLojaFal = where ? `${where} AND f.loja_id=$1` : 'WHERE f.loja_id=$1';
    const whereEmpFal = where ? `${where} AND f.empresa_id=$1` : 'WHERE f.empresa_id=$1';
    const r = await queryEmpresa(
      `${selFal} ${whereLojaFal}${ordFal}`, [lojaDe(req)],
      `${selFal} ${whereEmpFal}${ordFal}`, [empresaDe(req)]
    ).catch(() => query(`${selFal} ${where}${ordFal}`, []));
    res.json(r.rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Contagem de pendentes (para o badge no menu). */
app.get('/api/faltas/pendentes-count', auth, async (req, res) => {
  try {
    await ensureProdutoFaltas();
    const r = await queryEmpresa(
      `SELECT COUNT(*)::int AS n FROM produto_faltas WHERE resolvido_em IS NULL AND loja_id=$1`, [lojaDe(req)],
      `SELECT COUNT(*)::int AS n FROM produto_faltas WHERE resolvido_em IS NULL AND empresa_id=$1`, [empresaDe(req)]
    ).catch(() => query(`SELECT COUNT(*)::int AS n FROM produto_faltas WHERE resolvido_em IS NULL`, []));
    res.json({ pendentes: r.rows[0].n });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Reportar novo aviso — qualquer utilizador autenticado. */
app.post('/api/faltas', auth, async (req, res) => {
  try {
    await ensureProdutoFaltas();
    const { produto_id, produto_nome_livre, notas } = req.body || {};
    const nomeLivre = String(produto_nome_livre || '').trim();
    if (!produto_id && !nomeLivre) {
      return res.status(400).json({ erro: 'Indica um produto (existente ou um nome livre)' });
    }
    if (produto_id) {
      const dup = await query(
        `SELECT id FROM produto_faltas WHERE produto_id = $1 AND resolvido_em IS NULL LIMIT 1`,
        [produto_id]
      );
      if (dup.rows.length) return res.status(400).json({ erro: 'Já existe um aviso pendente para este produto' });
    } else {
      const dup = await query(
        `SELECT id FROM produto_faltas
         WHERE produto_id IS NULL AND LOWER(produto_nome_livre) = LOWER($1) AND resolvido_em IS NULL LIMIT 1`,
        [nomeLivre]
      );
      if (dup.rows.length) return res.status(400).json({ erro: 'Já existe um aviso pendente para este produto' });
    }
    const pFal = [produto_id || null, produto_id ? '' : nomeLivre, String(notas || '').trim(), String(req.user.id || ''), String(req.user.nome || '')];
    const r = await queryEmpresa(
      `INSERT INTO produto_faltas (produto_id, produto_nome_livre, notas, reportado_por, reportado_por_nome, empresa_id, loja_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [...pFal, empresaDe(req), lojaDe(req)],
      `INSERT INTO produto_faltas (produto_id, produto_nome_livre, notas, reportado_por, reportado_por_nome)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      pFal
    ).catch(() => queryEmpresa(
      `INSERT INTO produto_faltas (produto_id, produto_nome_livre, notas, reportado_por, reportado_por_nome, empresa_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [...pFal, empresaDe(req)],
      `INSERT INTO produto_faltas (produto_id, produto_nome_livre, notas, reportado_por, reportado_por_nome)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      pFal
    ));
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Marcar como resolvido — exige foto (prova). Qualquer utilizador autenticado. */
app.patch('/api/faltas/:id', auth, async (req, res) => {
  try {
    const chkF = await queryEmpresa(
      `SELECT 1 FROM produto_faltas WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT 1 FROM produto_faltas WHERE id=$1`, [req.params.id]
    );
    if (!chkF.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado' });

    await ensureProdutoFaltas();
    const foto = String(req.body?.foto_base64 || '').trim();
    if (!foto || !foto.startsWith('data:image/')) {
      return res.status(400).json({ erro: 'É obrigatório anexar uma foto da resolução.' });
    }
    if (foto.length > 8 * 1024 * 1024) {
      return res.status(400).json({ erro: 'Foto demasiado grande (máx. ~6 MB).' });
    }
    const r = await query(
      `UPDATE produto_faltas
       SET resolvido_em = NOW(), resolvido_por = $1, resolvido_por_nome = $2, resolvido_foto_base64 = $3
       WHERE id = $4 AND resolvido_em IS NULL RETURNING id, produto_id, produto_nome_livre, notas, reportado_por, reportado_por_nome, reportado_em, resolvido_em, resolvido_por, resolvido_por_nome,
         (resolvido_foto_base64 IS NOT NULL) AS tem_foto`,
      [String(req.user.id || ''), String(req.user.nome || ''), foto, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado ou já resolvido' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Atribuir o aviso pendente a um utilizador (responsável por resolver). Qualquer auth. */
app.patch('/api/faltas/:id/atribuir', auth, async (req, res) => {
  try {
    const chkF = await queryEmpresa(
      `SELECT 1 FROM produto_faltas WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT 1 FROM produto_faltas WHERE id=$1`, [req.params.id]
    );
    if (!chkF.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado' });

    await ensureProdutoFaltas();
    const uid = req.body?.utilizador_id ? String(req.body.utilizador_id).trim() : null;
    if (uid) {
      const u = await query('SELECT id, nome FROM utilizadores WHERE id=$1', [uid]);
      if (!u.rows.length) return res.status(404).json({ erro: 'Utilizador não encontrado.' });
      const r = await query(
        `UPDATE produto_faltas SET atribuido_a=$1, atribuido_a_nome=$2, atribuido_em=NOW()
         WHERE id=$3 AND resolvido_em IS NULL
         RETURNING id, atribuido_a, atribuido_a_nome, atribuido_em`,
        [uid, u.rows[0].nome || '', req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado ou já resolvido.' });
      return res.json(r.rows[0]);
    }
    // Sem utilizador → remove atribuição.
    const r2 = await query(
      `UPDATE produto_faltas SET atribuido_a=NULL, atribuido_a_nome=NULL, atribuido_em=NULL
       WHERE id=$1 AND resolvido_em IS NULL
       RETURNING id, atribuido_a, atribuido_a_nome, atribuido_em`,
      [req.params.id]
    );
    if (!r2.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado ou já resolvido.' });
    res.json(r2.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Devolve a foto base64 de um aviso resolvido (lazy — não inclui na lista). */
app.get('/api/faltas/:id/foto', auth, async (req, res) => {
  try {
    const chkF = await queryEmpresa(
      `SELECT 1 FROM produto_faltas WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT 1 FROM produto_faltas WHERE id=$1`, [req.params.id]
    );
    if (!chkF.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado' });

    await ensureProdutoFaltas();
    const r = await query(`SELECT resolvido_foto_base64 FROM produto_faltas WHERE id=$1`, [req.params.id]);
    if (!r.rows.length || !r.rows[0].resolvido_foto_base64) return res.status(404).json({ erro: 'Sem foto.' });
    res.json({ foto_base64: r.rows[0].resolvido_foto_base64 });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Apagar — só admin. */
app.delete('/api/faltas/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureProdutoFaltas();
    await query(`DELETE FROM produto_faltas WHERE id = $1`, [req.params.id]);
    res.json({ sucesso: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
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
  if (fornecedoresReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='fornecedores_ddl_v1'`);
    if (r.rows.length) { fornecedoresReady = true; return; }
  } catch (_) {}
  try {
    await query(`CREATE TABLE IF NOT EXISTS fornecedores (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      notas TEXT NOT NULL DEFAULT '',
      ativo BOOLEAN NOT NULL DEFAULT true,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      criado_por TEXT NOT NULL DEFAULT ''
    )`);
    await query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS telefone TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS morada TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS nif TEXT NOT NULL DEFAULT ''`).catch(() => {});
    await query(`ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS fornecedor_id INTEGER`).catch(() => {});
    await query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'armazem_faturas_fornecedor_id_fkey') THEN
        ALTER TABLE armazem_faturas ADD CONSTRAINT armazem_faturas_fornecedor_id_fkey
        FOREIGN KEY (fornecedor_id) REFERENCES fornecedores(id) ON DELETE SET NULL;
      END IF;
    END $$`).catch(() => {});
    await query(`INSERT INTO stockos_meta (k,v) VALUES ('fornecedores_ddl_v1','done') ON CONFLICT (k) DO NOTHING`);
    fornecedoresReady = true;
  } catch (e) {
    console.warn('[ensureFornecedores]', e && e.message);
  }
}

app.get('/api/fornecedores', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureFornecedores();
    const todos = req.query.todos === '1';
    const emp = empresaDe(req);
    const r = await queryEmpresa(
      `SELECT * FROM fornecedores WHERE empresa_id=$1 ${todos ? '' : 'AND ativo = true'} ORDER BY LOWER(nome)`,
      [emp],
      `SELECT * FROM fornecedores ${todos ? '' : 'WHERE ativo = true'} ORDER BY LOWER(nome)`,
      []
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/fornecedores', auth, requireRole('admin', 'gestor', 'compras'), async (req, res) => {
  try {
    await ensureFornecedores();
    const { nome, notas, telefone, email, morada, nif } = req.body || {};
    const n = String(nome || '').trim();
    if (!n) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const paramsForn = [n, String(notas || '').trim(), String(req.user.id || ''),
       String(telefone || '').trim(), String(email || '').trim(),
       String(morada || '').trim(), String(nif || '').trim()];
    const r = await queryEmpresa(
      `INSERT INTO fornecedores (nome, notas, criado_por, telefone, email, morada, nif, empresa_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [...paramsForn, empresaDe(req)],
      `INSERT INTO fornecedores (nome, notas, criado_por, telefone, email, morada, nif)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      paramsForn
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
    const { nome, notas, ativo, telefone, email, morada, nif } = req.body || {};
    const row = await queryEmpresa(
      'SELECT * FROM fornecedores WHERE id=$1 AND empresa_id=$2', [id, empresaDe(req)],
      'SELECT * FROM fornecedores WHERE id=$1', [id]
    );
    if (!row.rows.length) return res.status(404).json({ erro: 'Fornecedor não encontrado' });
    const nomeF = nome != null ? String(nome).trim() : row.rows[0].nome;
    if (!nomeF) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const notasF = notas != null ? String(notas).trim() : row.rows[0].notas;
    const ativoF = ativo !== undefined && ativo !== null ? !!ativo : row.rows[0].ativo;
    const telF = telefone != null ? String(telefone).trim() : (row.rows[0].telefone || '');
    const emailF = email != null ? String(email).trim() : (row.rows[0].email || '');
    const moradaF = morada != null ? String(morada).trim() : (row.rows[0].morada || '');
    const nifF = nif != null ? String(nif).trim() : (row.rows[0].nif || '');
    const r = await query(
      `UPDATE fornecedores SET nome=$1, notas=$2, ativo=$3, telefone=$4, email=$5, morada=$6, nif=$7 WHERE id=$8 RETURNING *`,
      [nomeF, notasF, ativoF, telF, emailF, moradaF, nifF, id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

async function ensureArmazemTables() {
  if (armazemTablesReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='armazem_tables_ddl_v1'`);
    if (r.rows.length) { armazemTablesReady = true; return; }
  } catch (_) {}
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
  await query(`INSERT INTO stockos_meta (k,v) VALUES ('armazem_tables_ddl_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
  armazemTablesReady = true;
}

app.get('/api/armazem/saldo', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const data = req.query.data || new Date().toISOString().split('T')[0];
    const emp = empresaDe(req);
    const lojaAmz = lojaDe(req);
    const lib = await queryEmpresa(
      `SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1 AND loja_id=$2`, [data, lojaAmz],
      `SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1 AND empresa_id=$2`, [data, emp]
    ).catch(() => query(`SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1`, [data]));
    const fat = await queryEmpresa(
      `SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1 AND loja_id=$2`, [data, lojaAmz],
      `SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1 AND empresa_id=$2`, [data, emp]
    ).catch(() => query(`SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1`, [data]));
    const lisSel = `SELECT l.*, u.nome as criado_por_nome FROM armazem_libertacoes l
       LEFT JOIN utilizadores u ON u.id::text = l.criado_por::text`;
    const lis = await queryEmpresa(
      `${lisSel} WHERE l.data=$1 AND l.loja_id=$2 ORDER BY l.criado_em DESC`, [data, lojaAmz],
      `${lisSel} WHERE l.data=$1 AND l.empresa_id=$2 ORDER BY l.criado_em DESC`, [data, emp]
    ).catch(() => query(`${lisSel} WHERE l.data=$1 ORDER BY l.criado_em DESC`, [data]));
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
    const selSd = `SELECT s.id, s.turno_id, s.descricao, s.valor, s.notas, s.criado_em, t.nome as turno_nome
       FROM turno_saidas s
       JOIN turnos t ON t.id = s.turno_id`;
    const r = await queryEmpresa(
      `${selSd} WHERE t.data = $1 AND t.loja_id = $2 ORDER BY s.criado_em DESC`,
      [data, lojaDe(req)],
      `${selSd} WHERE t.data = $1 ORDER BY s.criado_em DESC`,
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
    const pLib = [d, v, String(notas || '').trim(), String(req.user.id || '')];
    const r = await queryEmpresa(
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por, empresa_id, loja_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [...pLib, empresaDe(req), lojaDe(req)],
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      pLib
    ).catch(() => queryEmpresa(
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por, empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [...pLib, empresaDe(req)],
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      pLib
    ));
    res.json(r.rows[0]);
  } catch(e) { res.status(400).json({ erro: e.message }); }
});

app.delete('/api/armazem/libertacoes/:id', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const r = await queryEmpresa(
      'DELETE FROM armazem_libertacoes WHERE id=$1 AND empresa_id=$2 RETURNING id', [req.params.id, empresaDe(req)],
      'DELETE FROM armazem_libertacoes WHERE id=$1 RETURNING id', [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Libertação não encontrada' });
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ erro: e.message }); }
});

// ── Faturas PROFORMA: lista de produtos a comprar, criada ANTES do dinheiro
//    ser libertado. Fluxo: pendente → libertada (cria a libertação do dia)
//    → comprada (ligada à fatura de compra real). ──
let armazemProformasReady = false;
async function ensureArmazemProformas() {
  if (armazemProformasReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='armazem_proformas_ddl_v2'`);
    if (r.rows.length) { armazemProformasReady = true; return; }
  } catch (_) {}
  try {
    const t = await query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='produtos' AND column_name='id'`
    );
    const dt = String((t.rows[0] && t.rows[0].data_type) || '').toLowerCase();
    const pidCol = dt === 'uuid' ? 'UUID' : dt === 'bigint' ? 'BIGINT' : 'INTEGER';
    await query(`CREATE TABLE IF NOT EXISTS armazem_proformas (
      id SERIAL PRIMARY KEY,
      fornecedor TEXT NOT NULL DEFAULT '',
      notas TEXT NOT NULL DEFAULT '',
      total_valor NUMERIC(15,2) NOT NULL DEFAULT 0,
      estado VARCHAR(12) NOT NULL DEFAULT 'pendente',
      libertacao_id INTEGER,
      fatura_id INTEGER,
      criado_por TEXT NOT NULL DEFAULT '',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS armazem_proforma_linhas (
      id SERIAL PRIMARY KEY,
      proforma_id INTEGER NOT NULL REFERENCES armazem_proformas(id) ON DELETE CASCADE,
      produto_id ${pidCol} NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
      quantidade NUMERIC(12,3) NOT NULL DEFAULT 0,
      caixas NUMERIC(12,3) NOT NULL DEFAULT 0,
      qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0,
      preco_unitario NUMERIC(15,2) NOT NULL DEFAULT 0,
      valor_total NUMERIC(15,2) NOT NULL DEFAULT 0
    )`);
    await query(`ALTER TABLE armazem_proforma_linhas ADD COLUMN IF NOT EXISTS caixas NUMERIC(12,3) NOT NULL DEFAULT 0`).catch(() => {});
    await query(`ALTER TABLE armazem_proforma_linhas ADD COLUMN IF NOT EXISTS qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0`).catch(() => {});
    await query(`INSERT INTO stockos_meta (k,v) VALUES ('armazem_proformas_ddl_v2','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
    armazemProformasReady = true;
  } catch (e) {
    console.warn('[ensureArmazemProformas]', e && e.message);
  }
}

app.get('/api/armazem/proformas', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemProformas();
    const selPf = `SELECT pf.*, u.nome AS criado_por_nome
       FROM armazem_proformas pf
       LEFT JOIN utilizadores u ON u.id::text = pf.criado_por::text`;
    const r = await queryEmpresa(
      `${selPf} WHERE pf.loja_id=$1 ORDER BY (pf.estado = 'comprada') ASC, pf.criado_em DESC LIMIT 100`,
      [lojaDe(req)],
      `${selPf} WHERE pf.empresa_id=$1 ORDER BY (pf.estado = 'comprada') ASC, pf.criado_em DESC LIMIT 100`,
      [empresaDe(req)]
    ).catch(() => query(`${selPf} ORDER BY (pf.estado = 'comprada') ASC, pf.criado_em DESC LIMIT 100`, []));
    const ids = r.rows.map((x) => x.id);
    const byId = {};
    r.rows.forEach((pf) => { byId[pf.id] = { ...pf, linhas: [] }; });
    if (ids.length) {
      const lr = await query(
        `SELECT l.*, p.nome AS produto_nome, p.tipo_medicao
         FROM armazem_proforma_linhas l
         JOIN produtos p ON p.id = l.produto_id
         WHERE l.proforma_id = ANY($1::int[])
         ORDER BY l.id`,
        [ids]
      );
      lr.rows.forEach((l) => { if (byId[l.proforma_id]) byId[l.proforma_id].linhas.push(l); });
    }
    res.json(r.rows.map((pf) => byId[pf.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/armazem/proformas', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemProformas();
    const { fornecedor, notas, linhas } = req.body || {};
    if (!Array.isArray(linhas) || !linhas.length) {
      return res.status(400).json({ erro: 'Adiciona pelo menos uma linha (produto, quantidade e preço).' });
    }
    let total = 0;
    const norm = [];
    for (const ln of linhas) {
      if (!ln.produto_id) return res.status(400).json({ erro: 'Cada linha precisa de um produto.' });
      const caixas = parseFloat(ln.caixas) || 0;
      const qtdPor = parseFloat(ln.qtd_por_caixa) || 0;
      const precoCaixa = parseFloat(ln.preco_caixa) || 0;
      let q, pu, vt;
      if (caixas > 0) {
        // Compra em CAIXA: quantidade = caixas × qtd/caixa; preço unitário
        // derivado; total = caixas × preço da caixa.
        if (qtdPor <= 0 || precoCaixa <= 0) {
          return res.status(400).json({ erro: 'Nas linhas em caixa indica nº de caixas, qtd por caixa e preço da caixa.' });
        }
        q = Math.round(caixas * qtdPor * 1000) / 1000;
        pu = Math.round((precoCaixa / qtdPor) * 100) / 100;
        vt = Math.round(caixas * precoCaixa * 100) / 100;
      } else {
        q = parseFloat(ln.quantidade);
        pu = parseFloat(ln.preco_unitario);
        if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(pu) || pu <= 0) {
          return res.status(400).json({ erro: 'Cada linha precisa de quantidade e preço unitário válidos.' });
        }
        vt = Math.round(q * pu * 100) / 100;
      }
      total += vt;
      norm.push({ produto_id: ln.produto_id, quantidade: q, caixas, qtd_por_caixa: qtdPor, preco_unitario: pu, valor_total: vt });
    }
    const pPf = [String(fornecedor || '').trim(), String(notas || '').trim(), Math.round(total * 100) / 100, String(req.user.id || '')];
    const ins = await queryEmpresa(
      `INSERT INTO armazem_proformas (fornecedor, notas, total_valor, criado_por, empresa_id, loja_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [...pPf, empresaDe(req), lojaDe(req)],
      `INSERT INTO armazem_proformas (fornecedor, notas, total_valor, criado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      pPf
    ).catch(() => queryEmpresa(
      `INSERT INTO armazem_proformas (fornecedor, notas, total_valor, criado_por, empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [...pPf, empresaDe(req)],
      `INSERT INTO armazem_proformas (fornecedor, notas, total_valor, criado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      pPf
    ));
    const pf = ins.rows[0];
    for (const ln of norm) {
      await query(
        `INSERT INTO armazem_proforma_linhas (proforma_id, produto_id, quantidade, caixas, qtd_por_caixa, preco_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [pf.id, ln.produto_id, ln.quantidade, ln.caixas, ln.qtd_por_caixa, ln.preco_unitario, ln.valor_total]
      );
    }
    res.json(pf);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

/** Liberta o valor total da proforma: cria uma libertação no dia indicado
 *  e marca a proforma como «libertada». */
app.post('/api/armazem/proformas/:id/libertar', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemProformas();
    await ensureArmazemTables();
    const pfr = await queryEmpresa(
      `SELECT * FROM armazem_proformas WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT * FROM armazem_proformas WHERE id=$1`, [req.params.id]
    );
    if (!pfr.rows.length) return res.status(404).json({ erro: 'Proforma não encontrada' });
    const pf = pfr.rows[0];
    if (pf.estado !== 'pendente') return res.status(400).json({ erro: `Esta proforma já está ${pf.estado}.` });
    const d = String((req.body && req.body.data) || new Date().toISOString().split('T')[0]).slice(0, 10);
    const pLibPf = [d, parseFloat(pf.total_valor) || 0, `Proforma #${pf.id}${pf.fornecedor ? ' — ' + pf.fornecedor : ''}`, String(req.user.id || '')];
    const lib = await queryEmpresa(
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por, empresa_id, loja_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [...pLibPf, parseInt(pf.empresa_id, 10) || empresaDe(req), parseInt(pf.loja_id, 10) || lojaDe(req)],
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      pLibPf
    ).catch(() => queryEmpresa(
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por, empresa_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [...pLibPf, parseInt(pf.empresa_id, 10) || empresaDe(req)],
      `INSERT INTO armazem_libertacoes (data, valor, notas, criado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
      pLibPf
    ));
    const upd = await query(
      `UPDATE armazem_proformas SET estado='libertada', libertacao_id=$1 WHERE id=$2 RETURNING *`,
      [lib.rows[0].id, pf.id]
    );
    res.json(upd.rows[0]);
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.delete('/api/armazem/proformas/:id', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemProformas();
    const r = await queryEmpresa(
      `DELETE FROM armazem_proformas WHERE id=$1 AND estado='pendente' AND empresa_id=$2 RETURNING id`, [req.params.id, empresaDe(req)],
      `DELETE FROM armazem_proformas WHERE id=$1 AND estado='pendente' RETURNING id`, [req.params.id]
    );
    if (!r.rows.length) return res.status(400).json({ erro: 'Só proformas pendentes podem ser eliminadas.' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erro: e.message }); }
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
         LEFT JOIN armazem_inventario_diario d ON d.produto_id = p.id AND d.data = $1::date AND d.loja_id = $3
         WHERE p.ativo=true AND p.empresa_id=$2
         ORDER BY p.ordem, p.nome`,
        [dataDia, empresaDe(req), lojaDe(req)]
      ).catch((eInv) => {
        if (!/loja_id/.test(String(eInv.message || ''))) throw eInv;
        return query(
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
           WHERE p.ativo=true AND p.empresa_id=$2
           ORDER BY p.ordem, p.nome`,
          [dataDia, empresaDe(req)]
        );
      }).catch(async (e) => {
        if (!/empresa_id/.test(String(e.message || ''))) throw e;
        return query(
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
      });
      return res.json(r.rows);
    }
    const selInv = `SELECT p.id as produto_id, p.nome as produto_nome, p.categoria, p.tipo_medicao, p.ativo,
              COALESCE(a.quantidade, 0) as quantidade,
              COALESCE(a.custo_medio, 0) as custo_medio,
              a.atualizado_em
       FROM produtos p
       LEFT JOIN armazem_stock a ON a.produto_id = p.id`;
    const r = await queryEmpresa(
      `${selInv} WHERE p.ativo=true AND p.empresa_id=$1 ORDER BY p.ordem, p.nome`, [empresaDe(req)],
      `${selInv} WHERE p.ativo=true ORDER BY p.ordem, p.nome`, []
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
      `INSERT INTO armazem_inventario_diario (data, produto_id, encontrado, deixado, loja_id)
       VALUES ($1::date, $2, $3, $4, $5)
       ON CONFLICT (loja_id, data, produto_id) DO UPDATE SET
         encontrado = EXCLUDED.encontrado,
         deixado = EXCLUDED.deixado,
         atualizado_em = NOW()
       RETURNING *`,
      [d, produto_id, enc, deix, lojaDe(req)]
    ).catch((eInv) => {
      // BD antiga: sem loja_id ou ainda com a unicidade antiga (data, produto).
      if (!/loja_id|ON CONFLICT/i.test(String(eInv.message || ''))) throw eInv;
      return query(
        `INSERT INTO armazem_inventario_diario (data, produto_id, encontrado, deixado)
         VALUES ($1::date, $2, $3, $4)
         ON CONFLICT (data, produto_id) DO UPDATE SET
           encontrado = EXCLUDED.encontrado,
           deixado = EXCLUDED.deixado,
           atualizado_em = NOW()
         RETURNING *`,
        [d, produto_id, enc, deix]
      );
    });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.get('/api/armazem/compras', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '80', 10)));
    const dataDia = (req.query.data || '').trim();
    const dataIni = (req.query.data_inicio || '').trim();
    const dataFim = (req.query.data_fim || '').trim();
    const categoria = (req.query.categoria || '').trim();
    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const wh = [];
    const params = [];
    let i = 0;
    const eff = (sql) => `(c.fatura_id IS NOT NULL AND f.data_emissao ${sql}) OR (c.fatura_id IS NULL AND c.criado_em::date ${sql})`;
    if (isYmd(dataDia)) {
      params.push(dataDia); i++;
      wh.push(`(${eff(`= $${i}::date`)})`);
    }
    if (isYmd(dataIni)) {
      params.push(dataIni); i++;
      wh.push(`(${eff(`>= $${i}::date`)})`);
    }
    if (isYmd(dataFim)) {
      params.push(dataFim); i++;
      wh.push(`(${eff(`<= $${i}::date`)})`);
    }
    if (categoria && ['menu','ingredientes','bebida'].includes(categoria)) {
      params.push(categoria); i++;
      wh.push(`p.categoria = $${i}`);
    }
    const baseCompras = `SELECT c.*, p.nome as produto_nome, p.tipo_medicao, p.categoria as produto_categoria, u.nome as criado_por_nome, f.numero_fatura as fatura_numero, f.data_emissao as fatura_data_emissao
       FROM armazem_compras c
       JOIN produtos p ON p.id = c.produto_id
       LEFT JOIN utilizadores u ON u.id::text = c.criado_por::text
       LEFT JOIN armazem_faturas f ON f.id = c.fatura_id`;
    params.push(empresaDe(req)); i++;
    const whEmp = wh.concat([`p.empresa_id = $${i}`]);
    const r = await queryEmpresa(
      `${baseCompras} WHERE ${whEmp.join(' AND ')} ORDER BY c.criado_em DESC LIMIT ${limit}`,
      params,
      `${baseCompras} ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''} ORDER BY c.criado_em DESC LIMIT ${limit}`,
      params.slice(0, -1)
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
  const chkC = await queryEmpresa(
    `SELECT 1 FROM armazem_compras c JOIN produtos p ON p.id=c.produto_id WHERE c.id=$1 AND p.empresa_id=$2`,
    [id, empresaDe(req)],
    `SELECT 1 FROM armazem_compras WHERE id=$1`, [id]
  );
  if (!chkC.rows.length) return res.status(404).json({ erro: 'Linha de compra não encontrada' });
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
  const chkC = await queryEmpresa(
    `SELECT 1 FROM armazem_compras c JOIN produtos p ON p.id=c.produto_id WHERE c.id=$1 AND p.empresa_id=$2`,
    [id, empresaDe(req)],
    `SELECT 1 FROM armazem_compras WHERE id=$1`, [id]
  );
  if (!chkC.rows.length) return res.status(404).json({ erro: 'Linha de compra não encontrada' });
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
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit || '40', 10)));
    const dataDia = (req.query.data || '').trim();
    const dataIni = (req.query.data_inicio || '').trim();
    const dataFim = (req.query.data_fim || '').trim();
    const categoria = (req.query.categoria || '').trim();
    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const wh = [];
    const params = [];
    let i = 0;
    if (isYmd(dataDia)) {
      params.push(dataDia); i++;
      wh.push(`data_emissao = $${i}::date`);
    }
    if (isYmd(dataIni)) {
      params.push(dataIni); i++;
      wh.push(`data_emissao >= $${i}::date`);
    }
    if (isYmd(dataFim)) {
      params.push(dataFim); i++;
      wh.push(`data_emissao <= $${i}::date`);
    }
    if (categoria && ['menu','ingredientes','bebida'].includes(categoria)) {
      params.push(categoria); i++;
      wh.push(`id IN (SELECT DISTINCT c.fatura_id FROM armazem_compras c JOIN produtos p ON p.id=c.produto_id WHERE p.categoria = $${i})`);
    }
    const paramsSem = params.slice();
    params.push(lojaDe(req)); i++;
    const whLojaF = wh.concat([`loja_id = $${i}`]);
    const whEmpF = wh.concat([`empresa_id = $${i}`]);
    const paramsEmp = [...paramsSem, empresaDe(req)];
    const ordF = ` ORDER BY data_emissao DESC, criado_em DESC LIMIT ${limit}`;
    const r = await queryEmpresa(
      `SELECT * FROM armazem_faturas WHERE ${whLojaF.join(' AND ')}${ordF}`, params,
      `SELECT * FROM armazem_faturas WHERE ${whEmpF.join(' AND ')}${ordF}`, paramsEmp
    ).catch(() => query(
      `SELECT * FROM armazem_faturas ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}${ordF}`, paramsSem
    ));
    let rows = r.rows;
    // Nº de fotos adicionais por fatura (multi-foto) — melhor esforço.
    try {
      if (rows.length) {
        await ensureFotosAnexos();
        const chaves = rows.map((x) => 'fatura:' + x.id);
        const c = await query(
          `SELECT chave, COUNT(*)::int AS n FROM fotos_anexos WHERE chave = ANY($1) GROUP BY chave`,
          [chaves]
        );
        const porChave = {};
        c.rows.forEach((x) => { porChave[x.chave] = x.n; });
        rows = rows.map((x) => ({ ...x, fotos_extra: porChave['fatura:' + x.id] || 0 }));
      }
    } catch (_) {}
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/armazem/faturas/:id', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const f = await queryEmpresa(
      'SELECT * FROM armazem_faturas WHERE id=$1 AND empresa_id=$2', [req.params.id, empresaDe(req)],
      'SELECT * FROM armazem_faturas WHERE id=$1', [req.params.id]
    );
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

/**
 * OCR de fatura — recebe foto base64 (image/jpeg|png|webp), chama o provider escolhido
 * (req.body.provider = 'claude' | 'mindee', default 'claude') e devolve JSON estruturado:
 *  { fornecedor: {nome, nif, telefone, email, morada, match: {id, nome} | null},
 *    numero_fatura, data_emissao, total_estimado,
 *    linhas: [{ descricao, quantidade, unidade_medida, preco_unit, tipo_medicao_detectado,
 *               match: {id, nome, tipo_medicao} | null, aviso? }],
 *    provider }
 */
async function callClaudeOcr(parsed) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('claude key missing'); e.code = 'KEY_MISSING'; throw e; }
  const promptText = `Estás a analisar uma FATURA / FATURA-RECIBO ANGOLANA (em português, valores em Kwanzas/AOA). Devolve APENAS um objecto JSON válido — sem qualquer texto fora do JSON, sem markdown — com este schema:
{
  "fornecedor": {"nome": string, "nif": string, "telefone": string, "email": string, "morada": string},
  "numero_fatura": string,
  "data_emissao": "YYYY-MM-DD",
  "total_estimado": number,
  "linhas": [
    {
      "descricao": string,
      "quantidade": number,
      "unidade_medida": "kg" | "g" | "L" | "ml" | "un" | "caixa" | "garrafa" | "lata" | "pack",
      "preco_unit": number,
      "total": number
    }
  ]
}

Regras específicas de Angola:
- "Nr. Contribuinte" / "NIF" / "Contribuinte" que aparece junto ao NOME DO FORNECEDOR (ex.: TotalEnergies, Refriango) é o NIF do fornecedor — usa-o em fornecedor.nif.
- Se a fatura mostrar um segundo "Contribuinte: 999999990" (ou similar) associado a "Nome: Consumidor Final" / "Cliente", isso é o COMPRADOR — IGNORA, não confundir com o fornecedor.
- Layouts comuns de linha: "Qnt | Produto | Unit | Subt | Tx" → Qnt=quantidade, Unit=preço unitário, Subt=subtotal da linha, Tx=taxa de IVA (%, não usar). Outras variações: "Qtde", "Quant", "PVU", "PVP", "Valor".
- Números de fatura típicos: "FR-FR x/yyyyy", "FT 1/2026", "FT-AB 2026/123" — mantém formato original.
- "data_emissao" no formato ISO (YYYY-MM-DD). Hora deve ser ignorada.
- Sem separadores de milhar nos números devolvidos. Usa ponto decimal: 1234.56.

Regras de unidade:
- Se a descrição inclui "1L", "500g", "5 kg" → extrai a unidade correspondente e a quantidade reflecte UNIDADES VENDIDAS (ex.: 2 garrafas de 1L = quantidade 2, unidade_medida "garrafa" ou "L" se for a granel).
- Se a descrição não tem unidade explícita (ex.: "CERVEJA CUCA", "AGUA MINERAL", "ARROZ AGULHA") → unidade_medida = "un".
- Se vir "kg/g/L/ml" explicitamente como unidade da coluna Qnt → usa essa.

Regras gerais:
- Se um campo não existe na fatura, devolve string vazia "" (ou 0 para números, [] para linhas).
- "preco_unit" é o valor da coluna Unit/PVU/preço unitário tal como aparece na fatura.
- NÃO inventes informação. Se uma linha for ilegível, devolve descricao com os campos numéricos a 0.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': apiKey },
    body: JSON.stringify({
      model: process.env.OCR_MODEL || 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: parsed.contentType, data: parsed.buffer.toString('base64') } },
          { type: 'text', text: promptText }
        ]
      }]
    })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('[ocr-claude] request failed:', r.status, t.slice(0, 500));
    const e = new Error('claude request failed'); e.code = 'PROVIDER_FAILED'; throw e;
  }
  const data = await r.json();
  const rawText = (data && Array.isArray(data.content) && data.content[0] && data.content[0].text) || '';
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : rawText);
  } catch (_) {
    console.error('[ocr-claude] non-JSON:', rawText.slice(0, 500));
    const e = new Error('claude non-json'); e.code = 'PROVIDER_PARSE'; throw e;
  }
}

async function callMindeeOcr(parsed) {
  const apiKey = (process.env.MINDEE_API_KEY || '').trim();
  if (!apiKey) { const e = new Error('mindee key missing'); e.code = 'KEY_MISSING'; throw e; }
  const modelId = (process.env.MINDEE_MODEL_ID || '').trim();
  const useV2 = !!modelId;
  const v2Base = (process.env.MINDEE_V2_BASE || 'https://api-v2.mindee.net/v2').trim();
  console.log('[ocr-mindee] config: useV2=', useV2, 'modelIdLen=', modelId.length, 'keyLen=', apiKey.length, 'keyPrefix=', apiKey.slice(0, 3));

  if (useV2) return callMindeeV2(parsed, apiKey, modelId, v2Base);
  return callMindeeV1(parsed, apiKey);
}

async function mindeeError(prefix, r) {
  const t = await r.text().catch(() => '');
  console.error(prefix + ':', r.status, t.slice(0, 1000));
  const e = new Error('mindee request failed'); e.code = 'PROVIDER_FAILED';
  e.providerStatus = r.status; e.providerBody = t.slice(0, 400);
  return e;
}

async function callMindeeV1(parsed, apiKey) {
  const form = new FormData();
  form.append('document', new Blob([parsed.buffer], { type: parsed.contentType }), 'fatura.' + parsed.ext);
  const endpoint = process.env.MINDEE_ENDPOINT
    || 'https://api.mindee.net/v1/products/mindee/financial_document/v1/predict';
  const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Token ${apiKey}` }, body: form });
  if (!r.ok) throw await mindeeError('[ocr-mindee-v1] request failed', r);
  const data = await r.json();
  return normalizeMindeeV1(data);
}

async function callMindeeV2(parsed, apiKey, modelId, base) {
  // 1) Enqueue.
  const form = new FormData();
  form.append('model_id', modelId);
  form.append('file', new Blob([parsed.buffer], { type: parsed.contentType }), 'fatura.' + parsed.ext);
  const enq = await fetch(`${base}/inferences/enqueue`, {
    method: 'POST',
    headers: { Authorization: apiKey },
    body: form,
    redirect: 'manual'
  });
  if (!enq.ok && enq.status !== 202) throw await mindeeError('[ocr-mindee-v2] enqueue failed', enq);
  const enqData = await enq.json().catch(() => ({}));
  const jobId = (enqData && enqData.job && enqData.job.id) || '';
  if (!jobId) {
    console.error('[ocr-mindee-v2] enqueue missing job id, body=', JSON.stringify(enqData).slice(0, 500));
    const e = new Error('mindee v2 missing job id'); e.code = 'PROVIDER_FAILED'; e.providerStatus = 502;
    e.providerBody = JSON.stringify(enqData).slice(0, 400); throw e;
  }
  // 2) Polling. Job status: "Processing" → "Success" / "Failed".
  const pollUrl = (enqData.job.polling_url) || `${base}/jobs/${jobId}`;
  let inference = null;
  const start = Date.now();
  while (Date.now() - start < 28000) {
    await new Promise((rr) => setTimeout(rr, 1500));
    const pr = await fetch(pollUrl, { headers: { Authorization: apiKey }, redirect: 'follow' });
    if (!pr.ok) throw await mindeeError('[ocr-mindee-v2] poll failed', pr);
    const pdata = await pr.json().catch(() => ({}));
    if (pdata && pdata.inference) { inference = pdata.inference; break; }
    const st = String((pdata && pdata.job && pdata.job.status) || pdata.status || '').toLowerCase();
    if (st === 'failed' || st === 'error') {
      console.error('[ocr-mindee-v2] inference failed, body=', JSON.stringify(pdata).slice(0, 500));
      const e = new Error('mindee inference failed'); e.code = 'PROVIDER_FAILED'; e.providerStatus = 502;
      e.providerBody = JSON.stringify(pdata).slice(0, 400); throw e;
    }
    if (st === 'success' || st === 'done' || st === 'completed') {
      const ir = await fetch(`${base}/inferences/${jobId}`, { headers: { Authorization: apiKey } });
      if (!ir.ok) throw await mindeeError('[ocr-mindee-v2] inference fetch failed', ir);
      const idata = await ir.json().catch(() => ({}));
      inference = idata.inference || idata;
      break;
    }
  }
  if (!inference) {
    const e = new Error('mindee v2 timeout'); e.code = 'PROVIDER_FAILED'; e.providerStatus = 504;
    e.providerBody = 'Tempo de espera excedido'; throw e;
  }
  return normalizeMindeeV2(inference);
}

function v2Val(field) {
  if (field == null) return '';
  if (typeof field === 'string' || typeof field === 'number') return field;
  if (field.value != null) {
    if (typeof field.value === 'object' && field.value.value != null) return field.value.value;
    return field.value;
  }
  return '';
}

function normalizeMindeeV2(inference) {
  const fields = (inference && inference.result && inference.result.fields) || {};
  // supplier_company_registrations: list of {fields: {value: {value: '...'}, type: {...}}}
  const regsObj = fields.supplier_company_registrations;
  const regsItems = (regsObj && Array.isArray(regsObj.items)) ? regsObj.items : (Array.isArray(regsObj) ? regsObj : []);
  const nif = regsItems
    .map(it => {
      const inner = (it && it.fields) ? it.fields : it;
      return v2Val(inner && (inner.value || inner.registration_number || inner));
    })
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .join('; ');

  const fornecedor = {
    nome: String(v2Val(fields.supplier_name) || '').trim(),
    nif,
    telefone: String(v2Val(fields.supplier_phone_number) || '').trim(),
    email: String(v2Val(fields.supplier_email) || '').trim(),
    morada: String(v2Val(fields.supplier_address) || '').trim()
  };

  const liObj = fields.line_items;
  const liItems = (liObj && Array.isArray(liObj.items)) ? liObj.items : (Array.isArray(liObj) ? liObj : []);
  const linhas = liItems.map((it) => {
    const f = (it && it.fields) ? it.fields : it;
    return {
      descricao: String(v2Val(f && f.description) || '').trim(),
      quantidade: parseFloat(v2Val(f && f.quantity)) || 0,
      unidade_medida: '',
      preco_unit: parseFloat(v2Val(f && f.unit_price)) || 0,
      total: parseFloat(v2Val(f && f.total_amount)) || 0
    };
  });

  return {
    fornecedor,
    numero_fatura: String(v2Val(fields.invoice_number) || '').trim(),
    data_emissao: String(v2Val(fields.date) || v2Val(fields.invoice_date) || '').trim(),
    total_estimado: parseFloat(v2Val(fields.total_amount)) || 0,
    linhas
  };
}

function normalizeMindeeV1(data) {
  const pred = (data && data.document && data.document.inference && data.document.inference.prediction) || {};
  const sup = pred.supplier_address || {};
  const regs = Array.isArray(pred.supplier_company_registrations) ? pred.supplier_company_registrations : [];
  const nif = regs.map(x => String((x && x.value) || '').trim()).filter(Boolean).join('; ');
  const fornecedor = {
    nome: (pred.supplier_name && pred.supplier_name.value) || '',
    nif,
    telefone: (pred.supplier_phone_number && pred.supplier_phone_number.value) || '',
    email: (pred.supplier_email && pred.supplier_email.value) || '',
    morada: (typeof sup === 'string' ? sup : (sup && sup.value)) || ''
  };
  const items = Array.isArray(pred.line_items) ? pred.line_items : [];
  const linhas = items.map(li => ({
    descricao: String((li && li.description) || '').trim(),
    quantidade: parseFloat(li && li.quantity) || 0,
    unidade_medida: '',
    preco_unit: parseFloat(li && li.unit_price) || 0,
    total: parseFloat(li && li.total_amount) || 0
  }));
  return {
    fornecedor,
    numero_fatura: (pred.invoice_number && pred.invoice_number.value) || '',
    data_emissao: (pred.date && pred.date.value) || '',
    total_estimado: parseFloat(pred.total_amount && pred.total_amount.value) || 0,
    linhas
  };
}

/** Normaliza variantes de unidade (singular/plural/abrev) para forma canónica. */
function canonUnidade(u) {
  const s = String(u || '').toLowerCase().trim().replace(/\./g, '');
  if (!s) return '';
  if (/^(kg|quilos?|kilos?)$/.test(s)) return 'kg';
  if (/^g(ramas?)?$/.test(s)) return 'g';
  if (/^(l|litros?)$/.test(s)) return 'l';
  if (/^ml$/.test(s)) return 'ml';
  if (/^(un|und|unds|unidades?|pcs|pe[cç]as?)$/.test(s)) return 'un';
  if (/^(caixas?|cx|cxs)$/.test(s)) return 'caixa';
  if (/^garrafas?$/.test(s)) return 'garrafa';
  if (/^latas?$/.test(s)) return 'lata';
  if (/^packs?$/.test(s)) return 'pack';
  if (/^sacos?$/.test(s)) return 'saco';
  if (/^fardos?$/.test(s)) return 'fardo';
  return s;
}

/** Tenta inferir unidade da descrição (ex.: "Arroz 5 kg" → kg). */
function inferirUnidadeMedida(descricao) {
  const d = String(descricao || '').toLowerCase();
  if (/\b(kg|quilos?|kilos?)\b/.test(d)) return 'kg';
  if (/\b(g|gramas?)\b/.test(d)) return 'g';
  if (/\b(l|litros?)\b/.test(d)) return 'l';
  if (/\bml\b/.test(d)) return 'ml';
  if (/\b(un|und|unidades?|pcs|pe[cç]as?)\b/.test(d)) return 'un';
  if (/\b(caixas?|cx|cxs)\b/.test(d)) return 'caixa';
  if (/\bgarrafas?\b/.test(d)) return 'garrafa';
  if (/\blatas?\b/.test(d)) return 'lata';
  if (/\bpacks?\b/.test(d)) return 'pack';
  if (/\bsacos?\b/.test(d)) return 'saco';
  if (/\bfardos?\b/.test(d)) return 'fardo';
  return '';
}

app.post('/api/armazem/ocr-fatura', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    const parsed = parseDataUrlFoto(req.body && req.body.foto_base64);
    if (!parsed) return res.status(400).json({ erro: 'Foto inválida (JPEG/PNG/WebP até 5 MB)' });
    await ensureFornecedores();
    const provider = String((req.body && req.body.provider) || 'claude').toLowerCase() === 'mindee' ? 'mindee' : 'claude';

    let extr;
    try {
      extr = provider === 'mindee' ? await callMindeeOcr(parsed) : await callClaudeOcr(parsed);
    } catch (e) {
      if (e.code === 'KEY_MISSING') {
        return res.status(503).json({ erro: 'Serviço de importação de fatura indisponível. Contacta o administrador.' });
      }
      if (e.code === 'PROVIDER_PARSE') {
        return res.status(502).json({ erro: 'Não foi possível interpretar a fatura. Tenta outra foto mais nítida.' });
      }
      const debug = e.providerStatus ? ` (código ${e.providerStatus}${e.providerBody ? ': ' + String(e.providerBody).replace(/\s+/g, ' ').slice(0, 200) : ''})` : '';
      return res.status(502).json({ erro: 'Não foi possível processar a fatura. Tenta outra foto.' + debug });
    }

    // Normalizar unidade → tipo_medicao + converter g/ml para kg/L
    const normaliza = (linha) => {
      let um = canonUnidade(linha.unidade_medida);
      if (!um) um = inferirUnidadeMedida(linha.descricao);
      let qty = parseFloat(linha.quantidade) || 0;
      let pu  = parseFloat(linha.preco_unit) || 0;
      let tipo = 'unidade';
      let aviso = '';
      if (um === 'kg' || um === 'l') tipo = 'peso';
      else if (um === 'g') { tipo = 'peso'; if (qty > 0) { pu = pu * 1000; qty = qty / 1000; } }
      else if (um === 'ml') { tipo = 'peso'; if (qty > 0) { pu = pu * 1000; qty = qty / 1000; } }
      else if (['un','caixa','garrafa','lata','pack','saco','fardo'].includes(um)) tipo = 'unidade';
      else aviso = 'unidade incerta';
      return { ...linha, unidade_medida: um, quantidade: qty, preco_unit: pu, tipo_medicao_detectado: tipo, ...(aviso ? { aviso } : {}) };
    };
    const linhasNorm = Array.isArray(extr.linhas) ? extr.linhas.map(normaliza) : [];

    // Matching fornecedor (NIF exacto → senão ILIKE nome)
    const fornBody = extr.fornecedor || {};
    let fornMatch = null;
    const nifIn = String(fornBody.nif || '').trim();
    const nomeIn = String(fornBody.nome || '').trim();
    if (nifIn) {
      const fr = await query(`SELECT id, nome FROM fornecedores WHERE nif = $1 LIMIT 1`, [nifIn]);
      if (fr.rows.length) fornMatch = fr.rows[0];
    }
    if (!fornMatch && nomeIn) {
      const fr = await query(
        `SELECT id, nome FROM fornecedores
         WHERE LOWER(nome) = LOWER($1) OR LOWER(nome) LIKE LOWER($2)
         ORDER BY (LOWER(nome) = LOWER($1)) DESC, length(nome) ASC LIMIT 1`,
        [nomeIn, '%' + nomeIn + '%']
      );
      if (fr.rows.length) fornMatch = fr.rows[0];
    }

    // Matching produto por linha (nome ILIKE)
    const linhasOut = [];
    for (const l of linhasNorm) {
      const desc = String(l.descricao || '').trim();
      let prodMatch = null;
      if (desc) {
        const pr = await query(
          `SELECT id, nome, tipo_medicao FROM produtos
           WHERE LOWER(nome) = LOWER($1)
              OR LOWER(nome) LIKE LOWER($2)
              OR LOWER($1) LIKE '%' || LOWER(nome) || '%'
           ORDER BY (LOWER(nome) = LOWER($1)) DESC, length(nome) ASC LIMIT 1`,
          [desc, '%' + desc + '%']
        );
        if (pr.rows.length) prodMatch = pr.rows[0];
      }
      let aviso = l.aviso;
      if (prodMatch && prodMatch.tipo_medicao && l.tipo_medicao_detectado && prodMatch.tipo_medicao !== l.tipo_medicao_detectado) {
        aviso = (aviso ? aviso + '; ' : '') + 'unidade diferente do produto existente';
      }
      linhasOut.push({ ...l, match: prodMatch, ...(aviso ? { aviso } : {}) });
    }

    res.json({
      provider,
      fornecedor: { ...fornBody, match: fornMatch },
      numero_fatura: String(extr.numero_fatura || ''),
      data_emissao: String(extr.data_emissao || ''),
      total_estimado: parseFloat(extr.total_estimado) || 0,
      linhas: linhasOut
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
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
      fornecedor_id: fornecedorIdBody,
      novo_fornecedor,
      proforma_id
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
    if (!fornecedorId && novo_fornecedor && String(novo_fornecedor.nome || '').trim()) {
      await ensureFornecedores();
      const nfNome = String(novo_fornecedor.nome).trim();
      const dup = await client.query(
        `SELECT id, nome FROM fornecedores
         WHERE LOWER(nome) = LOWER($1)
            OR (NULLIF($2,'') IS NOT NULL AND nif = $2)
         LIMIT 1`,
        [nfNome, String(novo_fornecedor.nif || '').trim()]
      );
      if (dup.rows.length) {
        fornecedorId = dup.rows[0].id;
        fornecedorNome = dup.rows[0].nome;
      } else {
        const ins = await client.query(
          `INSERT INTO fornecedores (nome, telefone, email, morada, nif, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nome`,
          [
            nfNome,
            String(novo_fornecedor.telefone || '').trim(),
            String(novo_fornecedor.email || '').trim(),
            String(novo_fornecedor.morada || '').trim(),
            String(novo_fornecedor.nif || '').trim(),
            String(req.user.id || '')
          ]
        );
        fornecedorId = ins.rows[0].id;
        fornecedorNome = ins.rows[0].nome;
      }
    }
    const empFat = empresaDe(req);
    const lojaFat = lojaDe(req);
    const temEmpLib = await colunaEmpresaDisponivel('armazem_libertacoes');
    const temEmpFatCol = await colunaEmpresaDisponivel('armazem_faturas');
    const temLojaLib = await colunaDisponivel('armazem_libertacoes', 'loja_id');
    const temLojaFat = await colunaDisponivel('armazem_faturas', 'loja_id');
    const libRow = temLojaLib
      ? await client.query(`SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1 AND loja_id=$2`, [dataFat, lojaFat])
      : temEmpLib
        ? await client.query(`SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1 AND empresa_id=$2`, [dataFat, empFat])
        : await client.query(`SELECT COALESCE(SUM(valor),0) as t FROM armazem_libertacoes WHERE data=$1`, [dataFat]);
    const fatRow = temLojaFat
      ? await client.query(`SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1 AND loja_id=$2`, [dataFat, lojaFat])
      : temEmpFatCol
        ? await client.query(`SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1 AND empresa_id=$2`, [dataFat, empFat])
        : await client.query(`SELECT COALESCE(SUM(total_valor),0) as t FROM armazem_faturas WHERE data_emissao=$1`, [dataFat]);
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

    const pFat = [
      (numero_fatura || '').trim(),
      fornecedorNome,
      dataFat,
      (notas || '').trim(),
      String(req.user.id || ''),
      just,
      tsid,
      fornecedorId
    ];
    const ins = temLojaFat && temEmpFatCol
      ? await client.query(
          `INSERT INTO armazem_faturas (numero_fatura, fornecedor, data_emissao, notas, criado_por, justificacao_excesso, turno_saida_id, fornecedor_id, empresa_id, loja_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [...pFat, empFat, lojaFat]
        )
      : temEmpFatCol
      ? await client.query(
          `INSERT INTO armazem_faturas (numero_fatura, fornecedor, data_emissao, notas, criado_por, justificacao_excesso, turno_saida_id, fornecedor_id, empresa_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [...pFat, empFat]
        )
      : await client.query(
          `INSERT INTO armazem_faturas (numero_fatura, fornecedor, data_emissao, notas, criado_por, justificacao_excesso, turno_saida_id, fornecedor_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          pFat
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
    // Fatura criada a partir de uma proforma → marca-a como comprada.
    if (proforma_id != null && String(proforma_id).trim() !== '') {
      const pfid = parseInt(proforma_id, 10);
      if (!Number.isNaN(pfid)) {
        await ensureArmazemProformas();
        await client.query(
          `UPDATE armazem_proformas SET estado='comprada', fatura_id=$1 WHERE id=$2 AND estado <> 'comprada'`,
          [fid, pfid]
        ).catch(() => {});
      }
    }
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
  // Fotos adicionais da fatura (multi-foto) — fora da transacção; falhar
  // aqui não perde a fatura.
  try {
    const extras = Array.isArray(req.body?.fotos_extra_base64) ? req.body.fotos_extra_base64 : [];
    if (extras.length) {
      await ensureFotosAnexos();
      for (const f of extras.slice(0, 12)) {
        if (typeof f === 'string' && f.startsWith('data:image')) {
          await query(
            `INSERT INTO fotos_anexos (chave, foto, criado_por) VALUES ($1,$2,$3)`,
            ['fatura:' + fid, f, String(req.user.id || '')]
          ).catch(() => {});
        }
      }
    }
  } catch (_) {}
  res.json({ ...fat.rows[0], linhas: linhasOut.rows });
});

// ── FOTOS ANEXAS (multi-foto por contexto) ────────────────────
// Vários recibos/páginas por registo: chave identifica o contexto —
// 'tpa:<turno_id>', 'bordero:<data>', 'fatura:<id>'. A primeira foto de
// cada contexto continua também no campo antigo (validações e miniaturas
// existentes não mudam); estas são as adicionais.
let fotosAnexosReady = false;
async function ensureFotosAnexos() {
  if (fotosAnexosReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='fotos_anexos_v1'`);
    if (r.rows.length) { fotosAnexosReady = true; return; }
  } catch (_) {}
  await qry(
    `CREATE TABLE IF NOT EXISTS fotos_anexos (
      id SERIAL PRIMARY KEY,
      chave TEXT NOT NULL,
      foto TEXT NOT NULL,
      criado_por TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    [],
    'fotos-anexos'
  );
  await qry(`CREATE INDEX IF NOT EXISTS idx_fotos_anexos_chave ON fotos_anexos (chave)`, [], 'idx-fotos-anexos');
  try {
    const chk = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='fotos_anexos'`
    );
    if (chk.rows.length) {
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('fotos_anexos_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
      fotosAnexosReady = true;
    }
  } catch (_) {}
}

function fotosAnexosChaveValida(chave) {
  return /^(tpa:\d+|bordero:\d{4}-\d{2}-\d{2}|fatura:\d+)$/.test(String(chave || ''));
}

app.get('/api/fotos', auth, async (req, res) => {
  try {
    const chave = String(req.query.chave || '').trim();
    if (!fotosAnexosChaveValida(chave)) return res.status(400).json({ erro: 'Chave inválida' });
    const mTpaF = chave.match(/^tpa:(\d+)$/);
    if (mTpaF && !(await turnoNoContexto(req, parseInt(mTpaF[1], 10)).catch(() => true))) {
      return res.status(404).json({ erro: 'Turno não encontrado' });
    }
    await ensureFotosAnexos();
    const r = await query(
      `SELECT id, chave, foto, criado_por, criado_em FROM fotos_anexos WHERE chave=$1 ORDER BY criado_em, id`,
      [chave]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/fotos', auth, async (req, res) => {
  try {
    const { chave, foto_base64 } = req.body || {};
    if (!fotosAnexosChaveValida(chave)) return res.status(400).json({ erro: 'Chave inválida' });
    if (typeof foto_base64 !== 'string' || !foto_base64.startsWith('data:image')) {
      return res.status(400).json({ erro: 'Envia a foto (data URL de imagem)' });
    }
    const mTpaP = String(chave).match(/^tpa:(\d+)$/);
    if (mTpaP && !(await turnoNoContexto(req, parseInt(mTpaP[1], 10)).catch(() => true))) {
      return res.status(404).json({ erro: 'Turno não encontrado' });
    }
    await ensureFotosAnexos();
    const r = await query(
      `INSERT INTO fotos_anexos (chave, foto, criado_por) VALUES ($1,$2,$3) RETURNING id, criado_em`,
      [chave, foto_base64, String(req.user.id || '')]
    );
    // Rede de segurança: se o campo antigo do contexto está vazio, esta
    // foto passa a ser também a principal (validações continuam a bater).
    try {
      const mTpa = chave.match(/^tpa:(\d+)$/);
      if (mTpa) {
        await query(
          `UPDATE turno_caixa SET tpa_foto_url=$1 WHERE turno_id=$2 AND COALESCE(tpa_foto_url,'')=''`,
          [foto_base64, parseInt(mTpa[1], 10)]
        ).catch(() => {});
      }
      const mBor = chave.match(/^bordero:(\d{4}-\d{2}-\d{2})$/);
      if (mBor) {
        await query(
          `UPDATE depositos_banco SET bordero_foto_url=$1
           WHERE COALESCE(bordero_foto_url,'')='' AND turno_id IN (SELECT id FROM turnos WHERE data=$2)`,
          [foto_base64, mBor[1]]
        ).catch(() => {});
      }
      const mFat = chave.match(/^fatura:(\d+)$/);
      if (mFat) {
        await query(
          `UPDATE armazem_faturas SET foto_fatura_url=$1 WHERE id=$2 AND COALESCE(foto_fatura_url,'')=''`,
          [foto_base64, parseInt(mFat[1], 10)]
        ).catch(() => {});
      }
    } catch (_) {}
    res.json({ ok: true, id: r.rows[0].id, criado_em: r.rows[0].criado_em });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/fotos/:id', auth, async (req, res) => {
  try {
    await ensureFotosAnexos();
    await query(`DELETE FROM fotos_anexos WHERE id=$1`, [parseInt(req.params.id, 10) || 0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── LOJAS (pontos de venda da empresa) ────────────────────────
const LOJA_PERFIL_CAMPOS = ['morada', 'telefone', 'email', 'nif', 'responsavel', 'notas'];

app.get('/api/lojas', auth, async (req, res) => {
  try {
    await ensureEmpresasLojas();
    const empresaId = empresaDe(req);
    const todos = req.query.todos === '1';
    const r = await query(
      `SELECT * FROM lojas WHERE empresa_id=$1 ${todos ? '' : 'AND ativo IS TRUE'} ORDER BY id`,
      [empresaId]
    );
    res.json(r.rows.length ? r.rows : [{ id: 1, nome: 'Loja 1', ativo: true }]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/lojas', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureEmpresasLojas();
    const empresaId = empresaDe(req);
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Indica o nome da loja / ponto de venda' });
    const perfil = LOJA_PERFIL_CAMPOS.map((c) => String(b[c] || '').trim());
    const r = await query(
      `INSERT INTO lojas (empresa_id, nome, ${LOJA_PERFIL_CAMPOS.join(', ')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [empresaId, nome, ...perfil]
    );
    __lojaEmpresaCache.at = 0; // nova loja → refresca o mapa loja→empresa
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/lojas/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureEmpresasLojas();
    const empresaId = empresaDe(req);
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (typeof b.nome === 'string' && b.nome.trim()) {
      params.push(b.nome.trim());
      sets.push(`nome=$${params.length}`);
    }
    for (const c of LOJA_PERFIL_CAMPOS) {
      if (b[c] !== undefined) {
        params.push(String(b[c] || '').trim());
        sets.push(`${c}=$${params.length}`);
      }
    }
    if (b.ativo !== undefined) {
      params.push(!!b.ativo);
      sets.push(`ativo=$${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ erro: 'Nada para alterar' });
    params.push(parseInt(req.params.id, 10) || 0);
    params.push(empresaId);
    const r = await query(
      `UPDATE lojas SET ${sets.join(', ')} WHERE id=$${params.length - 1} AND empresa_id=$${params.length} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Loja não encontrada' });
    __lojaEmpresaCache.at = 0;
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── EMPRESAS (só admin — pode migrar entre todas) ─────────────
const EMPRESA_PERFIL_CAMPOS = ['nif', 'morada', 'telefone', 'email', 'responsavel', 'notas'];

app.get('/api/empresas', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureEmpresasLojas();
    let r;
    try {
      r = await query(
        `SELECT e.*, (SELECT COUNT(*)::int FROM lojas l WHERE l.empresa_id = e.id AND l.ativo IS TRUE) AS lojas_n
         FROM empresas e WHERE e.ativo IS TRUE ORDER BY e.id`
      );
    } catch (_) {
      r = await query(`SELECT id, nome, ativo, criado_em FROM empresas WHERE ativo IS TRUE ORDER BY id`);
    }
    res.json(r.rows.length ? r.rows : [{ id: 1, nome: 'Empresa 1', ativo: true, lojas_n: 1 }]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/empresas', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureEmpresasLojas();
    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Indica o nome da empresa' });
    const perfil = EMPRESA_PERFIL_CAMPOS.map((c) => String(b[c] || '').trim());
    let r;
    try {
      r = await query(
        `INSERT INTO empresas (nome, ${EMPRESA_PERFIL_CAMPOS.join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [nome, ...perfil]
      );
    } catch (_) {
      r = await query(`INSERT INTO empresas (nome) VALUES ($1) RETURNING *`, [nome]);
    }
    const empresa = r.rows[0];
    // Cada empresa nasce com a primeira loja — sem loja não há turnos.
    const lojaNome = String(b.loja_nome || '').trim() || 'Loja 1';
    let loja = null;
    try {
      const lr = await query(`INSERT INTO lojas (empresa_id, nome) VALUES ($1,$2) RETURNING id, nome`, [empresa.id, lojaNome]);
      loja = lr.rows[0];
      __lojaEmpresaCache.at = 0;
    } catch (_) {}
    res.json({ ...empresa, loja });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/empresas/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureEmpresasLojas();
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (typeof b.nome === 'string' && b.nome.trim()) {
      params.push(b.nome.trim());
      sets.push(`nome=$${params.length}`);
    }
    for (const c of EMPRESA_PERFIL_CAMPOS) {
      if (b[c] !== undefined) {
        params.push(String(b[c] || '').trim());
        sets.push(`${c}=$${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ erro: 'Nada para alterar' });
    params.push(parseInt(req.params.id, 10) || 0);
    const r = await query(`UPDATE empresas SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ erro: 'Empresa não encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
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

    // Multi-loja: cada ponto de venda vê apenas os seus turnos. BD antiga
    // (sem turnos.loja_id) → fallback sem filtro (comporta-se como antes).
    await ensureEmpresasLojas().catch(() => {});
    const lojaId = lojaDe(req);
    let temLojaCol = true;
    let turnos;
    try {
      turnos = await query(
        turnoOnlyFilter
          ? `SELECT t.*, u.nome as utilizador_nome FROM turnos t
             LEFT JOIN utilizadores u ON t.utilizador_id=u.id
             WHERE t.data=$1 AND t.id=$2 AND t.loja_id=$3`
          : `SELECT t.*, u.nome as utilizador_nome FROM turnos t
             LEFT JOIN utilizadores u ON t.utilizador_id=u.id
             WHERE t.data=$1 AND t.loja_id=$2
             ORDER BY CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`,
        turnoOnlyFilter ? [data, turnoOnlyFilter, lojaId] : [data, lojaId]
      );
    } catch (e) {
      if (!/loja_id/.test(String(e.message || ''))) throw e;
      temLojaCol = false;
      turnos = await query(
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
    }

    if (!turnos.rows.length) {
      return res.json([]);
    }

    const ids = turnos.rows.map((t) => t.id);

    /** Vista lista (página Dia, depósitos): sem linhas de stock nem comparação com turno anterior — muito mais rápido. */
    if (resumo) {
      const [caixaAll, vendasAgg, pedidosAgg, entradasMarcadas, entradasTabela] = await Promise.all([
        query(`SELECT * FROM turno_caixa WHERE turno_id = ANY($1::int[])`, [ids]),
        queryEmpresa(
          `SELECT ts.turno_id,
             COALESCE(SUM(${sqlTsValorVendaLinha()}), 0)::numeric AS total_vendas
           FROM turno_stock ts
           INNER JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
           INNER JOIN turnos t ON t.id = ts.turno_id
           WHERE ts.turno_id = ANY($1::int[]) AND p.empresa_id = $2
           GROUP BY ts.turno_id`,
          [ids, empresaDe(req)],
          `SELECT ts.turno_id,
             COALESCE(SUM(${sqlTsValorVendaLinha()}), 0)::numeric AS total_vendas
           FROM turno_stock ts
           INNER JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
           INNER JOIN turnos t ON t.id = ts.turno_id
           WHERE ts.turno_id = ANY($1::int[])
           GROUP BY ts.turno_id`,
          [ids]
        ),
        // Total geral dos «Produtos vendidos» (pedidos ao balcão) por turno —
        // mesma valorização do GET /turnos/:id/pedidos: preço actual do
        // produto, com preço de pacote para bebidas por copo. Se as tabelas
        // de pedidos ainda não existirem, devolve vazio (cartão mostra 0).
        query(
          `SELECT tp.turno_id,
             COALESCE(SUM(
               CASE
                 WHEN p.venda_por_copo IS TRUE AND COALESCE(p.kg_por_copo,0) > 0 THEN
                   CASE
                     WHEN COALESCE(p.qtd_copos_pacote,0) >= 2 AND COALESCE(p.preco_copos_pacote,0) > 0 THEN
                       FLOOR(FLOOR(tpl.quantidade)::int / p.qtd_copos_pacote) * p.preco_copos_pacote
                       + (FLOOR(tpl.quantidade)::int % p.qtd_copos_pacote) * COALESCE(p.preco,0)
                     ELSE FLOOR(tpl.quantidade) * COALESCE(p.preco,0)
                   END
                 ELSE tpl.quantidade * COALESCE(p.preco,0)
               END
             ), 0)::numeric AS total_kz,
             COALESCE(SUM(tpl.quantidade), 0)::numeric AS total_itens
           FROM turno_pedidos tp
           JOIN turno_pedido_linhas tpl ON tpl.pedido_id = tp.id
           JOIN produtos p ON p.id = tpl.produto_id
           WHERE tp.turno_id = ANY($1::int[])
           GROUP BY tp.turno_id`,
          [ids]
        ).catch(() => ({ rows: [] })),
        // Dinheiro que ENTROU na caixa: registos marcados em turno_saidas
        // (ENTRADA::) + tabela dedicada, quando existe.
        query(
          `SELECT turno_id, COALESCE(SUM(valor),0)::numeric AS t
           FROM turno_saidas
           WHERE turno_id = ANY($1::int[]) AND COALESCE(notas,'') LIKE 'ENTRADA::%'
           GROUP BY turno_id`,
          [ids]
        ).catch(() => ({ rows: [] })),
        query(
          `SELECT turno_id, COALESCE(SUM(valor),0)::numeric AS t
           FROM turno_caixa_entradas
           WHERE turno_id = ANY($1::int[])
           GROUP BY turno_id`,
          [ids]
        ).catch(() => ({ rows: [] }))
      ]);
      const caixaByTurno = {};
      for (const row of caixaAll.rows) {
        caixaByTurno[row.turno_id] = row;
      }
      const vendasByTurno = {};
      for (const row of vendasAgg.rows) {
        vendasByTurno[row.turno_id] = parseFloat(row.total_vendas) || 0;
      }
      const pedidosByTurno = {};
      for (const row of pedidosAgg.rows) {
        pedidosByTurno[row.turno_id] = {
          total_kz: parseFloat(row.total_kz) || 0,
          total_itens: parseFloat(row.total_itens) || 0
        };
      }
      const entradasByTurno = {};
      for (const row of [...entradasMarcadas.rows, ...entradasTabela.rows]) {
        entradasByTurno[row.turno_id] = (entradasByTurno[row.turno_id] || 0) + (parseFloat(row.t) || 0);
      }
      const result = [];
      for (const turno of turnos.rows) {
        const c = caixaByTurno[turno.id] || { tpa: null, transferencia: null, dinheiro: null, saida: 0 };
        const totalGerado = sumCaixaGeradoRow(c);
        const entradasTot = entradasByTurno[turno.id] || 0;
        const totalFinal =
          totalGerado === null ? null : totalGerado - parseFloat(c.saida || 0) + entradasTot;
        const ped = pedidosByTurno[turno.id] || { total_kz: 0, total_itens: 0 };
        result.push({
          ...turno,
          stock: [],
          caixa: { ...c, total_gerado: totalGerado, total_final: totalFinal, entradas_total: entradasTot },
          total_vendas: vendasByTurno[turno.id] || 0,
          pedidos_total_kz: ped.total_kz,
          pedidos_total_itens: ped.total_itens
        });
      }
      return res.json(result);
    }

    const selStockDia = `SELECT ts.*, p.nome as produto_nome,
                ${sqlPPrecoNaData()} AS preco,
                p.categoria, p.ordem, p.tipo_medicao,
                COALESCE(p.peso_tara_kg, 0)::numeric AS peso_tara_kg
         FROM turno_stock ts
         JOIN produtos p ON ts.produto_id=p.id
         JOIN turnos t ON t.id = ts.turno_id
         WHERE ts.turno_id = ANY($1::int[]) AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}`;
    const ordStockDia = ` ORDER BY ts.turno_id, p.ordem, p.nome`;
    const [stockAll, caixaAll] = await Promise.all([
      queryEmpresa(
        `${selStockDia} AND p.empresa_id = $2${ordStockDia}`, [ids, empresaDe(req)],
        `${selStockDia}${ordStockDia}`, [ids]
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

    const prevMapByTurnoId = {};
    const prevCaixaMapByTurnoId = {};
    const nextMapByTurnoId = {};
    const nextCaixaMapByTurnoId = {};
    if (ids.length) {
      // Para cada turno actual, encontra o ÚLTIMO turno anterior que foi
      // registado (tem stock com deixado) e usa o `deixado` desse turno para
      // TODOS os produtos. O T. Anterior pertence sempre ao mesmo turno — se o
      // turno imediato não foi aberto, recua até ao último turno com registos.
      const slotCase = `CASE nome WHEN 'manha' THEN 0 WHEN 'tarde' THEN 1 WHEN 'noite' THEN 2 END`;
      const slotCaseT = `CASE t.nome WHEN 'manha' THEN 0 WHEN 'tarde' THEN 1 WHEN 'noite' THEN 2 END`;
      // Comparações anterior/próximo sempre dentro da MESMA loja.
      const lojaSel = temLojaCol ? ', loja_id' : '';
      const lojaCond = temLojaCol ? 'AND t.loja_id = c.loja_id' : '';
      const prevStock = await query(
        `WITH cur AS (
           SELECT id AS turno_id, data, ${slotCase} AS slot${lojaSel}
           FROM turnos WHERE id = ANY($1::int[])
         ),
         prev AS (
           SELECT c.turno_id, p.prev_turno_id
           FROM cur c
           LEFT JOIN LATERAL (
             SELECT t.id AS prev_turno_id
             FROM turnos t
             WHERE (t.data < c.data OR (t.data = c.data AND ${slotCaseT} < c.slot))
               ${lojaCond}
               AND EXISTS (
                 SELECT 1 FROM turno_stock ts
                 JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
                 WHERE ts.turno_id = t.id AND ts.deixado IS NOT NULL
               )
             ORDER BY t.data DESC, ${slotCaseT} DESC
             LIMIT 1
           ) p ON TRUE
         )
         SELECT pr.turno_id, ts.produto_id, ts.deixado, ts.deixado_caixa
         FROM prev pr
         JOIN turno_stock ts ON ts.turno_id = pr.prev_turno_id
         JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
         WHERE ts.deixado IS NOT NULL OR ts.deixado_caixa IS NOT NULL`,
        [ids]
      );
      for (const r of prevStock.rows) {
        if (r.deixado !== null) {
          if (!prevMapByTurnoId[r.turno_id]) prevMapByTurnoId[r.turno_id] = {};
          prevMapByTurnoId[r.turno_id][r.produto_id] = parseFloat(r.deixado);
        }
        if (r.deixado_caixa !== null) {
          if (!prevCaixaMapByTurnoId[r.turno_id]) prevCaixaMapByTurnoId[r.turno_id] = {};
          prevCaixaMapByTurnoId[r.turno_id][r.produto_id] = parseFloat(r.deixado_caixa);
        }
      }
      // ── Mesma lógica, ao contrário: encontra o PRÓXIMO turno (já com
      // encontrado registado) para podermos comparar Deixado(actual) vs
      // Encontrado(próximo) — útil para detectar erros de contagem. ──
      const nextStock = await query(
        `WITH cur AS (
           SELECT id AS turno_id, data, ${slotCase} AS slot${lojaSel}
           FROM turnos WHERE id = ANY($1::int[])
         ),
         nxt AS (
           SELECT c.turno_id, p.next_turno_id
           FROM cur c
           LEFT JOIN LATERAL (
             SELECT t.id AS next_turno_id
             FROM turnos t
             WHERE (t.data > c.data OR (t.data = c.data AND ${slotCaseT} > c.slot))
               ${lojaCond}
               AND EXISTS (
                 SELECT 1 FROM turno_stock ts
                 JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
                 WHERE ts.turno_id = t.id AND ts.encontrado IS NOT NULL
               )
             ORDER BY t.data ASC, ${slotCaseT} ASC
             LIMIT 1
           ) p ON TRUE
         )
         SELECT nx.turno_id, ts.produto_id, ts.encontrado, ts.encontrado_caixa
         FROM nxt nx
         JOIN turno_stock ts ON ts.turno_id = nx.next_turno_id
         JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
         WHERE ts.encontrado IS NOT NULL OR ts.encontrado_caixa IS NOT NULL`,
        [ids]
      );
      for (const r of nextStock.rows) {
        if (r.encontrado !== null) {
          if (!nextMapByTurnoId[r.turno_id]) nextMapByTurnoId[r.turno_id] = {};
          nextMapByTurnoId[r.turno_id][r.produto_id] = parseFloat(r.encontrado);
        }
        if (r.encontrado_caixa !== null) {
          if (!nextCaixaMapByTurnoId[r.turno_id]) nextCaixaMapByTurnoId[r.turno_id] = {};
          nextCaixaMapByTurnoId[r.turno_id][r.produto_id] = parseFloat(r.encontrado_caixa);
        }
      }
    }

    const result = [];
    for (const turno of turnos.rows) {
      const stock = stockByTurno[turno.id] || [];
      const prevMap = prevMapByTurnoId[turno.id] || {};
      const prevCaixaMap = prevCaixaMapByTurnoId[turno.id] || {};
      const nextMap = nextMapByTurnoId[turno.id] || {};
      const nextCaixaMap = nextCaixaMapByTurnoId[turno.id] || {};

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

        // Mesma lógica para a coluna "a caixa": Enc. caixa vs Deix. caixa do turno anterior.
        const encCaixa =
          s.encontrado_caixa != null && s.encontrado_caixa !== '' ? parseFloat(s.encontrado_caixa) : NaN;
        let comparacaoCaixa = null;
        if (prevCaixaMap[s.produto_id] !== undefined && Number.isFinite(encCaixa)) {
          const diffC = encCaixa - prevCaixaMap[s.produto_id];
          if (Math.abs(diffC) < 0.001) comparacaoCaixa = 'igual';
          else if (diffC < 0) comparacaoCaixa = `falta ${Math.abs(diffC)}`;
          else comparacaoCaixa = `sobra ${diffC}`;
        }
        const prevDeixadoCaixa =
          prevCaixaMap[s.produto_id] !== undefined ? prevCaixaMap[s.produto_id] : null;

        const nextEncontrado = nextMap[s.produto_id] !== undefined ? nextMap[s.produto_id] : null;
        const nextEncontradoCaixa = nextCaixaMap[s.produto_id] !== undefined ? nextCaixaMap[s.produto_id] : null;
        return {
          ...s,
          vendido: vend,
          valor: val,
          comparacao,
          prev_deixado: prevDeixado,
          comparacao_caixa: comparacaoCaixa,
          prev_deixado_caixa: prevDeixadoCaixa,
          next_encontrado: nextEncontrado,
          next_encontrado_caixa: nextEncontradoCaixa
        };
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
    await ensureDepositosBanco().catch(() => {});
    const pad = (n) => String(n).padStart(2, '0');
    const dataIni = `${y}-${pad(m)}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const dataFim = `${y}-${pad(m)}-${pad(lastDay)}`;
    const sqlCal = `SELECT t.id, t.data, t.nome, t.estado,
              COALESCE(c.dinheiro, 0)      AS caixa_dinheiro,
              COALESCE(c.transferencia, 0) AS caixa_transferencia,
              COALESCE(c.tpa, 0)           AS caixa_tpa,
              COALESCE(d.valor, 0)               AS dep_dinheiro,
              COALESCE(d.valor_tpa, 0)           AS dep_tpa,
              COALESCE(d.valor_transferencia, 0) AS dep_transferencia,
              COALESCE(d.valor_saidas, 0)        AS dep_saidas,
              (d.id IS NOT NULL)                 AS tem_deposito
       FROM turnos t
       LEFT JOIN turno_caixa c     ON c.turno_id = t.id
       LEFT JOIN depositos_banco d ON d.turno_id = t.id
       WHERE t.data >= $1::date AND t.data <= $2::date {LOJA_FILTRO}
       ORDER BY t.data, CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 9 END`;
    const r = await queryEmpresa(
      sqlCal.replace('{LOJA_FILTRO}', 'AND t.loja_id = $3'), [dataIni, dataFim, lojaDe(req)],
      sqlCal.replace('{LOJA_FILTRO}', ''), [dataIni, dataFim]
    );
    const rows = r.rows.map((row) => ({
      id: row.id,
      data: normDataPostgres(row.data),
      nome: row.nome,
      estado: row.estado,
      caixa_dinheiro: parseFloat(row.caixa_dinheiro) || 0,
      caixa_transferencia: parseFloat(row.caixa_transferencia) || 0,
      caixa_tpa: parseFloat(row.caixa_tpa) || 0,
      dep_dinheiro: parseFloat(row.dep_dinheiro) || 0,
      dep_tpa: parseFloat(row.dep_tpa) || 0,
      dep_transferencia: parseFloat(row.dep_transferencia) || 0,
      dep_saidas: parseFloat(row.dep_saidas) || 0,
      tem_deposito: !!row.tem_deposito
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── Configuração POR EMPRESA ──────────────────────────────────
// Cada empresa tem a sua própria configuração, guardada em stockos_meta
// com a chave «cfg:e<empresaId>:<nome>». A Empresa 1 herda o valor da
// chave global antiga na primeira leitura (migração suave).
async function getConfigEmpresa(empresaId, chave, chaveLegada) {
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k=$1`, [`cfg:e${empresaId}:${chave}`]);
    if (r.rows.length) return r.rows[0].v;
    if (parseInt(empresaId, 10) === 1 && chaveLegada) {
      const l = await query(`SELECT v FROM stockos_meta WHERE k=$1`, [chaveLegada]);
      if (l.rows.length) return l.rows[0].v;
    }
  } catch (_) {}
  return null;
}
async function setConfigEmpresa(empresaId, chave, valor) {
  await query(
    `INSERT INTO stockos_meta (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [`cfg:e${empresaId}:${chave}`, valor]
  );
}

// ── Config: turnos bloqueados (não permitir abrir NOVOS turnos) ──
// POR EMPRESA — cada empresa bloqueia os seus períodos. Turnos já
// abertos não são afectados.
const TURNOS_NOMES_VALIDOS = ['manha', 'tarde', 'noite'];
async function getTurnosBloqueados(empresaId) {
  try {
    const v = await getConfigEmpresa(empresaId || 1, 'turnos_bloqueados', 'turnos_bloqueados');
    if (v == null) return [];
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((n) => TURNOS_NOMES_VALIDOS.includes(n)) : [];
  } catch (_) {
    return [];
  }
}

app.get('/api/config/turnos-bloqueados', auth, async (req, res) => {
  res.json({ bloqueados: await getTurnosBloqueados(empresaDe(req)) });
});

app.put('/api/config/turnos-bloqueados', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const raw = Array.isArray(req.body && req.body.bloqueados) ? req.body.bloqueados : [];
    const bloq = [...new Set(raw.map(String))].filter((n) => TURNOS_NOMES_VALIDOS.includes(n));
    await setConfigEmpresa(empresaDe(req), 'turnos_bloqueados', JSON.stringify(bloq));
    res.json({ bloqueados: bloq });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/turnos/abrir', auth, async (req, res) => {
  // Antes da transacção: a folha de stock do turno usa SÓ produtos da
  // empresa (verificação prévia da coluna — nunca aborta o BEGIN).
  const temEmpProd = await colunaEmpresaDisponivel('produtos').catch(() => false);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { data, nome } = req.body;
    if (!data || !nome) throw new Error('Data e nome obrigatórios');
    assertPodeAbrirTurno(data, nome);
    const bloqueados = await getTurnosBloqueados(empresaDe(req));
    if (bloqueados.includes(nome)) {
      throw new Error(`O turno ${nome} está bloqueado — a abertura de novos turnos foi desactivada pelo administrador (Configurações).`);
    }

    await ensureEmpresasLojas().catch(() => {});
    const lojaId = lojaDe(req);
    let temLojaCol = true;
    let exists;
    try {
      exists = await client.query('SELECT id FROM turnos WHERE data=$1 AND nome=$2 AND loja_id=$3', [data, nome, lojaId]);
    } catch (eL) {
      if (!/loja_id/.test(String(eL.message || ''))) throw eL;
      temLojaCol = false;
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      exists = await client.query('SELECT id FROM turnos WHERE data=$1 AND nome=$2', [data, nome]);
    }
    if (exists.rows.length) {
      // Sincronização offline (client_ref): outro dispositivo pode já ter
      // aberto o mesmo turno — devolve o existente em vez de falhar, para
      // as escritas em fila se aplicarem a esse turno.
      if (String((req.body && req.body.client_ref) || '').trim()) {
        const ex = await client.query('SELECT * FROM turnos WHERE id=$1', [exists.rows[0].id]);
        await client.query('COMMIT');
        return res.json({ ...ex.rows[0], ja_existia: true });
      }
      throw new Error(`Turno ${nome} já existe para ${data}`);
    }

    const turno = temLojaCol
      ? await client.query(
          'INSERT INTO turnos (data, nome, utilizador_id, loja_id) VALUES ($1,$2,$3,$4) RETURNING *',
          [data, nome, req.user.id, lojaId]
        )
      : await client.query(
          'INSERT INTO turnos (data, nome, utilizador_id) VALUES ($1,$2,$3) RETURNING *',
          [data, nome, req.user.id]
        );
    const turnoId = turno.rows[0].id;

    // Stock do turno: só produtos activos DA EMPRESA marcados para a folha
    const produtos = temEmpProd
      ? await client.query(
          `SELECT id FROM produtos WHERE ativo=true AND em_stock_turno IS TRUE AND empresa_id=$1 AND ${SQL_STOCK_CATEGORIAS} ORDER BY ordem`,
          [empresaDe(req)]
        )
      : await client.query(
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

// ── CHECKLIST DO TURNO: tarefas obrigatórias de abertura e fecho ──────
// A lista é configurada por empresa (admin/gestor); cada turno guarda o
// estado das marcações em turnos.checklist (JSONB). NENHUM turno fecha
// com tarefas por fazer — validado no /fechar.
function parseChecklistCfg(raw) {
  try {
    const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const lista = (x) => (Array.isArray(x) ? x : [])
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 40).map((t) => t.slice(0, 200));
    return { abertura: lista(c && c.abertura), fecho: lista(c && c.fecho) };
  } catch (_) { return { abertura: [], fecho: [] }; }
}
app.get('/api/config/checklist-turno', auth, async (req, res) => {
  try { res.json(parseChecklistCfg(await getConfigEmpresa(empresaDe(req), 'checklist_turno'))); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.put('/api/config/checklist-turno', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const cfg = parseChecklistCfg(req.body || {});
    await setConfigEmpresa(empresaDe(req), 'checklist_turno', JSON.stringify(cfg));
    res.json(cfg);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

let checklistColReady = false;
async function ensureChecklistCol() {
  if (checklistColReady) return;
  await query(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS checklist JSONB`).catch(() => {});
  checklistColReady = true;
}

app.put('/api/turnos/:id/checklist', auth, async (req, res) => {
  try {
    await ensureChecklistCol();
    const fase = req.body && req.body.fase === 'abertura' ? 'abertura' : 'fecho';
    const idx = String(Math.max(0, parseInt((req.body && req.body.idx), 10) || 0));
    const feito = !!(req.body && req.body.feito);
    const t = await query(`SELECT estado FROM turnos WHERE id=$1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ erro: 'Turno não encontrado' });
    if (t.rows[0].estado !== 'aberto') return res.status(400).json({ erro: 'O turno já está fechado.' });
    // Marcação ATÓMICA em SQL — o ler-alterar-gravar em JS perdia marcações:
    // o driver gravava o parâmetro string como ESCALAR JSON e a leitura
    // seguinte, não vendo um objecto, recomeçava de {} (apagava tudo). O
    // CASE normaliza também linhas antigas nesse formato (desembrulha).
    const norm = `CASE WHEN jsonb_typeof(checklist)='object' THEN checklist
                       WHEN jsonb_typeof(checklist)='string' THEN (checklist #>> '{}')::jsonb
                       ELSE '{}'::jsonb END`;
    let r;
    if (feito) {
      r = await query(
        `UPDATE turnos SET checklist =
           jsonb_set(
             jsonb_set(${norm}, ARRAY[$2::text], COALESCE(${norm} -> $2::text, '{}'::jsonb), true),
             ARRAY[$2::text, $3::text],
             jsonb_build_object('feito', true, 'por', $4::text, 'em', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
             true)
         WHERE id=$1 RETURNING checklist`,
        [req.params.id, fase, idx, (req.user && req.user.nome) || '']
      );
    } else {
      r = await query(
        `UPDATE turnos SET checklist = (${norm}) #- ARRAY[$2::text, $3::text]
         WHERE id=$1 RETURNING checklist`,
        [req.params.id, fase, idx]
      );
    }
    res.json({ ok: true, checklist: (r.rows[0] && r.rows[0].checklist) || {} });
  } catch (e) { res.status(500).json({ erro: e.message }); }
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
      // Sincronização offline (client_ref): se o turno já está fechado
      // (fechado por outro dispositivo/tentativa), trata como sucesso.
      if (String((req.body && req.body.client_ref) || '').trim()) {
        const ja = await query(`SELECT * FROM turnos WHERE id=$1 AND estado='fechado'`, [req.params.id]).catch(() => ({ rows: [] }));
        if (ja.rows.length) return res.json({ ...ja.rows[0], ja_fechado: true });
      }
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
    // TPA > 0 exige a foto do recibo de fecho do TPA. (Verifica a coluna
    // ANTES do SELECT — um SELECT falhado abortaria a transacção.)
    if (await tpaFotoDisponivel()) {
      const cx = await client.query(
        `SELECT tpa, COALESCE(tpa_foto_url,'') AS tpa_foto_url FROM turno_caixa WHERE turno_id=$1`,
        [turnoId]
      );
      const tpaV = cx.rows.length ? parseFloat(cx.rows[0].tpa) : NaN;
      if (Number.isFinite(tpaV) && tpaV > 0 && !cx.rows[0].tpa_foto_url) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          erro: 'Registaste valor no TPA — anexa a foto do recibo de fecho do TPA (aba 💰 Caixa) antes de fechar o turno.'
        });
      }
    }
    // CHECKLIST: nenhum turno fecha com tarefas de abertura/fecho por
    // fazer. Config por empresa; sem config, não bloqueia nada.
    {
      let cfgChk = null;
      try {
        const lojaT = r.rows[0].loja_id;
        let empT = empresaDe(req);
        if (lojaT) {
          const le = await client.query(`SELECT empresa_id FROM lojas WHERE id=$1`, [lojaT]).catch(() => ({ rows: [] }));
          if (le.rows.length) empT = le.rows[0].empresa_id || empT;
        }
        cfgChk = parseChecklistCfg(await getConfigEmpresa(empT, 'checklist_turno'));
      } catch (_) { cfgChk = null; }
      if (cfgChk && (cfgChk.abertura.length || cfgChk.fecho.length)) {
        const marcado = (r.rows[0].checklist && typeof r.rows[0].checklist === 'object') ? r.rows[0].checklist : {};
        const pend = [];
        for (const fase of ['abertura', 'fecho']) {
          cfgChk[fase].forEach((tarefa, i) => {
            const m = marcado[fase] && marcado[fase][String(i)];
            if (!(m && m.feito)) pend.push(`${fase === 'abertura' ? 'Abertura' : 'Fecho'} — ${tarefa}`);
          });
        }
        if (pend.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            erro: `Checklist do turno incompleto — falta${pend.length === 1 ? '' : 'm'} ${pend.length} tarefa${pend.length === 1 ? '' : 's'}:\n• ` +
              pend.slice(0, 6).join('\n• ') + (pend.length > 6 ? '\n…' : '')
          });
        }
      }
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
    const { produto_id, encontrado, deixado, fechados, encontrado_caixa, deixado_caixa } = req.body;
    const chk = await query(
      `SELECT 1 FROM produtos WHERE id=$1 AND em_stock_turno IS TRUE AND ${SQL_STOCK_CATEGORIAS}`,
      [produto_id]
    );
    if (!chk.rows.length) {
      return res.status(400).json({
        erro: 'Este produto não está incluído na folha de stock do turno. Activa «Stock no turno» em Produtos.'
      });
    }
    // Registos fechados → nas linhas existentes ignora actualizações às
    // colunas bloqueadas (preserva o valor original):
    //  - encontrados fechados: bloqueia encontrado/encontrado_caixa;
    //  - deixados fechados:    bloqueia deixado/deixado_caixa.
    // Fallback sem a coluna deixados_fechados_em (BD ainda por migrar).
    let encontradosFechados = false;
    let deixadosFechados = false;
    try {
      const turnoRow = await query(`SELECT encontrados_fechados_em, deixados_fechados_em FROM turnos WHERE id=$1`, [req.params.id]);
      encontradosFechados = turnoRow.rows.length && turnoRow.rows[0].encontrados_fechados_em != null;
      deixadosFechados = turnoRow.rows.length && turnoRow.rows[0].deixados_fechados_em != null;
    } catch (_) {
      const turnoRow = await query(`SELECT encontrados_fechados_em FROM turnos WHERE id=$1`, [req.params.id]);
      encontradosFechados = turnoRow.rows.length && turnoRow.rows[0].encontrados_fechados_em != null;
    }
    const enc = parseOptionalNumericBody(encontrado);
    const deix = parseOptionalNumericBody(deixado);
    const encG = parseOptionalNumericBody(encontrado_caixa);
    const deixG = parseOptionalNumericBody(deixado_caixa);
    const sets = ['fechados=$5'];
    if (!encontradosFechados) sets.push('encontrado=$3', 'encontrado_caixa=$6');
    if (!deixadosFechados) sets.push('deixado=$4', 'deixado_caixa=$7');
    const updateSet = sets.join(', ');
    const r = await query(
      `INSERT INTO turno_stock (turno_id, produto_id, encontrado, deixado, fechados, encontrado_caixa, deixado_caixa)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (turno_id, produto_id)
       DO UPDATE SET ${updateSet}
       RETURNING *`,
      [req.params.id, produto_id, enc, deix, fechados || 0, encG, deixG]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Fecha o registo inicial de encontrados — bloqueia futuras alterações
 *  às colunas Encontrado e Enc. caixa no PUT /api/turnos/:id/stock. */
/** Tarefas por fazer de uma fase do checklist (portões dos registos). */
async function checklistPendServidor(turnoId, fase, req) {
  try {
    await ensureChecklistCol();
    const t = await query(`SELECT loja_id, checklist FROM turnos WHERE id=$1`, [turnoId]);
    if (!t.rows.length) return [];
    let empT = empresaDe(req);
    if (t.rows[0].loja_id) {
      const le = await query(`SELECT empresa_id FROM lojas WHERE id=$1`, [t.rows[0].loja_id]).catch(() => ({ rows: [] }));
      if (le.rows.length) empT = le.rows[0].empresa_id || empT;
    }
    const cfg = parseChecklistCfg(await getConfigEmpresa(empT, 'checklist_turno'));
    let marcado = t.rows[0].checklist;
    // Linhas antigas com o estado gravado como escalar JSON (string):
    // desembrulha antes de validar — senão as marcações "desapareciam".
    if (typeof marcado === 'string') { try { marcado = JSON.parse(marcado); } catch (_) { marcado = {}; } }
    if (!marcado || typeof marcado !== 'object') marcado = {};
    return (cfg[fase] || []).filter((tarefa, i) =>
      !(marcado[fase] && marcado[fase][String(i)] && marcado[fase][String(i)].feito));
  } catch (_) { return []; }
}

app.post('/api/turnos/:id/encontrados/fechar', auth, async (req, res) => {
  try {
    // PORTÃO: registo inicial exige o checklist de ABERTURA completo.
    const pendA = await checklistPendServidor(req.params.id, 'abertura', req);
    if (pendA.length) {
      return res.status(400).json({
        erro: `Antes de fechar o registo inicial, conclui o checklist de ABERTURA — falta${pendA.length === 1 ? '' : 'm'}:\n• ` + pendA.slice(0, 6).join('\n• ') + (pendA.length > 6 ? '\n…' : '')
      });
    }
    const r = await query(
      `UPDATE turnos SET encontrados_fechados_em = COALESCE(encontrados_fechados_em, NOW())
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Turno não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** Reabre o registo de encontrados — só admin/gestor. */
app.post('/api/turnos/:id/encontrados/reabrir', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const r = await query(
      `UPDATE turnos SET encontrados_fechados_em = NULL WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Turno não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** Fecha o registo dos deixados — bloqueia futuras alterações às colunas
 *  Deixado e Deix. caixa no PUT /api/turnos/:id/stock. */
app.post('/api/turnos/:id/deixados/fechar', auth, async (req, res) => {
  try {
    // PORTÃO: registo dos deixados exige o checklist de FECHO completo.
    const pendF = await checklistPendServidor(req.params.id, 'fecho', req);
    if (pendF.length) {
      return res.status(400).json({
        erro: `Antes de fechar o registo dos deixados, conclui o checklist de FECHO — falta${pendF.length === 1 ? '' : 'm'}:\n• ` + pendF.slice(0, 6).join('\n• ') + (pendF.length > 6 ? '\n…' : '')
      });
    }
    const r = await query(
      `UPDATE turnos SET deixados_fechados_em = COALESCE(deixados_fechados_em, NOW())
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Turno não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    const msg = /deixados_fechados_em/.test(e.message || '')
      ? 'A coluna turnos.deixados_fechados_em ainda não existe nesta BD. Corre o workflow «Reparar schema develop» no GitHub Actions.'
      : e.message;
    res.status(500).json({ erro: msg });
  }
});

/** Reabre o registo dos deixados — só admin/gestor. */
app.post('/api/turnos/:id/deixados/reabrir', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const r = await query(
      `UPDATE turnos SET deixados_fechados_em = NULL WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Turno não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── TURNO: entradas de stock + saídas de caixa (caixa.saida = despesas + compras stock) ──
async function ensureTurnoEntradas() {
  if (turnoEntradasReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='turno_entradas_ddl_v1'`);
    if (r.rows.length) { turnoEntradasReady = true; return; }
  } catch (_) {}
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
  await query(`INSERT INTO stockos_meta (k,v) VALUES ('turno_entradas_ddl_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
  turnoEntradasReady = true;
}

// Produto NÃO registado numa entrada/saída: produto_id fica NULL e o nome
// escrito à mão vai para produto_nome_livre (não entra na folha de stock,
// mas a compra conta na caixa).
let entradaLivreReady = false;
async function ensureEntradaLivre() {
  if (entradaLivreReady) return;
  await query(`ALTER TABLE turno_entradas ALTER COLUMN produto_id DROP NOT NULL`).catch(() => {});
  await query(`ALTER TABLE turno_entradas ADD COLUMN IF NOT EXISTS produto_nome_livre TEXT NOT NULL DEFAULT ''`).catch(() => {});
  entradaLivreReady = true;
}

app.get('/api/turnos/:id/entradas', auth, async (req, res) => {
  try {
    let r;
    try {
      r = await query(
        `SELECT te.*, COALESCE(p.nome, NULLIF(te.produto_nome_livre,''), 'Produto') as produto_nome, p.tipo_medicao
         FROM turno_entradas te LEFT JOIN produtos p ON te.produto_id=p.id
         WHERE te.turno_id=$1 ORDER BY te.criado_em DESC`,
        [req.params.id]
      );
    } catch (e1) {
      // BD ainda sem a coluna produto_nome_livre — SQL antigo (só registados)
      if (!/produto_nome_livre/.test(e1.message)) throw e1;
      r = await query(
        `SELECT te.*, p.nome as produto_nome, p.tipo_medicao
         FROM turno_entradas te JOIN produtos p ON te.produto_id=p.id
         WHERE te.turno_id=$1 ORDER BY te.criado_em DESC`,
        [req.params.id]
      );
    }
    res.json(r.rows);
  } catch(e) {
    if (e.message.includes('does not exist')) {
      try { await ensureTurnoEntradas(); res.json([]); } catch(e2) { res.status(500).json({ erro: e2.message }); }
    } else { res.status(500).json({ erro: e.message }); }
  }
});

app.post('/api/turnos/:id/entradas', auth, async (req, res) => {
  const produtoLivre = String(req.body.produto_livre || '').trim();
  // DDL do produto livre fora da transacção (um catch dentro de BEGIN aborta-a)
  if (!req.body.produto_id && produtoLivre) { try { await ensureEntradaLivre(); } catch (_) {} }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const turnoId = req.params.id;
    const { produto_id, tipo, origem, preco, quantidade, notas } = req.body;
    if ((!produto_id && !produtoLivre) || !quantidade || parseFloat(quantidade) <= 0)
      throw new Error('produto (registado ou nome livre) e quantidade (> 0) são obrigatórios');
    const notasVal = String(notas != null ? notas : '').trim();
    const tipoVal   = tipo   === 'tirar'  ? 'tirar'  : 'entrada';
    const origemVal = origem === 'compra' ? 'compra' : 'armazem';
    const precoVal  = origemVal === 'compra' ? (parseFloat(preco) || 0) : 0;

    let registo;
    if (produto_id) {
      const emStock = await client.query(
        `SELECT 1 FROM produtos WHERE id=$1 AND em_stock_turno IS TRUE AND ${SQL_STOCK_CATEGORIAS}`,
        [produto_id]
      );
      if (!emStock.rows.length) {
        throw new Error(
          'Este produto não está na folha de stock do turno. Activa «Stock no turno» em Produtos ou regista no armazém.'
        );
      }

      registo = await client.query(
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
    } else {
      // Produto NÃO registado: sem folha de stock a actualizar — fica o
      // registo do movimento (e a compra conta na caixa, abaixo).
      registo = await client.query(
        'INSERT INTO turno_entradas (turno_id, produto_id, produto_nome_livre, tipo, origem, preco, quantidade, notas) VALUES ($1,NULL,$2,$3,$4,$5,$6,$7) RETURNING *',
        [turnoId, produtoLivre, tipoVal, origemVal, precoVal, quantidade, notasVal]
      );
      registo.rows[0].produto_nome = produtoLivre;
    }

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
  // Exclui entradas de caixa guardadas em turno_saidas (notas começa por
  // 'ENTRADA::') — essas são dinheiro que ENTROU, não saídas.
  const despesas = await q(`SELECT COALESCE(SUM(valor),0) as t FROM turno_saidas WHERE turno_id=$1 AND COALESCE(notas,'') NOT LIKE 'ENTRADA::%'`, [turnoId]).catch(() => ({ rows: [{ t: 0 }] }));
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

// ── Foto do recibo de fecho do TPA (obrigatória para fechar turno com TPA > 0) ──
let turnoCaixaTpaFotoReady = false;
async function ensureTurnoCaixaTpaFoto() {
  if (turnoCaixaTpaFotoReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='turno_caixa_tpa_foto_v1'`);
    if (r.rows.length) { turnoCaixaTpaFotoReady = true; return; }
  } catch (_) {}
  await qry(`ALTER TABLE turno_caixa ADD COLUMN IF NOT EXISTS tpa_foto_url TEXT NOT NULL DEFAULT ''`, [], 'turno_caixa-tpa-foto');
  try {
    const chk = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='turno_caixa' AND column_name='tpa_foto_url'`
    );
    if (chk.rows.length) {
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('turno_caixa_tpa_foto_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
      turnoCaixaTpaFotoReady = true;
    }
  } catch (_) {}
}

/** Verifica se a coluna existe mesmo (o ALTER falha em silêncio sem owner). */
async function tpaFotoDisponivel() {
  await ensureTurnoCaixaTpaFoto();
  return turnoCaixaTpaFotoReady;
}

app.post('/api/turnos/:id/caixa/tpa-foto', auth, async (req, res) => {
  try {
    if (!(await tpaFotoDisponivel())) {
      return res.status(400).json({ erro: 'A coluna turno_caixa.tpa_foto_url ainda não existe nesta BD. Corre o workflow «Reparar schema develop».' });
    }
    const remover = !!(req.body && req.body.remover);
    let finalUrl = '';
    if (!remover) {
      const fotoRaw = String((req.body && req.body.foto_base64) || '').trim();
      const parsed = parseDataUrlFoto(fotoRaw);
      if (!parsed) return res.status(400).json({ erro: 'Envia uma imagem (JPEG, PNG ou WebP) em base64 (data URL).' });
      const { url: sbUrl, key: sbKey } = getSupabaseEnv();
      if (sbUrl && sbKey) {
        const fileKey = `tpa-fecho/${req.params.id}-${crypto.randomBytes(6).toString('hex')}.${parsed.ext}`;
        finalUrl = await uploadBorderoToSupabase(parsed.buffer, fileKey, parsed.contentType);
      } else {
        if (fotoRaw.length > 4 * 1024 * 1024) {
          return res.status(400).json({ erro: 'Imagem demasiado grande. Define SUPABASE_SERVICE_ROLE_KEY no servidor para usar Storage.' });
        }
        finalUrl = fotoRaw;
      }
    }
    const r = await query(
      `INSERT INTO turno_caixa (turno_id, tpa_foto_url) VALUES ($1,$2)
       ON CONFLICT (turno_id) DO UPDATE SET tpa_foto_url=$2
       RETURNING tpa_foto_url`,
      [req.params.id, finalUrl]
    );
    res.json({ tpa_foto_url: r.rows[0].tpa_foto_url || '' });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
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
  if (turnoSaidasReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='turno_saidas_ddl_v1'`);
    if (r.rows.length) { turnoSaidasReady = true; return; }
  } catch (_) {}
  await query(`CREATE TABLE IF NOT EXISTS turno_saidas (
    id SERIAL PRIMARY KEY,
    turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL DEFAULT '',
    valor NUMERIC(15,2) NOT NULL DEFAULT 0,
    notas TEXT NOT NULL DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`INSERT INTO stockos_meta (k,v) VALUES ('turno_saidas_ddl_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
  turnoSaidasReady = true;
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

// ── Entradas extras de caixa (dinheiro que entrou — sangria reversa,
// devoluções, fundo de caixa, etc). Tabela própria, formato análogo a
// turno_saidas. Resiliente: se a tabela não existir e a app não puder
// criar (sem owner), GET devolve [] e POST falha com mensagem clara. ──
let _turnoCaixaEntradasAvail = null;
async function ensureTurnoCaixaEntradas() {
  if (_turnoCaixaEntradasAvail === true) return true;
  try {
    const r = await query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='turno_caixa_entradas' LIMIT 1`
    );
    if (r.rows.length) { _turnoCaixaEntradasAvail = true; return true; }
  } catch (_) {}
  try {
    await query(`CREATE TABLE IF NOT EXISTS turno_caixa_entradas (
      id SERIAL PRIMARY KEY,
      turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
      descricao TEXT NOT NULL DEFAULT '',
      valor NUMERIC(15,2) NOT NULL DEFAULT 0,
      notas TEXT NOT NULL DEFAULT '',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    _turnoCaixaEntradasAvail = true;
  } catch (e) {
    console.warn('[ensureTurnoCaixaEntradas]', e && e.message);
    _turnoCaixaEntradasAvail = false;
  }
  return _turnoCaixaEntradasAvail;
}

app.get('/api/turnos/:id/caixa-entradas', auth, async (req, res) => {
  try {
    const ok = await ensureTurnoCaixaEntradas();
    if (!ok) return res.json([]);
    const r = await query(
      `SELECT * FROM turno_caixa_entradas WHERE turno_id=$1 ORDER BY criado_em DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message && e.message.includes('does not exist')) { res.json([]); return; }
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/turnos/:id/caixa-entradas', auth, async (req, res) => {
  try {
    const ok = await ensureTurnoCaixaEntradas();
    if (!ok) return res.status(503).json({
      erro: 'Tabela turno_caixa_entradas em falta e sem permissão para a criar. Pede ao admin para a criar no SQL Editor do Supabase.'
    });
    const { descricao, valor, notas } = req.body;
    if (!descricao || !descricao.trim()) return res.status(400).json({ erro: 'Descrição é obrigatória' });
    if (!valor || parseFloat(valor) <= 0) return res.status(400).json({ erro: 'Valor deve ser maior que 0' });
    const r = await query(
      'INSERT INTO turno_caixa_entradas (turno_id, descricao, valor, notas) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, descricao.trim(), valor, String(notas || '').trim()]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
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
    const lojaId = lojaDe(req);
    const montarSql = (comLoja) => {
      let s = `SELECT d.*, u.nome AS criado_por_nome, t.nome AS turno_nome, t.data AS turno_data
               FROM depositos_banco d
               JOIN turnos t ON t.id = d.turno_id
               LEFT JOIN utilizadores u ON u.id::text = d.criado_por::text`;
      const w = [];
      const p = [];
      if (data) { p.push(data); w.push(`t.data = $${p.length}`); }
      if (comLoja) { p.push(lojaId); w.push(`t.loja_id = $${p.length}`); }
      if (w.length) s += ` WHERE ` + w.join(' AND ');
      s += ` ORDER BY t.data DESC, CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 ELSE 3 END, d.criado_em DESC LIMIT ${limit}`;
      return { s, p };
    };
    let r;
    try {
      const q1 = montarSql(true);
      r = await query(q1.s, q1.p);
    } catch (eL) {
      if (!/loja_id/.test(String(eL.message || ''))) throw eL;
      const q2 = montarSql(false);
      r = await query(q2.s, q2.p);
    }
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
    const vtransfRaw = parseFloat(req.body?.valor_transferencia);
    const vtransf = Number.isNaN(vtransfRaw) ? 0 : Math.max(0, vtransfRaw);
    await assertTurnoFechado(turno_id);
    if (!(await turnoNoContexto(req, parseInt(turno_id, 10)).catch(() => true))) {
      return res.status(404).json({ erro: 'Turno não encontrado' });
    }
    // Bloqueia alterações se já registado e fechado — só admin reabre.
    const ex = await query(`SELECT fechado FROM depositos_banco WHERE turno_id=$1`, [parseInt(turno_id, 10)]);
    if (ex.rows.length && ex.rows[0].fechado === true && req.user.role !== 'admin') {
      return res.status(403).json({ erro: 'Depósito já registado e fechado — pede a um admin para reabrir antes de alterar.' });
    }
    const ddep = (data_deposito || new Date().toISOString().split('T')[0]).trim();
    const r = await query(
      `INSERT INTO depositos_banco (turno_id, data_deposito, valor, valor_tpa, valor_transferencia, valor_saidas, saidas_destino, referencia, notas, criado_por, fechado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
       ON CONFLICT (turno_id) DO UPDATE SET
         data_deposito = EXCLUDED.data_deposito,
         valor = EXCLUDED.valor,
         valor_tpa = EXCLUDED.valor_tpa,
         valor_transferencia = EXCLUDED.valor_transferencia,
         valor_saidas = EXCLUDED.valor_saidas,
         saidas_destino = EXCLUDED.saidas_destino,
         referencia = EXCLUDED.referencia,
         notas = EXCLUDED.notas,
         criado_em = NOW(),
         fechado = TRUE
       RETURNING *`,
      [
        parseInt(turno_id, 10),
        ddep,
        v,
        vtpa,
        vtransf,
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
      const vtransfRaw = parseFloat(raw.valor_transferencia);
      const vtransf = Number.isNaN(vtransfRaw) ? 0 : Math.max(0, vtransfRaw);
      await assertTurnoFechado(tid);
      if (!(await turnoNoContexto(req, tid).catch(() => true))) {
        return res.status(404).json({ erro: 'Turno não encontrado' });
      }
      valid.push({
        turno_id: tid,
        data_deposito: (raw.data_deposito || new Date().toISOString().split('T')[0]).trim(),
        valor: v,
        valor_saidas: 0,
        saidas_destino: '',
        valor_tpa: vtpa,
        valor_transferencia: vtransf,
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
    // Verifica se algum dos turnos visados está fechado e o utilizador não é admin.
    const exFech = await query(
      `SELECT turno_id FROM depositos_banco WHERE turno_id = ANY($1::int[]) AND fechado = TRUE`,
      [dedup.map((r) => r.turno_id)]
    );
    if (exFech.rows.length && req.user.role !== 'admin') {
      return res.status(403).json({ erro: 'Existem depósitos já fechados para este dia — pede a um admin para reabrir antes de alterar.' });
    }
    let out = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of dedup) {
        const r = await client.query(
          `INSERT INTO depositos_banco (turno_id, data_deposito, valor, valor_tpa, valor_transferencia, valor_saidas, saidas_destino, referencia, notas, criado_por, fechado)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
           ON CONFLICT (turno_id) DO UPDATE SET
             data_deposito = EXCLUDED.data_deposito,
             valor = EXCLUDED.valor,
             valor_tpa = EXCLUDED.valor_tpa,
             valor_transferencia = EXCLUDED.valor_transferencia,
             valor_saidas = EXCLUDED.valor_saidas,
             saidas_destino = EXCLUDED.saidas_destino,
             referencia = EXCLUDED.referencia,
             notas = EXCLUDED.notas,
             criado_em = NOW(),
             fechado = TRUE
           RETURNING *`,
          [
            row.turno_id,
            row.data_deposito,
            row.valor,
            row.valor_tpa,
            row.valor_transferencia,
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

/** Reabrir depósitos de um dia (todos os turnos) para alteração — só admin. */
app.patch('/api/depositos/abrir', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const data = String(req.query.data || req.body?.data || '').trim();
    if (!data) return res.status(400).json({ erro: 'Indica a data (?data=YYYY-MM-DD).' });
    const r = await queryEmpresa(
      `UPDATE depositos_banco d SET fechado = FALSE
       FROM turnos t WHERE t.id = d.turno_id AND t.data = $1::date AND t.loja_id = $2 AND d.fechado = TRUE`,
      [data, lojaDe(req)],
      `UPDATE depositos_banco d SET fechado = FALSE
       FROM turnos t WHERE t.id = d.turno_id AND t.data = $1::date AND d.fechado = TRUE`,
      [data]
    );
    res.json({ ok: true, reabertos: r.rowCount || 0 });
  } catch (e) {
    res.status(500).json({ erro: e.message });
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

// ── IRREGULARIDADES — DECISÕES (aceite / pendente) ───────────────
const IRREG_CATS = new Set(['caixa', 'banco', 'stock', 'fino']);
const IRREG_ING_RE = /^ing:[0-9a-fA-F-]{8,64}$/;
function isIrregCategoriaValida(cat) {
  if (!cat) return false;
  if (IRREG_CATS.has(cat)) return true;
  if (IRREG_ING_RE.test(cat)) return true;
  // Aceitar legado batata/coxa para não invalidar decisões antigas.
  return cat === 'batata' || cat === 'coxa';
}

async function ensureIrregularidadeDecisoes() {
  if (irregularidadeDecisoesReady) return;
  let v1Done = false;
  let v2Done = false;
  try {
    const r = await query(`SELECT k FROM stockos_meta WHERE k IN ('irreg_decisoes_ddl_v1','irreg_decisoes_ddl_v2')`);
    for (const row of r.rows) {
      if (row.k === 'irreg_decisoes_ddl_v1') v1Done = true;
      if (row.k === 'irreg_decisoes_ddl_v2') v2Done = true;
    }
  } catch (_) {}
  try {
    if (!v1Done) {
      await query(`CREATE TABLE IF NOT EXISTS irregularidade_decisoes (
        id SERIAL PRIMARY KEY,
        turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
        categoria VARCHAR(20) NOT NULL,
        aceite BOOLEAN NOT NULL DEFAULT TRUE,
        justificacao TEXT NOT NULL DEFAULT '',
        decidido_por TEXT NOT NULL DEFAULT '',
        decidido_por_nome TEXT NOT NULL DEFAULT '',
        decidido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(turno_id, categoria)
      )`);
      await query(`CREATE INDEX IF NOT EXISTS irreg_decisoes_turno_idx ON irregularidade_decisoes(turno_id)`).catch(() => {});
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('irreg_decisoes_ddl_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
    }
    if (!v2Done) {
      // Alargar para caber `ing:<uuid>` (40 chars). Idempotente.
      await query(`ALTER TABLE irregularidade_decisoes ALTER COLUMN categoria TYPE VARCHAR(64)`).catch(() => {});
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('irreg_decisoes_ddl_v2','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
    }
    irregularidadeDecisoesReady = true;
  } catch (e) {
    console.warn('[ensureIrregularidadeDecisoes]', e && e.message);
  }
}

/** GET decisões por turno(s). Aceita ?turno_id=1,2,3 ou ?turno_id=1 */
app.get('/api/irregularidades/decisoes', auth, async (req, res) => {
  try {
    {
      const tIrr = parseInt((req.query && req.query.turno_id) || '', 10);
      if (Number.isFinite(tIrr) && tIrr > 0 && !(await turnoNoContexto(req, tIrr).catch(() => true))) {
        return res.status(404).json({ erro: 'Turno não encontrado' });
      }
    }

    await ensureIrregularidadeDecisoes();
    const raw = String(req.query.turno_id || '').trim();
    if (!raw) return res.json([]);
    const ids = raw.split(',').map(x => parseInt(x, 10)).filter(Number.isFinite);
    if (!ids.length) return res.json([]);
    const r = await query(
      `SELECT d.*, u.nome AS decidido_por_nome
       FROM irregularidade_decisoes d
       LEFT JOIN utilizadores u ON u.id::text = d.decidido_por::text
       WHERE d.turno_id = ANY($1::int[])`,
      [ids]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** POST decidir (upsert). { turno_id, categoria, aceite=true, justificacao='' } */
app.post('/api/irregularidades/decisao', auth, requireRole('admin'), async (req, res) => {
  try {
    {
      const tIrr = parseInt((req.body && req.body.turno_id) || '', 10);
      if (Number.isFinite(tIrr) && tIrr > 0 && !(await turnoNoContexto(req, tIrr).catch(() => true))) {
        return res.status(404).json({ erro: 'Turno não encontrado' });
      }
    }

    await ensureIrregularidadeDecisoes();
    const tid = parseInt(req.body?.turno_id, 10);
    const cat = String(req.body?.categoria || '').trim().toLowerCase();
    if (!tid || !isIrregCategoriaValida(cat)) {
      return res.status(400).json({ erro: 'turno_id e categoria (caixa/banco/stock/fino ou ing:<produto_id>) obrigatórios.' });
    }
    const aceite = req.body?.aceite !== false;
    const just = String(req.body?.justificacao || '').trim();
    const uNome = await query('SELECT nome FROM utilizadores WHERE id=$1', [req.user.id]).catch(() => ({ rows: [] }));
    const r = await query(
      `INSERT INTO irregularidade_decisoes (turno_id, categoria, aceite, justificacao, decidido_por, decidido_por_nome, decidido_em)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (turno_id, categoria) DO UPDATE SET
         aceite = EXCLUDED.aceite,
         justificacao = EXCLUDED.justificacao,
         decidido_por = EXCLUDED.decidido_por,
         decidido_por_nome = EXCLUDED.decidido_por_nome,
         decidido_em = NOW()
       RETURNING *`,
      [tid, cat, aceite, just, String(req.user.id || ''), uNome.rows[0]?.nome || '']
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** DELETE — remover decisão (volta a pendente). */
app.delete('/api/irregularidades/decisao', auth, requireRole('admin'), async (req, res) => {
  try {
    {
      const tIrr = parseInt((req.query && req.query.turno_id) || '', 10);
      if (Number.isFinite(tIrr) && tIrr > 0 && !(await turnoNoContexto(req, tIrr).catch(() => true))) {
        return res.status(404).json({ erro: 'Turno não encontrado' });
      }
    }

    await ensureIrregularidadeDecisoes();
    const tid = parseInt(req.query.turno_id, 10);
    const cat = String(req.query.categoria || '').trim().toLowerCase();
    if (!tid || !isIrregCategoriaValida(cat)) {
      return res.status(400).json({ erro: 'turno_id e categoria obrigatórios.' });
    }
    await query('DELETE FROM irregularidade_decisoes WHERE turno_id=$1 AND categoria=$2', [tid, cat]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── IRREGULARIDADES — COMENTÁRIOS (thread por turno+categoria) ──
async function ensureIrregularidadeComentarios() {
  if (irregularidadeComentariosReady) return;
  let done = false;
  try {
    const r = await query(`SELECT k FROM stockos_meta WHERE k = 'irreg_comentarios_ddl_v1'`);
    if (r.rows.length) done = true;
  } catch (_) {}
  try {
    if (!done) {
      await query(`CREATE TABLE IF NOT EXISTS irregularidade_comentarios (
        id SERIAL PRIMARY KEY,
        turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
        categoria VARCHAR(64) NOT NULL,
        autor_id TEXT NOT NULL DEFAULT '',
        autor_nome TEXT NOT NULL DEFAULT '',
        comentario TEXT NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await query(`CREATE INDEX IF NOT EXISTS irreg_comentarios_turno_cat_idx ON irregularidade_comentarios(turno_id, categoria)`).catch(() => {});
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('irreg_comentarios_ddl_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
    }
    irregularidadeComentariosReady = true;
  } catch (e) {
    console.warn('[ensureIrregularidadeComentarios]', e && e.message);
  }
}

/** GET comentários por turno(s). ?turno_id=1,2,3 — devolve todos ordenados por criado_em ASC. */
app.get('/api/irregularidades/comentarios', auth, async (req, res) => {
  try {
    {
      const tIrr = parseInt((req.query && req.query.turno_id) || '', 10);
      if (Number.isFinite(tIrr) && tIrr > 0 && !(await turnoNoContexto(req, tIrr).catch(() => true))) {
        return res.status(404).json({ erro: 'Turno não encontrado' });
      }
    }

    await ensureIrregularidadeComentarios();
    const raw = String(req.query.turno_id || '').trim();
    if (!raw) return res.json([]);
    const ids = raw.split(',').map(x => parseInt(x, 10)).filter(Number.isFinite);
    if (!ids.length) return res.json([]);
    const r = await query(
      `SELECT c.id, c.turno_id, c.categoria, c.autor_id, c.autor_nome, c.comentario, c.criado_em
       FROM irregularidade_comentarios c
       WHERE c.turno_id = ANY($1::int[])
       ORDER BY c.criado_em ASC, c.id ASC`,
      [ids]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** POST adicionar comentário. { turno_id, categoria, comentario } — qualquer utilizador autenticado. */
app.post('/api/irregularidades/comentario', auth, async (req, res) => {
  try {
    {
      const tIrr = parseInt((req.body && req.body.turno_id) || '', 10);
      if (Number.isFinite(tIrr) && tIrr > 0 && !(await turnoNoContexto(req, tIrr).catch(() => true))) {
        return res.status(404).json({ erro: 'Turno não encontrado' });
      }
    }

    await ensureIrregularidadeComentarios();
    const tid = parseInt(req.body?.turno_id, 10);
    const cat = String(req.body?.categoria || '').trim().toLowerCase();
    const texto = String(req.body?.comentario || '').trim();
    if (!tid || !isIrregCategoriaValida(cat)) {
      return res.status(400).json({ erro: 'turno_id e categoria (caixa/banco/stock/fino ou ing:<produto_id>) obrigatórios.' });
    }
    if (!texto) return res.status(400).json({ erro: 'comentário vazio.' });
    if (texto.length > 2000) return res.status(400).json({ erro: 'comentário demasiado longo (máx. 2000 caracteres).' });
    const uNome = await query('SELECT nome FROM utilizadores WHERE id=$1', [req.user.id]).catch(() => ({ rows: [] }));
    const r = await query(
      `INSERT INTO irregularidade_comentarios (turno_id, categoria, autor_id, autor_nome, comentario)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [tid, cat, String(req.user.id || ''), uNome.rows[0]?.nome || '', texto]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** DELETE — só admin ou o próprio autor. */
app.delete('/api/irregularidades/comentario', auth, async (req, res) => {
  try {
    await ensureIrregularidadeComentarios();
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ erro: 'id obrigatório.' });
    const r = await query('SELECT autor_id FROM irregularidade_comentarios WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Comentário não encontrado.' });
    const ehAdmin = req.user.role === 'admin';
    const ehAutor = String(r.rows[0].autor_id) === String(req.user.id);
    if (!ehAdmin && !ehAutor) return res.status(403).json({ erro: 'Só o autor ou um admin pode apagar este comentário.' });
    await query('DELETE FROM irregularidade_comentarios WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── JUSTIFICAÇÕES DE FALTA / HORA EXTRA ──
async function ensurePresencaJustificacoes() {
  if (presencaJustificacoesReady) return;
  let done = false;
  try {
    const r = await query(`SELECT k FROM stockos_meta WHERE k = 'presenca_just_ddl_v1'`);
    if (r.rows.length) done = true;
  } catch (_) {}
  try {
    if (!done) {
      await query(`CREATE TABLE IF NOT EXISTS presenca_justificacoes (
        id SERIAL PRIMARY KEY,
        turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
        utilizador_id TEXT NOT NULL,
        tipo VARCHAR(16) NOT NULL CHECK (tipo IN ('falta', 'hora_extra')),
        justificacao TEXT NOT NULL,
        criado_por TEXT NOT NULL DEFAULT '',
        criado_por_nome TEXT NOT NULL DEFAULT '',
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        estado VARCHAR(16) NOT NULL DEFAULT 'pendente',
        decidido_por TEXT,
        decidido_por_nome TEXT,
        decidido_em TIMESTAMPTZ,
        observacao_admin TEXT,
        UNIQUE (turno_id, utilizador_id, tipo)
      )`);
      await query(`CREATE INDEX IF NOT EXISTS presenca_just_turno_idx ON presenca_justificacoes(turno_id)`).catch(() => {});
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('presenca_just_ddl_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
    }
    presencaJustificacoesReady = true;
  } catch (e) {
    console.warn('[ensurePresencaJustificacoes]', e && e.message);
  }
}

function isPresencaTipoValido(t) {
  return t === 'falta' || t === 'hora_extra';
}

/** GET justificações por turno(s). ?turno_id=1,2,3. */
app.get('/api/presencas/justificacoes', auth, async (req, res) => {
  try {
    await ensurePresencaJustificacoes();
    const raw = String(req.query.turno_id || '').trim();
    if (!raw) return res.json([]);
    const ids = raw.split(',').map(x => parseInt(x, 10)).filter(Number.isFinite);
    if (!ids.length) return res.json([]);
    const r = await query(
      `SELECT id, turno_id, utilizador_id, tipo, justificacao,
              criado_por, criado_por_nome, criado_em,
              estado, decidido_por, decidido_por_nome, decidido_em, observacao_admin
       FROM presenca_justificacoes
       WHERE turno_id = ANY($1::int[])
       ORDER BY criado_em ASC, id ASC`,
      [ids]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** POST nova/atualizada justificação. Reset estado=pendente. Qualquer autenticado. */
app.post('/api/presencas/justificacao', auth, async (req, res) => {
  try {
    await ensurePresencaJustificacoes();
    const tid = parseInt(req.body?.turno_id, 10);
    const uid = String(req.body?.utilizador_id || '').trim();
    const tipo = String(req.body?.tipo || '').trim();
    const texto = String(req.body?.justificacao || '').trim();
    if (!tid || !uid || !isPresencaTipoValido(tipo)) {
      return res.status(400).json({ erro: 'turno_id, utilizador_id e tipo (falta|hora_extra) obrigatórios.' });
    }
    if (!texto) return res.status(400).json({ erro: 'justificação vazia.' });
    if (texto.length > 2000) return res.status(400).json({ erro: 'justificação demasiado longa (máx. 2000 caracteres).' });
    const uNome = await query('SELECT nome FROM utilizadores WHERE id=$1', [req.user.id]).catch(() => ({ rows: [] }));
    const r = await query(
      `INSERT INTO presenca_justificacoes (turno_id, utilizador_id, tipo, justificacao, criado_por, criado_por_nome)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (turno_id, utilizador_id, tipo) DO UPDATE SET
         justificacao = EXCLUDED.justificacao,
         criado_por = EXCLUDED.criado_por,
         criado_por_nome = EXCLUDED.criado_por_nome,
         criado_em = NOW(),
         estado = 'pendente',
         decidido_por = NULL,
         decidido_por_nome = NULL,
         decidido_em = NULL,
         observacao_admin = NULL
       RETURNING *`,
      [tid, uid, tipo, texto, String(req.user.id || ''), uNome.rows[0]?.nome || '']
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** POST decisão (admin). { id, aceite, observacao? }. */
app.post('/api/presencas/justificacao/decisao', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensurePresencaJustificacoes();
    const id = parseInt(req.body?.id, 10);
    if (!id) return res.status(400).json({ erro: 'id obrigatório.' });
    const aceite = req.body?.aceite !== false;
    const obs = String(req.body?.observacao || '').trim();
    const uNome = await query('SELECT nome FROM utilizadores WHERE id=$1', [req.user.id]).catch(() => ({ rows: [] }));
    const r = await query(
      `UPDATE presenca_justificacoes SET
         estado = $1,
         decidido_por = $2,
         decidido_por_nome = $3,
         decidido_em = NOW(),
         observacao_admin = $4
       WHERE id = $5
       RETURNING *`,
      [aceite ? 'aceite' : 'rejeitada', String(req.user.id || ''), uNome.rows[0]?.nome || '', obs, id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Justificação não encontrada.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** DELETE — só admin ou autor. */
app.delete('/api/presencas/justificacao', auth, async (req, res) => {
  try {
    await ensurePresencaJustificacoes();
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ erro: 'id obrigatório.' });
    const r = await query('SELECT criado_por FROM presenca_justificacoes WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Justificação não encontrada.' });
    const ehAdmin = req.user.role === 'admin';
    const ehAutor = String(r.rows[0].criado_por) === String(req.user.id);
    if (!ehAdmin && !ehAutor) return res.status(403).json({ erro: 'Só o autor ou um admin pode apagar.' });
    await query('DELETE FROM presenca_justificacoes WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── HISTÓRICO ─────────────────────────────────────────────────
/** Uma linha por turno: total_vendas (stock×preço), total_gerado e total_final (caixa), como em GET /dia. */
/** Filtro opcional por HORA no Histórico. `inicio`/`fim` aceitam
 *  'YYYY-MM-DD' ou 'YYYY-MM-DDTHH:MM'. Sem hora (ou dia inteiro
 *  00:00–23:59) fica só o filtro por data, como antes. Com hora, filtra
 *  pelos turnos ABERTOS dentro do intervalo (criado_em em hora local de
 *  Angola). Os valores passam por regex antes de irem inline no SQL. */
function filtroHoraTurnos(inicio, fim, defD1, defD2) {
  const m1 = String(inicio || '').match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/);
  const m2 = String(fim || '').match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/);
  const d1 = m1 ? m1[1] : defD1;
  const d2 = m2 ? m2[1] : defD2;
  const h1 = m1 && m1[2] != null ? `${m1[2]}:${m1[3]}` : null;
  const h2 = m2 && m2[2] != null ? `${m2[2]}:${m2[3]}` : null;
  const diaInteiro = (!h1 || h1 === '00:00') && (!h2 || h2 === '23:59');
  if (diaInteiro) return { d1, d2, horaSql: '' };
  const horaSql = ` AND COALESCE(t.criado_em AT TIME ZONE 'Africa/Luanda', t.data::timestamp) BETWEEN '${d1} ${h1 || '00:00'}'::timestamp AND '${d2} ${h2 || '23:59'}:59.999'::timestamp`;
  return { d1, d2, horaSql };
}

app.get('/api/historico', auth, async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    const { d1, d2, horaSql } = filtroHoraTurnos(
      inicio, fim, '2020-01-01', new Date().toISOString().split('T')[0]
    );
    const sqlHist = `SELECT
         t.id AS turno_id,
         t.data,
         t.nome,
         t.estado,
         COALESCE(v.total_vendas, 0)::numeric AS total_vendas,
         COALESCE(tc.dinheiro,0)::numeric AS caixa_dinheiro,
         COALESCE(tc.transferencia,0)::numeric AS caixa_transferencia,
         COALESCE(tc.tpa,0)::numeric AS caixa_tpa,
         COALESCE(tc.saida,0)::numeric AS caixa_saida,
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
       WHERE t.data BETWEEN $1::date AND $2::date{HORA_FILTRO} {LOJA_FILTRO}
       ORDER BY t.data DESC,
         CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 9 END`;
    const sqlHistH = sqlHist.replace('{HORA_FILTRO}', horaSql);
    const r = await queryEmpresa(
      sqlHistH.replace('{LOJA_FILTRO}', 'AND t.loja_id = $3'), [d1, d2, lojaDe(req)],
      sqlHistH.replace('{LOJA_FILTRO}', ''), [d1, d2]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/**
 * Quantidade vendida por produto no período. Agrega DUAS fontes:
 *  - `turno_stock` (em_stock_turno=true): bebidas em garrafa/lata, ingredientes — vendido = enc+entrada-deixado
 *  - `turno_vendas` (em_stock_turno=false): menu e bebidas por copo — quantidade directa
 * Valor em Kz usa `sqlTsValorVendaLinha()` para stock, e `quantidade * preco` (com snapshot histórico) para vendas directas.
 */
app.get('/api/historico/vendas-produtos', auth, async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    const { d1, d2, horaSql } = filtroHoraTurnos(
      inicio, fim, '2020-01-01', new Date().toISOString().split('T')[0]
    );
    const precoUnitDirecto = _sqlUsePrecoHistorico
      ? `COALESCE(tv.preco_unit_snapshot, (SELECT h.preco FROM produto_preco_historico h WHERE h.produto_id = p.id AND ${sqlWhereHistLteTurno('t')} ORDER BY h.valid_from DESC, ${SQL_ORD_H} DESC LIMIT 1), p.preco)::numeric`
      : `COALESCE(tv.preco_unit_snapshot, p.preco)::numeric`;
    // Para bebidas por copo com pacote (ex. Fino 1000: 3 copos = 1000 Kz):
    //   valor = pacotes_completos × preço_pacote + copos_restantes × preço_unitário
    // Usa snapshot ao tempo da venda; fallback nos valores actuais do produto.
    const qtdPac   = `COALESCE(tv.qtd_copos_pacote_snapshot, p.qtd_copos_pacote, 0)::numeric`;
    const precoPac = `COALESCE(tv.preco_copos_pacote_snapshot, p.preco_copos_pacote, 0)::numeric`;
    const valorLinhaDirecto = `
      CASE
        WHEN ${qtdPac} > 0 AND ${precoPac} > 0 THEN
          FLOOR(tv.quantidade / ${qtdPac}) * ${precoPac}
          + (tv.quantidade - FLOOR(tv.quantidade / ${qtdPac}) * ${qtdPac}) * (${precoUnitDirecto})
        ELSE
          tv.quantidade * (${precoUnitDirecto})
      END`;
    const sqlVp = `WITH preco_compra_atual AS (
         SELECT DISTINCT ON (produto_id) produto_id,
           CASE WHEN quantidade > 0 AND valor_total > 0
                THEN (valor_total / quantidade)
                ELSE preco_unitario
           END::numeric AS preco_unitario
         FROM armazem_compras
         WHERE quantidade > 0
         ORDER BY produto_id, criado_em DESC
       ),
       stock_sales AS (
         SELECT
           p.id AS produto_id,
           p.nome AS produto_nome,
           p.categoria,
           p.tipo_medicao,
           p.venda_por_copo,
           p.preco::numeric AS preco_venda,
           COALESCE(pc.preco_unitario, 0)::numeric AS preco_compra_ultimo,
           p.ordem,
           COALESCE(SUM(${sqlGteStockVendido()}), 0)::numeric AS qtd_vendida,
           COALESCE(SUM(${sqlTsValorVendaLinha()}), 0)::numeric AS valor_vendas,
           COUNT(DISTINCT ts.turno_id)::int AS turnos
         FROM turno_stock ts
         INNER JOIN produtos p ON p.id = ts.produto_id AND p.em_stock_turno IS TRUE AND ${SQL_P_STOCK_CATEGORIAS}
         INNER JOIN turnos t ON t.id = ts.turno_id
         LEFT JOIN preco_compra_atual pc ON pc.produto_id = p.id
         WHERE t.data BETWEEN $1::date AND $2::date{HORA_FILTRO} {LOJA_FILTRO}
         GROUP BY p.id, p.nome, p.categoria, p.tipo_medicao, p.venda_por_copo, p.preco, pc.preco_unitario, p.ordem
       ),
       direct_sales AS (
         SELECT
           p.id AS produto_id,
           p.nome AS produto_nome,
           p.categoria,
           p.tipo_medicao,
           p.venda_por_copo,
           p.preco::numeric AS preco_venda,
           COALESCE(pc.preco_unitario, 0)::numeric AS preco_compra_ultimo,
           p.ordem,
           COALESCE(SUM(tv.quantidade), 0)::numeric AS qtd_vendida,
           COALESCE(SUM(${valorLinhaDirecto}), 0)::numeric AS valor_vendas,
           COUNT(DISTINCT tv.turno_id)::int AS turnos
         FROM turno_vendas tv
         INNER JOIN produtos p ON p.id = tv.produto_id AND p.em_stock_turno IS FALSE AND ${"p.categoria IN ('menu','ingredientes','bebida')"}
         INNER JOIN turnos t ON t.id = tv.turno_id
         LEFT JOIN preco_compra_atual pc ON pc.produto_id = p.id
         WHERE t.data BETWEEN $1::date AND $2::date{HORA_FILTRO} {LOJA_FILTRO}
         GROUP BY p.id, p.nome, p.categoria, p.tipo_medicao, p.venda_por_copo, p.preco, pc.preco_unitario, p.ordem
       )
       SELECT * FROM stock_sales WHERE qtd_vendida > 0 OR valor_vendas > 0
       UNION ALL
       SELECT * FROM direct_sales WHERE qtd_vendida > 0 OR valor_vendas > 0
       ORDER BY categoria, ordem NULLS LAST, produto_nome`;
    const sqlVpH = sqlVp.split('{HORA_FILTRO}').join(horaSql);
    const r = await queryEmpresa(
      sqlVpH.split('{LOJA_FILTRO}').join('AND t.loja_id = $3'), [d1, d2, lojaDe(req)],
      sqlVpH.split('{LOJA_FILTRO}').join(''), [d1, d2]
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
      `SELECT tv.*, p.nome as produto_nome, p.preco, p.venda_por_copo, p.kg_por_copo, p.preco_copos_pacote, p.qtd_copos_pacote
       FROM turno_vendas tv JOIN produtos p ON tv.produto_id=p.id
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
    /** Por copo ou por unidade — ambos no balcão; stock actualizado como nas vendas. */
    return { ok: true };
  }
  if (p.venda_avulso === true && p.categoria !== 'menu' && p.categoria !== 'bebida') return { ok: true };
  return { ok: false, msg: 'Este produto não pode ser vendido em pedido ao balcão' };
}

const TIPOS_PAGAMENTO_PEDIDO = ['dinheiro', 'tpa', 'transferencia', 'mbway', 'outro'];

/** Popularidade dos produtos: total pedido (soma de quantidades) por
 *  produto em TODOS os turnos. Usado para ordenar os tiles em Pedidos
 *  ao balcão pelos mais solicitados. */
app.get('/api/pedidos/popularidade', auth, async (req, res) => {
  try {
    await ensureTurnoPedidos();
    const r = await query(
      `SELECT tpl.produto_id::text AS produto_id,
              COALESCE(SUM(tpl.quantidade),0) AS total_qtd,
              COUNT(*) AS n_linhas
       FROM turno_pedido_linhas tpl
       GROUP BY tpl.produto_id`
    );
    res.json(r.rows.map((row) => ({
      produto_id: row.produto_id,
      total_qtd: parseFloat(row.total_qtd) || 0,
      n_linhas: parseInt(row.n_linhas, 10) || 0
    })));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/turnos/:id/pedidos', auth, async (req, res) => {
  try {
    await ensureTurnoPedidos();
    await ensureTurnoPedidosEntrega();
    const hasDev = await qtdDevolvidaAvailable();
    const devSel = hasDev ? 'COALESCE(tpl.qtd_devolvida,0)' : '0';
    const turnoId = req.params.id;
    const r = await query(
      `SELECT tp.id, tp.turno_id, tp.cliente_nome, tp.tipo_pagamento, tp.com_entrega, tp.criado_em,
              tp.promotor_id, tp.promotor_modo, tp.promotor_pct_total, tp.operador_id,
              COALESCE(tp.valor_entrega,0) AS valor_entrega,
              COALESCE(tp.comissao_valor,0) AS comissao_valor,
              COALESCE(tp.comissao_valor_potencial,0) AS comissao_valor_potencial,
              u.nome AS promotor_nome,
              t.data AS turno_data, t.nome AS turno_nome,
              EXISTS (
                SELECT 1 FROM escala e
                WHERE e.data = t.data AND e.turno = t.nome
                  AND e.utilizador_id = tp.promotor_id::text
              ) AS promotor_tem_escala,
              EXISTS (
                SELECT 1 FROM turno_equipa_real er
                WHERE er.turno_id = tp.turno_id
                  AND er.utilizador_id = tp.promotor_id::text
              ) AS promotor_clocked_in,
              tpl.id AS linha_id, tpl.produto_id, tpl.quantidade,
              ${devSel} AS quantidade_devolvida,
              p.nome AS produto_nome, p.preco, p.venda_por_copo, p.kg_por_copo,
              p.preco_copos_pacote, p.qtd_copos_pacote, COALESCE(p.comissao_pct,0) AS comissao_pct, p.categoria AS produto_categoria
       FROM turno_pedidos tp
       JOIN turnos t ON t.id = tp.turno_id
       LEFT JOIN utilizadores u ON u.id = tp.promotor_id
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
          com_entrega: row.com_entrega === true || row.com_entrega === 't',
          valor_entrega: parseFloat(row.valor_entrega) || 0,
          criado_em: row.criado_em,
          promotor_id: row.promotor_id || null,
          promotor_nome: row.promotor_nome || null,
          promotor_modo: row.promotor_modo || null,
          promotor_pct_total: row.promotor_pct_total == null ? null : parseFloat(row.promotor_pct_total),
          operador_id: row.operador_id || null,
          comissao_valor: parseFloat(row.comissao_valor) || 0,
          comissao_valor_potencial: parseFloat(row.comissao_valor_potencial) || 0,
          promotor_tem_escala: row.promotor_tem_escala === true,
          promotor_clocked_in: row.promotor_clocked_in === true,
          // "A trabalhar" = consta na equipa real do turno (quem realmente
          // trabalhou). Não exige escala (cobre quem cobriu turnos).
          promotor_a_trabalhar: row.promotor_clocked_in === true,
          linhas: []
        });
      }
      if (row.linha_id != null && row.produto_id != null) {
        map.get(row.id).linhas.push({
          produto_id: row.produto_id,
          linha_id: row.linha_id,
          quantidade: parseFloat(row.quantidade),
          quantidade_devolvida: parseFloat(row.quantidade_devolvida) || 0,
          produto_nome: row.produto_nome,
          preco: parseFloat(row.preco) || 0,
          venda_por_copo: row.venda_por_copo,
          kg_por_copo: parseFloat(row.kg_por_copo) || 0,
          preco_copos_pacote: parseFloat(row.preco_copos_pacote) || 0,
          qtd_copos_pacote: parseInt(row.qtd_copos_pacote, 10) || 0,
          comissao_pct: parseFloat(row.comissao_pct) || 0,
          produto_categoria: row.produto_categoria || null
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
      ped.total_artigos_kz = total;
      ped.total_kz = total + (parseFloat(ped.valor_entrega) || 0);
    }
    res.json(list);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/** Lista todos os pedidos de uma data (em todos os turnos). */
app.get('/api/pedidos', auth, async (req, res) => {
  try {
    await ensureTurnoPedidos();
    await ensureTurnoPedidosEntrega();
    const hasDev = await qtdDevolvidaAvailable();
    const devSel = hasDev ? 'COALESCE(tpl.qtd_devolvida,0)' : '0';
    const data = String(req.query.data || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return res.status(400).json({ erro: 'Indica ?data=YYYY-MM-DD' });
    }
    const r = await query(
      `SELECT tp.id, tp.turno_id, t.nome AS turno_nome, t.data::text AS turno_data,
              tp.cliente_nome, tp.tipo_pagamento, tp.com_entrega, tp.criado_em,
              tp.promotor_id, tp.promotor_modo, tp.promotor_pct_total, tp.operador_id,
              COALESCE(tp.valor_entrega,0) AS valor_entrega,
              COALESCE(tp.comissao_valor,0) AS comissao_valor,
              COALESCE(tp.comissao_valor_potencial,0) AS comissao_valor_potencial,
              u.nome AS promotor_nome,
              tpl.id AS linha_id, tpl.produto_id, tpl.quantidade,
              ${devSel} AS quantidade_devolvida,
              p.nome AS produto_nome, p.preco, p.venda_por_copo, p.kg_por_copo,
              p.preco_copos_pacote, p.qtd_copos_pacote, COALESCE(p.comissao_pct,0) AS comissao_pct, p.categoria AS produto_categoria
       FROM turno_pedidos tp
       JOIN turnos t ON t.id = tp.turno_id
       LEFT JOIN utilizadores u ON u.id = tp.promotor_id
       LEFT JOIN turno_pedido_linhas tpl ON tpl.pedido_id = tp.id
       LEFT JOIN produtos p ON p.id = tpl.produto_id
       WHERE t.data = $1::date
       ORDER BY CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 ELSE 9 END,
                tp.criado_em DESC, tpl.id ASC`,
      [data]
    );
    const map = new Map();
    for (const row of r.rows) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          turno_id: row.turno_id,
          turno_nome: row.turno_nome,
          turno_data: row.turno_data,
          cliente_nome: row.cliente_nome,
          tipo_pagamento: row.tipo_pagamento || 'dinheiro',
          com_entrega: row.com_entrega === true || row.com_entrega === 't',
          valor_entrega: parseFloat(row.valor_entrega) || 0,
          criado_em: row.criado_em,
          promotor_id: row.promotor_id || null,
          promotor_nome: row.promotor_nome || null,
          comissao_valor: parseFloat(row.comissao_valor) || 0,
          comissao_valor_potencial: parseFloat(row.comissao_valor_potencial) || 0,
          linhas: []
        });
      }
      if (row.linha_id != null && row.produto_id != null) {
        map.get(row.id).linhas.push({
          produto_id: row.produto_id,
          linha_id: row.linha_id,
          quantidade: parseFloat(row.quantidade),
          quantidade_devolvida: parseFloat(row.quantidade_devolvida) || 0,
          produto_nome: row.produto_nome,
          preco: parseFloat(row.preco) || 0,
          venda_por_copo: row.venda_por_copo,
          kg_por_copo: parseFloat(row.kg_por_copo) || 0,
          preco_copos_pacote: parseFloat(row.preco_copos_pacote) || 0,
          qtd_copos_pacote: parseInt(row.qtd_copos_pacote, 10) || 0,
          comissao_pct: parseFloat(row.comissao_pct) || 0,
          produto_categoria: row.produto_categoria || null
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
      ped.total_artigos_kz = total;
      ped.total_kz = total + (parseFloat(ped.valor_entrega) || 0);
    }
    res.json(list);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

function calcLinhaSubtotal(preco, quantidade, vendaPorCopo, kgPorCopo, qtdCoposPacote, precoCoposPacote) {
  const copo = vendaPorCopo === true && parseFloat(kgPorCopo) > 0;
  if (copo) {
    const c = Math.floor(parseFloat(quantidade) || 0);
    const u = parseFloat(preco) || 0;
    const n = parseInt(qtdCoposPacote, 10) || 0;
    const p = parseFloat(precoCoposPacote) || 0;
    return n >= 2 && p > 0 ? Math.floor(c / n) * p + (c % n) * u : c * u;
  }
  return (parseFloat(quantidade) || 0) * (parseFloat(preco) || 0);
}

/** Devolve 1 unidade de uma linha de pedido. Acumula em qtd_devolvida,
 *  ajusta turno_vendas (subtrai 1), recalcula comissão proporcional ao
 *  total líquido e cria uma saída de caixa com a etiqueta "Devolução —
 *  pedido #N (Produto)". Requer a coluna turno_pedido_linhas.qtd_devolvida. */
app.post('/api/turnos/:turnoId/pedidos/:pedidoId/devolver', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const hasDev = await qtdDevolvidaAvailable();
    if (!hasDev) {
      return res.status(503).json({
        erro: 'Devoluções indisponíveis: a coluna turno_pedido_linhas.qtd_devolvida não existe. Pede ao admin para a criar no SQL Editor do Supabase: ALTER TABLE turno_pedido_linhas ADD COLUMN qtd_devolvida NUMERIC(10,3) NOT NULL DEFAULT 0;'
      });
    }
    await client.query('BEGIN');
    const turnoId = req.params.turnoId;
    const pedidoId = parseInt(req.params.pedidoId, 10);
    const linhaIdRaw = req.body && req.body.linha_id;
    const linhaId = parseInt(linhaIdRaw, 10);
    if (!Number.isFinite(linhaId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'linha_id obrigatório.' });
    }
    // Garante que a linha pertence ao pedido e ao turno.
    const lr = await client.query(
      `SELECT tpl.id, tpl.pedido_id, tpl.produto_id, tpl.quantidade,
              COALESCE(tpl.qtd_devolvida,0) AS qtd_devolvida,
              tp.turno_id, tp.tipo_pagamento, tp.promotor_id,
              tp.promotor_modo, COALESCE(tp.promotor_pct_total,0) AS promotor_pct_total,
              p.nome AS produto_nome, p.preco, p.venda_por_copo, p.kg_por_copo,
              COALESCE(p.qtd_copos_pacote,0) AS qtd_copos_pacote,
              COALESCE(p.preco_copos_pacote,0) AS preco_copos_pacote,
              COALESCE(p.comissao_pct,0) AS comissao_pct
       FROM turno_pedido_linhas tpl
       JOIN turno_pedidos tp ON tp.id = tpl.pedido_id
       JOIN produtos p ON p.id = tpl.produto_id
       WHERE tpl.id = $1 AND tpl.pedido_id = $2 AND tp.turno_id = $3
       FOR UPDATE`,
      [linhaId, pedidoId, turnoId]
    );
    if (!lr.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Linha de pedido não encontrada neste turno.' });
    }
    const ln = lr.rows[0];
    const qtdTotal = parseFloat(ln.quantidade) || 0;
    const qtdDevAntes = parseFloat(ln.qtd_devolvida) || 0;
    const restante = qtdTotal - qtdDevAntes;
    if (restante <= 0.0001) {
      await client.query('ROLLBACK');
      return res.status(409).json({ erro: 'Nada para devolver — todas as unidades desta linha já foram devolvidas.' });
    }
    const passo = 1;
    const qtdDevNova = Math.min(qtdTotal, qtdDevAntes + passo);
    const realmenteDevolvido = qtdDevNova - qtdDevAntes; // pode ser < 1 só na última
    // Calcula o valor estornado: comparando o subtotal da linha ANTES vs
    // DEPOIS (respeitando regra de pacote para copos).
    const calcSub = (qtd) => {
      const isCopo = ln.venda_por_copo === true && parseFloat(ln.kg_por_copo) > 0;
      const u = parseFloat(ln.preco) || 0;
      const n = parseInt(ln.qtd_copos_pacote, 10) || 0;
      const pp = parseFloat(ln.preco_copos_pacote) || 0;
      if (isCopo) {
        const c = Math.floor(qtd);
        return (n >= 2 && pp > 0) ? Math.floor(c / n) * pp + (c % n) * u : c * u;
      }
      return qtd * u;
    };
    const subAntes = calcSub(qtdTotal - qtdDevAntes);
    const subDepois = calcSub(qtdTotal - qtdDevNova);
    const valorDevolvido = Math.max(0, subAntes - subDepois);
    // 1) Actualiza a linha (qtd_devolvida).
    await client.query(
      `UPDATE turno_pedido_linhas SET qtd_devolvida=$1 WHERE id=$2`,
      [qtdDevNova, linhaId]
    );
    // 2) Subtrai a quantidade de turno_vendas.
    const oldRow = await client.query(
      `SELECT quantidade FROM turno_vendas WHERE turno_id=$1 AND produto_id=$2`,
      [turnoId, ln.produto_id]
    );
    const oldQ = oldRow.rows.length ? parseFloat(oldRow.rows[0].quantidade) : 0;
    const novoTotal = Math.max(0, oldQ - realmenteDevolvido);
    await applyTurnoVendaQuantity(client, turnoId, ln.produto_id, novoTotal);
    // 3) Recalcula comissão do pedido com os totais novos (líquidos).
    const linhasPedido = await client.query(
      `SELECT tpl.quantidade, COALESCE(tpl.qtd_devolvida,0) AS qtd_devolvida,
              p.preco, p.venda_por_copo, p.kg_por_copo,
              COALESCE(p.qtd_copos_pacote,0) AS qtd_copos_pacote,
              COALESCE(p.preco_copos_pacote,0) AS preco_copos_pacote,
              COALESCE(p.comissao_pct,0) AS comissao_pct
       FROM turno_pedido_linhas tpl JOIN produtos p ON p.id=tpl.produto_id
       WHERE tpl.pedido_id=$1`,
      [pedidoId]
    );
    let totalPedido = 0;
    let comissaoPotencial = 0;
    for (const l of linhasPedido.rows) {
      const isCopo2 = l.venda_por_copo === true && parseFloat(l.kg_por_copo) > 0;
      const u = parseFloat(l.preco) || 0;
      const n = parseInt(l.qtd_copos_pacote, 10) || 0;
      const pp = parseFloat(l.preco_copos_pacote) || 0;
      const qLiq = Math.max(0, parseFloat(l.quantidade) - parseFloat(l.qtd_devolvida));
      let sub;
      if (isCopo2) {
        const c = Math.floor(qLiq);
        sub = (n >= 2 && pp > 0) ? Math.floor(c / n) * pp + (c % n) * u : c * u;
      } else {
        sub = qLiq * u;
      }
      totalPedido += sub;
      comissaoPotencial += sub * (parseFloat(l.comissao_pct) || 0) / 100;
    }
    let comissaoValor = 0;
    if (ln.promotor_id) {
      const modo = ln.promotor_modo === 'total' ? 'total' : 'produto';
      if (modo === 'total') {
        comissaoValor = totalPedido * (parseFloat(ln.promotor_pct_total) || 0) / 100;
      } else {
        comissaoValor = comissaoPotencial;
      }
    }
    await client.query(
      `UPDATE turno_pedidos SET comissao_valor=$1, comissao_valor_potencial=$2 WHERE id=$3`,
      [Math.round(comissaoValor * 100) / 100, Math.round(comissaoPotencial * 100) / 100, pedidoId]
    );
    // 4) Cria saída de caixa pelo valor devolvido (se > 0).
    if (valorDevolvido > 0.0001) {
      const descricao = `Devolução — pedido #${pedidoId} (${ln.produto_nome})`;
      await client.query(
        `INSERT INTO turno_saidas (turno_id, descricao, valor, notas)
         VALUES ($1,$2,$3,$4)`,
        [turnoId, descricao, Math.round(valorDevolvido * 100) / 100, `Devolução de ${fmtNumPlain(realmenteDevolvido)} unidade(s) ao cliente.`]
      );
      const novasSaida = await calcSaidaTotal(turnoId, client);
      await client.query(`UPDATE turno_caixa SET saida=$1 WHERE turno_id=$2`, [novasSaida, turnoId]);
    }
    await client.query('COMMIT');
    res.json({
      sucesso: true,
      pedido_id: pedidoId,
      linha_id: linhaId,
      qtd_devolvida_total: qtdDevNova,
      qtd_devolvida_agora: realmenteDevolvido,
      valor_devolvido: Math.round(valorDevolvido * 100) / 100,
      comissao_valor: Math.round(comissaoValor * 100) / 100
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

function fmtNumPlain(n) {
  const v = parseFloat(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('pt-AO', { maximumFractionDigits: 3 });
}

/** Idempotência dos pedidos (fila offline): client_ref único por pedido —
 *  reenviar o mesmo pedido devolve o já gravado em vez de duplicar. */
let turnoPedidosClientRefReady = false;
async function ensureTurnoPedidosClientRef() {
  if (turnoPedidosClientRefReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='turno_pedidos_client_ref_v1'`);
    if (r.rows.length) { turnoPedidosClientRefReady = true; return; }
  } catch (_) {}
  await qry(`ALTER TABLE turno_pedidos ADD COLUMN IF NOT EXISTS client_ref TEXT`, [], 'turno_pedidos-client-ref');
  await qry(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turno_pedidos_client_ref ON turno_pedidos(client_ref) WHERE client_ref IS NOT NULL AND client_ref <> ''`, [], 'idx-turno-pedidos-client-ref');
  try {
    const chk = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='turno_pedidos' AND column_name='client_ref'`
    );
    if (chk.rows.length) {
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('turno_pedidos_client_ref_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
      turnoPedidosClientRefReady = true;
    }
  } catch (_) {}
}

app.post('/api/turnos/:id/pedidos', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTurnoPedidos();
    await ensureTurnoPedidosEntrega();
    await ensureTurnoPedidosClientRef();
    const clientRef = String((req.body && req.body.client_ref) || '').trim().slice(0, 64);
    // Já processado (retry da fila offline)? Devolve o existente.
    if (clientRef && turnoPedidosClientRefReady) {
      const dup = await query(`SELECT id, criado_em FROM turno_pedidos WHERE client_ref=$1 LIMIT 1`, [clientRef]);
      if (dup.rows.length) {
        // O finally liberta a ligação — aqui só devolvemos o existente.
        return res.json({ ...dup.rows[0], duplicado: true });
      }
    }
    await client.query('BEGIN');
    const turnoId = parseInt(req.params.id, 10);
    const { cliente_nome, linhas, tipo_pagamento, com_entrega, promotor_id, valor_entrega } = req.body;
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
    const comEntrega =
      com_entrega === true ||
      com_entrega === 1 ||
      String(com_entrega || '').toLowerCase() === 'true' ||
      String(com_entrega || '').toLowerCase() === 'on' ||
      String(com_entrega || '').toLowerCase() === 'sim';
    const vEntrega = comEntrega ? Math.max(0, parseFloat(valor_entrega) || 0) : 0;

    let promotor = null;
    if (promotor_id) {
      const pr = await client.query(
        `SELECT id, nome, COALESCE(comissao_modo,'produto') AS comissao_modo, COALESCE(comissao_pct_total,0) AS comissao_pct_total
         FROM utilizadores WHERE id=$1 AND ativo=true`,
        [promotor_id]
      );
      if (!pr.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'Utilizador inválido ou inactivo.' });
      }
      promotor = pr.rows[0];
    }

    const fpOn = await forcaPacoteAvailable();
    let totalPedido = 0;
    let comissaoPotencial = 0;
    for (const line of normalized) {
      const pr = await client.query(
        `SELECT nome, preco, venda_por_copo, kg_por_copo, qtd_copos_pacote, preco_copos_pacote, ${fpOn ? 'COALESCE(forca_pacote,false)' : 'false'} AS forca_pacote, COALESCE(comissao_pct,0) AS comissao_pct
         FROM produtos WHERE id=$1`,
        [line.produto_id]
      );
      const p = pr.rows[0];
      // Produtos com "Só em lote" exigem quantidade múltipla de qtd_copos_pacote.
      if (p && p.forca_pacote && parseInt(p.qtd_copos_pacote, 10) >= 2) {
        const lote = parseInt(p.qtd_copos_pacote, 10);
        const q = Math.floor(parseFloat(line.quantidade) || 0);
        if (q <= 0 || q % lote !== 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            erro: `«${p.nome}» só pode ser vendido em lotes de ${lote} copos (recebido: ${q}).`
          });
        }
      }
      const sub = calcLinhaSubtotal(p.preco, line.quantidade, p.venda_por_copo, p.kg_por_copo, p.qtd_copos_pacote, p.preco_copos_pacote);
      totalPedido += sub;
      comissaoPotencial += sub * (parseFloat(p.comissao_pct) || 0) / 100;
      line._subtotal = sub;
      line._comissao_pct = parseFloat(p.comissao_pct) || 0;
    }

    let comissaoValor = 0;
    let promotorModo = null;
    let promotorPct = null;
    if (promotor) {
      promotorModo = promotor.comissao_modo === 'total' ? 'total' : 'produto';
      if (promotorModo === 'total') {
        promotorPct = parseFloat(promotor.comissao_pct_total) || 0;
        comissaoValor = totalPedido * promotorPct / 100;
      } else {
        comissaoValor = comissaoPotencial;
      }
    }

    let pedidoIns;
    try {
      pedidoIns = await client.query(
        `INSERT INTO turno_pedidos (turno_id, cliente_nome, tipo_pagamento, com_entrega, valor_entrega, promotor_id, promotor_modo, promotor_pct_total, comissao_valor, comissao_valor_potencial, operador_id${turnoPedidosClientRefReady && clientRef ? ', client_ref' : ''})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${turnoPedidosClientRefReady && clientRef ? ',$12' : ''}) RETURNING id, criado_em`,
        [
          turnoId,
          String(cliente_nome || '').trim().slice(0, 200),
          tpag,
          comEntrega,
          Math.round(vEntrega * 100) / 100,
          promotor ? promotor.id : null,
          promotorModo,
          promotorPct,
          Math.round(comissaoValor * 100) / 100,
          Math.round(comissaoPotencial * 100) / 100,
          req.user && req.user.id ? req.user.id : null,
          ...(turnoPedidosClientRefReady && clientRef ? [clientRef] : [])
        ]
      );
    } catch (eIns) {
      // Corrida entre retries: outro pedido com o mesmo client_ref ganhou.
      if (clientRef && /idx_turno_pedidos_client_ref|client_ref/.test(eIns.message || '')) {
        await client.query('ROLLBACK');
        const dup2 = await query(`SELECT id, criado_em FROM turno_pedidos WHERE client_ref=$1 LIMIT 1`, [clientRef]);
        if (dup2.rows.length) return res.json({ ...dup2.rows[0], duplicado: true });
      }
      throw eIns;
    }
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
    res.json({
      id: pedidoId,
      sucesso: true,
      total_kz: Math.round((totalPedido + vEntrega) * 100) / 100,
      total_artigos_kz: Math.round(totalPedido * 100) / 100,
      valor_entrega: Math.round(vEntrega * 100) / 100,
      comissao_valor: Math.round(comissaoValor * 100) / 100,
      comissao_valor_potencial: Math.round(comissaoPotencial * 100) / 100
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

/**
 * Relatório de comissões.
 * Filtros (query):
 *   - turno_id: limita a um turno específico
 *   - data_de, data_ate: YYYY-MM-DD (intervalo inclusivo) — usa turnos.data
 *   - promotor_id: limita a um promotor específico
 * Retorna:
 *   - linhas (1 por pedido com promotor),
 *   - resumo_por_promotor (agregação),
 *   - separação operador-vs-externo (auto-promoção do operador).
 */
app.get('/api/comissoes', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    await ensureTurnoPedidos();
    const params = [];
    const where = ['tp.promotor_id IS NOT NULL'];
    let whereLojaCom = '';
    try {
      params.push(lojaDe(req));
      whereLojaCom = `t.loja_id = $${params.length}`;
      where.push(whereLojaCom);
    } catch (_) {}
    if (req.query.turno_id) {
      params.push(parseInt(req.query.turno_id, 10));
      where.push(`tp.turno_id = $${params.length}`);
    }
    if (req.query.data_de) {
      params.push(req.query.data_de);
      where.push(`t.data >= $${params.length}::date`);
    }
    if (req.query.data_ate) {
      params.push(req.query.data_ate);
      where.push(`t.data <= $${params.length}::date`);
    }
    if (req.query.promotor_id) {
      params.push(req.query.promotor_id);
      where.push(`tp.promotor_id = $${params.length}`);
    }
    const sql = `
      SELECT tp.id AS pedido_id, tp.turno_id, tp.cliente_nome, tp.criado_em,
             tp.promotor_id, tp.promotor_modo, tp.promotor_pct_total,
             COALESCE(tp.comissao_valor,0) AS comissao_valor,
             COALESCE(tp.comissao_valor_potencial,0) AS comissao_valor_potencial,
             tp.operador_id,
             u.nome AS promotor_nome,
             op.nome AS operador_nome,
             t.data AS turno_data, t.nome AS turno_nome,
             EXISTS (
               SELECT 1 FROM escala e
               WHERE e.data = t.data AND e.turno = t.nome
                 AND e.utilizador_id = tp.promotor_id::text
             ) AS promotor_tem_escala,
             EXISTS (
               SELECT 1 FROM presencas pr
               WHERE pr.utilizador_id = tp.promotor_id
                 AND pr.tipo = 'entrada'
                 AND pr.criado_em::date = t.data
             ) AS promotor_clocked_in,
             (SELECT COALESCE(SUM(
                CASE WHEN p.venda_por_copo = TRUE AND p.kg_por_copo > 0 THEN
                  CASE WHEN COALESCE(p.qtd_copos_pacote,0) >= 2 AND COALESCE(p.preco_copos_pacote,0) > 0
                    THEN FLOOR(FLOOR(tpl.quantidade) / p.qtd_copos_pacote) * p.preco_copos_pacote
                         + (FLOOR(tpl.quantidade) - FLOOR(FLOOR(tpl.quantidade)/p.qtd_copos_pacote)*p.qtd_copos_pacote) * p.preco
                    ELSE FLOOR(tpl.quantidade) * p.preco
                  END
                ELSE tpl.quantidade * p.preco END
              ),0)
              FROM turno_pedido_linhas tpl JOIN produtos p ON p.id=tpl.produto_id
              WHERE tpl.pedido_id = tp.id) AS total_pedido_kz
      FROM turno_pedidos tp
      JOIN turnos t ON t.id = tp.turno_id
      LEFT JOIN utilizadores u ON u.id = tp.promotor_id
      LEFT JOIN utilizadores op ON op.id = tp.operador_id
      WHERE ${where.join(' AND ')}
      ORDER BY tp.criado_em DESC
    `;
    let r;
    try {
      r = await query(sql, params);
    } catch (eL) {
      // BD sem turnos.loja_id (por migrar) — repete sem o filtro de loja
      // (a condição vira sempre-verdadeira mantendo o parâmetro referenciado).
      if (!/loja_id/.test(String(eL.message || '')) || !whereLojaCom) throw eL;
      const semLoja = whereLojaCom.replace('t.loja_id = ', '') + '::int IS NOT NULL';
      r = await query(sql.replace(whereLojaCom, semLoja), params);
    }
    const linhas = r.rows.map(row => {
      const auto = row.promotor_id && row.operador_id && row.promotor_id === row.operador_id;
      const temEscala = row.promotor_tem_escala === true;
      const clockedIn = row.promotor_clocked_in === true;
      // "A trabalhar" = consta na equipa real do turno (quem realmente
      // trabalhou); não exige escala.
      const aTrabalhar = clockedIn;
      return {
        pedido_id: row.pedido_id,
        turno_id: row.turno_id,
        turno_data: row.turno_data,
        turno_nome: row.turno_nome,
        cliente_nome: row.cliente_nome,
        criado_em: row.criado_em,
        promotor_id: row.promotor_id,
        promotor_nome: row.promotor_nome,
        promotor_modo: row.promotor_modo,
        promotor_pct_total: row.promotor_pct_total == null ? null : parseFloat(row.promotor_pct_total),
        operador_id: row.operador_id,
        operador_nome: row.operador_nome,
        total_pedido_kz: parseFloat(row.total_pedido_kz) || 0,
        comissao_valor: parseFloat(row.comissao_valor) || 0,
        comissao_valor_potencial: parseFloat(row.comissao_valor_potencial) || 0,
        auto_promocao: !!auto,
        promotor_tem_escala: temEscala,
        promotor_clocked_in: clockedIn,
        promotor_a_trabalhar: aTrabalhar
      };
    });
    const map = new Map();
    for (const l of linhas) {
      const key = l.promotor_id + '|' + (l.auto_promocao ? '1' : '0');
      if (!map.has(key)) {
        map.set(key, {
          promotor_id: l.promotor_id,
          promotor_nome: l.promotor_nome,
          auto_promocao: l.auto_promocao,
          n_pedidos: 0,
          total_vendido_kz: 0,
          comissao_total_kz: 0,
          comissao_a_revisar_kz: 0,
          n_a_trabalhar: 0
        });
      }
      const a = map.get(key);
      a.n_pedidos += 1;
      a.total_vendido_kz += l.total_pedido_kz;
      a.comissao_total_kz += l.comissao_valor;
      if (l.promotor_a_trabalhar) {
        a.comissao_a_revisar_kz += l.comissao_valor;
        a.n_a_trabalhar += 1;
      }
    }
    const resumo = [...map.values()].sort((a, b) => b.comissao_total_kz - a.comissao_total_kz);
    res.json({
      linhas,
      resumo_por_promotor: resumo,
      totais: {
        comissao_externa: resumo.filter(x => !x.auto_promocao).reduce((s, x) => s + x.comissao_total_kz, 0),
        comissao_operadores: resumo.filter(x => x.auto_promocao).reduce((s, x) => s + x.comissao_total_kz, 0),
        comissao_total: resumo.reduce((s, x) => s + x.comissao_total_kz, 0),
        comissao_a_revisar: linhas.filter(l => l.promotor_a_trabalhar).reduce((s, l) => s + l.comissao_valor, 0),
        n_a_revisar: linhas.filter(l => l.promotor_a_trabalhar).length
      }
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/turnos/:id/vendas', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const turnoId = req.params.id;
    const { produto_id, quantidade } = req.body;

    const prodRow = await client.query(
      `SELECT venda_por_copo, kg_por_copo FROM produtos WHERE id=$1`,
      [produto_id]
    );
    if (!prodRow.rows.length) throw new Error('Produto não encontrado');
    const vendeCopo =
      prodRow.rows[0].venda_por_copo === true && parseFloat(prodRow.rows[0].kg_por_copo) > 0;
    const kgPorCopo = parseFloat(prodRow.rows[0].kg_por_copo) || 0;

    const qtyCopos = vendeCopo
      ? Math.max(0, Math.floor(parseFloat(quantidade) || 0))
      : parseFloat(quantidade) || 0;

    const old = await client.query(
      'SELECT quantidade FROM turno_vendas WHERE turno_id=$1 AND produto_id=$2',
      [turnoId, produto_id]
    );
    const oldQty = old.rows.length ? parseFloat(old.rows[0].quantidade) : 0;
    const delta = qtyCopos - oldQty;

    // Upsert sem ON CONFLICT (ver applyTurnoVendaQuantity).
    if (old.rows.length) {
      await client.query(
        `UPDATE turno_vendas SET quantidade=$3 WHERE turno_id=$1 AND produto_id=$2`,
        [turnoId, produto_id, qtyCopos]
      );
    } else {
      await client.query(
        `INSERT INTO turno_vendas (turno_id,produto_id,quantidade) VALUES ($1,$2,$3)`,
        [turnoId, produto_id, qtyCopos]
      );
    }

    if (delta !== 0) {
      if (vendeCopo) {
        const kgDelta = delta * kgPorCopo;
        await client.query(
          `UPDATE turno_stock SET deixado=GREATEST(0, deixado - $1)
           WHERE turno_id=$2 AND produto_id=$3`,
          [kgDelta, turnoId, produto_id]
        );
      } else {
        // Expand recipe recursively: if a component itself has a recipe, use its ingredients instead
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
            `UPDATE turno_stock SET deixado=GREATEST(0, deixado - $1)
             WHERE turno_id=$2 AND produto_id=$3`,
            [qtd, turnoId, compId]
          );
        }
      }
    }

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
    await ensureUtilizadoresFicha();
    const base = "id,email,nome,username,role,ativo, face_descriptor IS NOT NULL AS has_face, COALESCE(face_foto_url,'') AS face_foto_url, COALESCE(promotor,false) AS promotor, comissao_modo, COALESCE(comissao_pct_total,0) AS comissao_pct_total";
    // Dados financeiros (salário base, IBAN) só para administradores.
    const isAdminReq = req.user && req.user.role === 'admin';
    const fin = isAdminReq ? ", salario_base, COALESCE(iban,'') AS iban" : "";
    const ficha = ", COALESCE(telefone,'') AS telefone, COALESCE(bi,'') AS bi, COALESCE(morada,'') AS morada, data_nascimento::text AS data_nascimento, data_admissao::text AS data_admissao" + fin + ", COALESCE(contacto_emergencia,'') AS contacto_emergencia, COALESCE(notas_funcionario,'') AS notas_funcionario, loja_id, empresa_id";
    const emp = empresaDe(req);
    const todosDaEmpresa = req.query.todos === '1';
    let r;
    try {
      r = todosDaEmpresa
        ? await query(`SELECT ${base}${ficha} FROM utilizadores WHERE empresa_id=$1 ORDER BY nome`, [emp])
        : await query(`SELECT ${base}${ficha} FROM utilizadores WHERE empresa_id=$1 AND (loja_id IS NULL OR loja_id=$2) ORDER BY nome`, [emp, lojaDe(req)]);
    } catch (_) {
      // BD sem as colunas da ficha/empresa (por migrar) — lista na mesma.
      r = await query(`SELECT ${base} FROM utilizadores ORDER BY nome`);
    }
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Equipa — todos os utilizadores activos/inactivos, para qualquer role autenticado registar/atualizar face. */
app.get('/api/equipa', auth, requireRole('admin','gestor','operador','compras'), async (req, res) => {
  try {
    await ensureUsernameColumn();
    const selEq = "SELECT id,email,nome,username,role,ativo, face_descriptor IS NOT NULL AS has_face, COALESCE(face_foto_url,'') AS face_foto_url, COALESCE(promotor,false) AS promotor, loja_id FROM utilizadores";
    const selEqSem = selEq.replace(', loja_id FROM', ' FROM');
    const r = await queryEmpresa(
      `${selEq} WHERE empresa_id=$1 AND (loja_id IS NULL OR loja_id=$2) ORDER BY nome`, [empresaDe(req), lojaDe(req)],
      `${selEqSem} WHERE empresa_id=$1 ORDER BY nome`, [empresaDe(req)]
    ).catch(() => query(`${selEqSem} ORDER BY nome`, []));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Promotores activos — usado no dropdown de pedido balcão. */
app.get('/api/promotores', auth, async (req, res) => {
  try {
    const selProm = "SELECT id, nome, username, COALESCE(comissao_modo,'produto') AS comissao_modo, COALESCE(comissao_pct_total,0) AS comissao_pct_total FROM utilizadores WHERE ativo=true";
    const r = await queryEmpresa(
      `${selProm} AND empresa_id=$1 ORDER BY nome`, [empresaDe(req)],
      `${selProm} ORDER BY nome`, []
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── Ficha do funcionário: dados pessoais/contratuais em utilizadores ──
let utilizadoresFichaReady = false;
const UTILIZADORES_FICHA_COLS = ['telefone', 'bi', 'morada', 'data_nascimento', 'data_admissao', 'salario_base', 'iban', 'contacto_emergencia', 'notas_funcionario'];
async function ensureUtilizadoresFicha() {
  if (utilizadoresFichaReady) return;
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='utilizadores_ficha_ddl_v1'`);
    if (r.rows.length) { utilizadoresFichaReady = true; return; }
  } catch (_) {}
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS telefone TEXT NOT NULL DEFAULT ''`, [], 'utilizadores-telefone');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS bi TEXT NOT NULL DEFAULT ''`, [], 'utilizadores-bi');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS morada TEXT NOT NULL DEFAULT ''`, [], 'utilizadores-morada');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS data_nascimento DATE`, [], 'utilizadores-data-nascimento');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS data_admissao DATE`, [], 'utilizadores-data-admissao');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS salario_base NUMERIC(15,2)`, [], 'utilizadores-salario-base');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS iban TEXT NOT NULL DEFAULT ''`, [], 'utilizadores-iban');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS contacto_emergencia TEXT NOT NULL DEFAULT ''`, [], 'utilizadores-contacto-emergencia');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS notas_funcionario TEXT NOT NULL DEFAULT ''`, [], 'utilizadores-notas-funcionario');
  // Só marca como feito se as colunas existirem mesmo (o ALTER pode falhar
  // em silêncio quando o role da app não é owner da tabela).
  try {
    const chk = await query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_schema='public' AND table_name='utilizadores' AND column_name = ANY($1::text[])`,
      [UTILIZADORES_FICHA_COLS]
    );
    if ((chk.rows[0] && chk.rows[0].n) === UTILIZADORES_FICHA_COLS.length) {
      await query(`INSERT INTO stockos_meta (k,v) VALUES ('utilizadores_ficha_ddl_v1','done') ON CONFLICT (k) DO NOTHING`).catch(() => {});
      utilizadoresFichaReady = true;
    }
  } catch (_) {}
}

/** Actualiza os campos da ficha (se as colunas existirem). Devolve aviso em
 *  vez de rebentar quando a BD ainda não foi migrada.
 *  Dados FINANCEIROS (salário base e IBAN) só podem ser alterados por
 *  administradores — para outros roles são ignorados. */
async function updateFichaFuncionario(userId, body, role) {
  if (role !== 'admin') {
    body = { ...body };
    delete body.salario_base;
    delete body.iban;
  }
  const vals = {
    telefone: body.telefone != null ? String(body.telefone).trim() : null,
    bi: body.bi != null ? String(body.bi).trim() : null,
    morada: body.morada != null ? String(body.morada).trim() : null,
    data_nascimento: body.data_nascimento ? String(body.data_nascimento).slice(0, 10) : null,
    data_admissao: body.data_admissao ? String(body.data_admissao).slice(0, 10) : null,
    salario_base: body.salario_base != null && body.salario_base !== '' ? (parseFloat(body.salario_base) || 0) : null,
    iban: body.iban != null ? String(body.iban).trim() : null,
    contacto_emergencia: body.contacto_emergencia != null ? String(body.contacto_emergencia).trim() : null,
    notas_funcionario: body.notas_funcionario != null ? String(body.notas_funcionario).trim() : null
  };
  const temAlgum = UTILIZADORES_FICHA_COLS.some((c) => body[c] !== undefined);
  if (!temAlgum) return null;
  await ensureUtilizadoresFicha();
  try {
    await query(
      `UPDATE utilizadores SET
         telefone = COALESCE($1, telefone),
         bi = COALESCE($2, bi),
         morada = COALESCE($3, morada),
         data_nascimento = CASE WHEN $4::text IS NOT NULL THEN NULLIF($4,'')::date ELSE data_nascimento END,
         data_admissao = CASE WHEN $5::text IS NOT NULL THEN NULLIF($5,'')::date ELSE data_admissao END,
         salario_base = COALESCE($6, salario_base),
         iban = COALESCE($7, iban),
         contacto_emergencia = COALESCE($8, contacto_emergencia),
         notas_funcionario = COALESCE($9, notas_funcionario)
       WHERE id = $10`,
      [vals.telefone, vals.bi, vals.morada,
       body.data_nascimento !== undefined ? String(body.data_nascimento || '') : null,
       body.data_admissao !== undefined ? String(body.data_admissao || '') : null,
       vals.salario_base, vals.iban, vals.contacto_emergencia, vals.notas_funcionario, userId]
    );
    return null;
  } catch (e) {
    if (/column .* does not exist/i.test(e.message || '')) {
      return 'A ficha do funcionário não foi gravada: colunas em falta na BD. Corre o workflow «Reparar schema develop» no GitHub Actions.';
    }
    throw e;
  }
}

app.post('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureUsernameColumn();
    const { email, nome, role, username } = req.body;
    if (!nome || !String(nome).trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
    // Password inicial OPCIONAL — funcionários sem acesso ao sistema ficam
    // registados sem password e NUNCA conseguem iniciar sessão (não existe
    // password padrão). Quando indicada, tem de ter pelo menos 6 caracteres.
    const passRaw = String((req.body && req.body.password) || '').trim();
    if (passRaw && passRaw.length < 6) {
      return res.status(400).json({ erro: 'A password inicial deve ter pelo menos 6 caracteres.' });
    }
    // Nome de utilizador OPCIONAL — validado só quando indicado.
    const un = normalizeUsername(username);
    if (un) {
      if (!isValidUsername(un)) {
        return res.status(400).json({ erro: 'Nome de utilizador: 3 a 50 caracteres (letras minúsculas, números, . _ -)' });
      }
      const dup = await query('SELECT id FROM utilizadores WHERE LOWER(username)=LOWER($1)', [un]);
      if (dup.rows.length) return res.status(400).json({ erro: 'Nome de utilizador já em uso' });
    }
    // Email OPCIONAL. A coluna é NOT NULL UNIQUE, por isso sem email
    // guarda-se um placeholder único @stockos.local (escondido na UI).
    let emailFinal = String(email || '').trim();
    if (emailFinal) {
      const dupE = await query('SELECT id FROM utilizadores WHERE LOWER(email)=LOWER($1)', [emailFinal]);
      if (dupE.rows.length) return res.status(400).json({ erro: 'Email já em uso' });
    } else {
      emailFinal = `sem-email-${crypto.randomBytes(4).toString('hex')}@stockos.local`;
    }
    // Empresa de DESTINO: o admin escolhe-a no formulário (por defeito, a
    // empresa efectiva). A loja fixa tem de pertencer a essa empresa —
    // validado ANTES de criar a conta.
    const empBody = parseInt((req.body && req.body.empresa_id) || '', 10);
    const empresaDestino = Number.isFinite(empBody) && empBody > 0 ? empBody : empresaDe(req);
    const lojaFixa = req.body.loja_id != null && String(req.body.loja_id).trim() !== '' ? (parseInt(req.body.loja_id, 10) || null) : null;
    if (lojaFixa) {
      const lv = await query('SELECT 1 FROM lojas WHERE id=$1 AND empresa_id=$2', [lojaFixa, empresaDestino]).catch(() => null);
      if (lv && !lv.rows.length) {
        return res.status(400).json({ erro: 'A loja fixa escolhida não pertence à empresa seleccionada.' });
      }
    }
    const r = await query(
      'INSERT INTO utilizadores (email,nome,username,role,senha_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id,email,nome,username,role',
      [emailFinal, String(nome).trim(), un || null, role || 'operador', passRaw ? hashPassword(passRaw) : '']
    );
    try {
      await query(`UPDATE utilizadores SET empresa_id=$1, loja_id=$2 WHERE id=$3`, [empresaDestino, lojaFixa, r.rows[0].id]);
    } catch (_) { /* BD antiga sem colunas */ }
    const aviso = await updateFichaFuncionario(r.rows[0].id, req.body || {}, req.user && req.user.role);
    const semCredenciais = !un && emailFinal.endsWith('@stockos.local');
    const avisoLogin = semCredenciais
      ? 'Sem nome de utilizador nem email — este funcionário não consegue iniciar sessão até definires um deles.'
      : (!passRaw ? 'Sem password definida — este funcionário não consegue iniciar sessão até lhe definires uma (Editar → Nova Password).' : '');
    res.json({
      ...r.rows[0],
      ...(avisoLogin ? { aviso_login: avisoLogin } : {}),
      ...(aviso ? { aviso } : {})
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/utilizadores/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const chkU = await queryEmpresa(
      `SELECT 1 FROM utilizadores WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT 1 FROM utilizadores WHERE id=$1`, [req.params.id]
    );
    if (!chkU.rows.length) return res.status(404).json({ erro: 'Utilizador não encontrado' });

    await ensureUsernameColumn();
    const { nome, role, ativo, password, username, promotor, comissao_modo, comissao_pct_total } = req.body;
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
    const isPromotor = !!promotor;
    let modo = null;
    if (isPromotor) {
      modo = comissao_modo === 'total' ? 'total' : (comissao_modo === 'produto' ? 'produto' : null);
    }
    const pctTotal = Math.max(0, Math.min(100, parseFloat(comissao_pct_total) || 0));
    const r = un
      ? await query(
          'UPDATE utilizadores SET nome=$1,role=$2,ativo=$3,username=$4,promotor=$5,comissao_modo=$6,comissao_pct_total=$7 WHERE id=$8 RETURNING id,email,nome,username,role,ativo,promotor,comissao_modo,comissao_pct_total',
          [nome, role, ativo, un, isPromotor, modo, pctTotal, req.params.id]
        )
      : await query(
          'UPDATE utilizadores SET nome=$1,role=$2,ativo=$3,promotor=$4,comissao_modo=$5,comissao_pct_total=$6 WHERE id=$7 RETURNING id,email,nome,username,role,ativo,promotor,comissao_modo,comissao_pct_total',
          [nome, role, ativo, isPromotor, modo, pctTotal, req.params.id]
        );
    // Empresa (o admin pode movê-la) + loja fixa ('' → NULL). A loja tem
    // de pertencer à empresa de destino.
    if (req.body.loja_id !== undefined || req.body.empresa_id !== undefined) {
      try {
        const atual = await query('SELECT empresa_id, loja_id FROM utilizadores WHERE id=$1', [req.params.id]);
        const empBody = parseInt((req.body && req.body.empresa_id) || '', 10);
        const empresaDestino = Number.isFinite(empBody) && empBody > 0
          ? empBody
          : ((atual.rows[0] && atual.rows[0].empresa_id) || empresaDe(req));
        let lojaFixa = req.body.loja_id !== undefined
          ? (String(req.body.loja_id).trim() !== '' ? (parseInt(req.body.loja_id, 10) || null) : null)
          : (atual.rows[0] ? atual.rows[0].loja_id : null);
        if (lojaFixa) {
          const lv = await query('SELECT 1 FROM lojas WHERE id=$1 AND empresa_id=$2', [lojaFixa, empresaDestino]).catch(() => null);
          if (lv && !lv.rows.length) {
            if (req.body.loja_id !== undefined) {
              return res.status(400).json({ erro: 'A loja fixa escolhida não pertence à empresa seleccionada.' });
            }
            lojaFixa = null; // loja herdada da empresa antiga — limpa
          }
        }
        await query(`UPDATE utilizadores SET empresa_id=$1, loja_id=$2 WHERE id=$3`, [empresaDestino, lojaFixa, req.params.id]);
      } catch (_) { /* BD antiga sem colunas */ }
    }
    const aviso = await updateFichaFuncionario(req.params.id, req.body || {}, req.user && req.user.role);
    res.json(aviso ? { ...r.rows[0], aviso } : r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── AVISOS: orientações visíveis a todos os turnos/utilizadores ───────
let avisosReady = false;
async function ensureAvisos() {
  if (avisosReady) return;
  await query(`CREATE TABLE IF NOT EXISTS avisos (
    id SERIAL PRIMARY KEY,
    empresa_id INTEGER NOT NULL DEFAULT 1,
    loja_id INTEGER,
    texto TEXT NOT NULL,
    criado_por TEXT NOT NULL DEFAULT '',
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valido_ate TIMESTAMPTZ
  )`).catch(() => {});
  await query(`ALTER TABLE avisos ADD COLUMN IF NOT EXISTS valido_ate TIMESTAMPTZ`).catch(() => {});
  avisosReady = true;
}

app.get('/api/avisos', auth, async (req, res) => {
  try {
    await ensureAvisos();
    // todos=1 → histórico completo (expirados incluídos; removidos só
    // para admin/gestor). Sem o parâmetro → só os activos dentro do prazo.
    const todos = req.query.todos === '1';
    const gerir = ['admin', 'gestor'].includes(req.user && req.user.role);
    const filtro = todos
      ? (gerir ? '' : 'AND ativo IS TRUE')
      : `AND ativo IS TRUE AND (valido_ate IS NULL OR valido_ate > NOW())`;
    const r = await query(
      `SELECT * FROM avisos
       WHERE empresa_id=$1 AND (loja_id IS NULL OR loja_id=$2) ${filtro}
       ORDER BY criado_em DESC LIMIT ${todos ? 200 : 30}`,
      [empresaDe(req), lojaDe(req)]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/avisos', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    await ensureAvisos();
    const texto = String((req.body && req.body.texto) || '').trim();
    if (!texto) return res.status(400).json({ erro: 'Escreve o texto do aviso.' });
    // Validade: o aviso fica SEMPRE visível durante N dias (1–90; 7 por
    // defeito) e depois desaparece sozinho.
    const dias = Math.min(90, Math.max(1, parseInt(req.body.dias, 10) || 7));
    const r = await query(
      `INSERT INTO avisos (empresa_id, loja_id, texto, criado_por, valido_ate)
       VALUES ($1,$2,$3,$4, NOW() + ($5 || ' days')::interval) RETURNING *`,
      [empresaDe(req), req.body.so_esta_loja === true ? lojaDe(req) : null, texto.slice(0, 2000), (req.user && req.user.nome) || '', String(dias)]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/avisos/:id', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    await ensureAvisos();
    await query(`UPDATE avisos SET ativo=FALSE WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MONITORAMENTO (admin): aparelhos, últimos logins, fila offline ────
let monitorReady = false;
async function ensureMonitorDispositivos() {
  if (monitorReady) return;
  await query(`CREATE TABLE IF NOT EXISTS monitor_dispositivos (
    id SERIAL PRIMARY KEY,
    utilizador_id UUID NOT NULL REFERENCES utilizadores(id) ON DELETE CASCADE,
    dispositivo_id TEXT NOT NULL,
    descricao TEXT NOT NULL DEFAULT '',
    ultimo_login TIMESTAMPTZ,
    ultima_operacao TIMESTAMPTZ,
    pendentes INTEGER NOT NULL DEFAULT 0,
    visto_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    empresa_id INTEGER,
    loja_id INTEGER,
    UNIQUE (utilizador_id, dispositivo_id)
  )`).catch(() => {});
  await query(`ALTER TABLE monitor_dispositivos ADD COLUMN IF NOT EXISTS empresa_id INTEGER`).catch(() => {});
  await query(`ALTER TABLE monitor_dispositivos ADD COLUMN IF NOT EXISTS loja_id INTEGER`).catch(() => {});
  await query(`ALTER TABLE monitor_dispositivos ADD COLUMN IF NOT EXISTS nome TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await query(`ALTER TABLE monitor_dispositivos ADD COLUMN IF NOT EXISTS versao TEXT NOT NULL DEFAULT ''`).catch(() => {});
  monitorReady = true;
}

/** Nome dado pelo admin ao aparelho (ex.: «Balcão 1») — aplica-se ao
 *  aparelho inteiro, em todas as contas que o usam. */
app.put('/api/monitor/dispositivo', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureMonitorDispositivos();
    const disp = String((req.body && req.body.dispositivo_id) || '').slice(0, 64);
    if (!disp) return res.status(400).json({ erro: 'dispositivo_id em falta' });
    const nome = String((req.body && req.body.nome) || '').trim().slice(0, 60);
    const r = await queryEmpresa(
      `UPDATE monitor_dispositivos SET nome=$1 WHERE dispositivo_id=$2
         AND utilizador_id IN (SELECT id FROM utilizadores WHERE empresa_id=$3) RETURNING id`,
      [nome, disp, empresaDe(req)],
      `UPDATE monitor_dispositivos SET nome=$1 WHERE dispositivo_id=$2 RETURNING id`,
      [nome, disp]
    );
    res.json({ ok: true, linhas: r.rows.length, nome });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

/** Sinal de vida de cada aparelho (a fila offline vive no aparelho — só o
 *  próprio cliente sabe quantos registos tem por sincronizar). */
app.post('/api/monitor/heartbeat', auth, async (req, res) => {
  try {
    await ensureMonitorDispositivos();
    const b = req.body || {};
    const disp = String(b.dispositivo_id || '').slice(0, 64);
    if (!disp) return res.json({ ok: false });
    const desc = String(b.descricao || '').slice(0, 120);
    const pend = Math.max(0, parseInt(b.pendentes, 10) || 0);
    const ultOpRaw = b.ultima_operacao ? new Date(b.ultima_operacao) : null;
    const ultOp = ultOpRaw && !isNaN(ultOpRaw.getTime()) ? ultOpRaw.toISOString() : null;
    const ehLogin = b.login === true;
    const empHb = parseInt(b.empresa_id, 10) || empresaDe(req);
    const lojaHb = parseInt(b.loja_id, 10) || lojaDe(req);
    const versaoHb = String(b.versao || '').slice(0, 80);
    await query(
      `INSERT INTO monitor_dispositivos (utilizador_id, dispositivo_id, descricao, ultimo_login, ultima_operacao, pendentes, visto_em, empresa_id, loja_id, versao)
       VALUES ($1,$2,$3, CASE WHEN $4 THEN NOW() END, $5, $6, NOW(), $7, $8, $9)
       ON CONFLICT (utilizador_id, dispositivo_id) DO UPDATE SET
         descricao = EXCLUDED.descricao,
         ultimo_login = CASE WHEN $4 THEN NOW() ELSE monitor_dispositivos.ultimo_login END,
         ultima_operacao = COALESCE(EXCLUDED.ultima_operacao, monitor_dispositivos.ultima_operacao),
         pendentes = EXCLUDED.pendentes,
         visto_em = NOW(),
         empresa_id = EXCLUDED.empresa_id,
         loja_id = EXCLUDED.loja_id,
         versao = CASE WHEN EXCLUDED.versao <> '' THEN EXCLUDED.versao ELSE monitor_dispositivos.versao END`,
      [req.user.id, disp, desc, ehLogin, ultOp, pend, empHb, lojaHb, versaoHb]
    );
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

/** Página Monitoramento: utilizadores da empresa com os seus aparelhos. */
app.get('/api/monitor', auth, requireRole('admin'), async (req, res) => {
  try {
    await ensureMonitorDispositivos();
    const sel = `SELECT u.id, u.nome, u.role, u.ativo,
            m.dispositivo_id, m.descricao, COALESCE(m.nome,'') AS dispositivo_nome, COALESCE(m.versao,'') AS versao, m.ultimo_login, m.ultima_operacao, m.pendentes, m.visto_em,
            m.empresa_id AS hb_empresa_id, m.loja_id AS hb_loja_id,
            e.nome AS empresa_nome, l.nome AS loja_nome
       FROM utilizadores u
       LEFT JOIN monitor_dispositivos m ON m.utilizador_id = u.id
       LEFT JOIN empresas e ON e.id = m.empresa_id
       LEFT JOIN lojas l ON l.id = m.loja_id`;
    const r = await queryEmpresa(
      `${sel} WHERE u.empresa_id = $1 ORDER BY u.nome, m.visto_em DESC NULLS LAST`, [empresaDe(req)],
      `${sel} ORDER BY u.nome, m.visto_em DESC NULLS LAST`, []
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── PRESENÇAS / RECONHECIMENTO FACIAL ────────────────────────
async function ensurePresencas() {
  if (presencasReady) return;
  // Fast path: meta flag set by a previous successful run
  try {
    const r = await query(`SELECT v FROM stockos_meta WHERE k='presencas_ddl_v1'`);
    if (r.rows.length) { presencasReady = true; return; }
  } catch (_) {}
  try {
    await withAdvisoryLock(7654321006, async () => {
      // Re-check inside lock
      try {
        const r2 = await query(`SELECT v FROM stockos_meta WHERE k='presencas_ddl_v1'`);
        if (r2.rows.length) { presencasReady = true; return; }
      } catch (_) {}
      await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS face_descriptor JSONB`, [], 'utilizadores-face-descriptor');
      await qry(`CREATE TABLE IF NOT EXISTS presencas (
        id SERIAL PRIMARY KEY,
        utilizador_id UUID NOT NULL REFERENCES utilizadores(id) ON DELETE CASCADE,
        tipo VARCHAR(10) NOT NULL CHECK (tipo IN ('entrada', 'saida')),
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`, [], 'presencas');
      await qry(`CREATE INDEX IF NOT EXISTS idx_presencas_criado ON presencas(criado_em DESC)`, [], 'idx-presencas-criado');
      await qry(`INSERT INTO stockos_meta(k,v) VALUES('presencas_ddl_v1','done') ON CONFLICT(k) DO UPDATE SET v='done'`, [], 'presencas-meta');
      presencasReady = true;
    });
    presencasReady = true; // if lock not acquired, another instance is running DDL — treat as ready
  } catch (e) {
    console.warn('[ensurePresencas]', e && e.message);
  }
}

/** Descritores faciais dos utilizadores activos (sem auth — necessário no
 *  ecrã de presença). Isolado por empresa: o quiosque envia ?loja= e a
 *  empresa deriva do mapa loja→empresa. */
app.get('/api/face-descriptors', async (req, res) => {
  try {
    await dbReady;
    let emp = null;
    try {
      const qL = parseInt(req.query && req.query.loja, 10);
      if (Number.isFinite(qL) && qL > 0) {
        const mapa = await mapaLojaEmpresa();
        if (mapa && mapa[String(qL)] != null) emp = mapa[String(qL)];
      }
    } catch (_) {}
    const r = emp != null
      ? await queryEmpresa(
          `SELECT id, nome, face_descriptor FROM utilizadores WHERE ativo=true AND face_descriptor IS NOT NULL AND empresa_id=$1`, [emp],
          `SELECT id, nome, face_descriptor FROM utilizadores WHERE ativo=true AND face_descriptor IS NOT NULL`, []
        )
      : await query(`SELECT id, nome, face_descriptor FROM utilizadores WHERE ativo=true AND face_descriptor IS NOT NULL`);
    res.json(r.rows.map(u => ({ id: u.id, nome: u.nome, descriptor: u.face_descriptor })));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Guardar descritor facial — qualquer utilizador autenticado pode registar (próprio ou de outro). */
app.put('/api/utilizadores/:id/face-descriptor', auth, async (req, res) => {
  try {
    const chkU = await queryEmpresa(
      `SELECT 1 FROM utilizadores WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT 1 FROM utilizadores WHERE id=$1`, [req.params.id]
    );
    if (!chkU.rows.length) return res.status(404).json({ erro: 'Utilizador não encontrado' });

    const { descriptor, foto_base64 } = req.body;
    if (!Array.isArray(descriptor) || descriptor.length !== 128) {
      return res.status(400).json({ erro: 'Descritor inválido (array de 128 números)' });
    }
    let fotoUrl = null;
    if (foto_base64) {
      const parsed = parseDataUrlFoto(foto_base64);
      if (parsed) fotoUrl = await uploadFaceFotoToSupabase(parsed.buffer, req.params.id, parsed.contentType, parsed.ext).catch(() => null);
    }
    if (fotoUrl) {
      await query(`UPDATE utilizadores SET face_descriptor=$1::jsonb, face_foto_url=$2 WHERE id=$3`, [JSON.stringify(descriptor), fotoUrl, req.params.id]);
    } else {
      await query(`UPDATE utilizadores SET face_descriptor=$1::jsonb WHERE id=$2`, [JSON.stringify(descriptor), req.params.id]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Remover descritor facial — qualquer utilizador autenticado pode remover. */
app.delete('/api/utilizadores/:id/face-descriptor', auth, async (req, res) => {
  try {
    const chkU = await queryEmpresa(
      `SELECT 1 FROM utilizadores WHERE id=$1 AND empresa_id=$2`, [req.params.id, empresaDe(req)],
      `SELECT 1 FROM utilizadores WHERE id=$1`, [req.params.id]
    );
    if (!chkU.rows.length) return res.status(404).json({ erro: 'Utilizador não encontrado' });

    const r = await query(`SELECT face_foto_url FROM utilizadores WHERE id=$1`, [req.params.id]);
    const oldUrl = r.rows[0]?.face_foto_url;
    await query(`UPDATE utilizadores SET face_descriptor=NULL, face_foto_url='' WHERE id=$1`, [req.params.id]);
    if (oldUrl) deleteFaceFotoFromSupabase(oldUrl).catch(() => {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Registar presença (entrada/saída) — sem auth pois o funcionário não está logado. */
app.post('/api/presencas', async (req, res) => {
  try {
    await dbReady;
    const { utilizador_id, tipo, criado_em_cliente } = req.body;
    if (!utilizador_id || !['entrada','saida'].includes(tipo)) {
      return res.status(400).json({ erro: 'Parâmetros inválidos' });
    }
    const u = await query(`SELECT id, nome FROM utilizadores WHERE id=$1 AND ativo=true`, [utilizador_id]);
    if (!u.rows.length) return res.status(404).json({ erro: 'Utilizador não encontrado' });
    // Presença registada offline: usa a hora do aparelho (o momento real do
    // picar), não a hora da sincronização. Limites de sanidade: nunca no
    // futuro (>5 min) nem com mais de 72 h — fora disso, NOW().
    let quando = null;
    if (criado_em_cliente) {
      const ms = new Date(criado_em_cliente).getTime();
      const agora = Date.now();
      if (Number.isFinite(ms) && ms <= agora + 5 * 60 * 1000 && ms >= agora - 72 * 3600 * 1000) {
        quando = new Date(ms).toISOString();
      }
    }
    let r;
    try {
      r = await query(
        `INSERT INTO presencas (utilizador_id, tipo, criado_em, loja_id)
         VALUES ($1, $2, COALESCE($3::timestamptz, NOW()), $4) RETURNING id, criado_em`,
        [utilizador_id, tipo, quando, lojaDe(req)]
      );
    } catch (eL) {
      if (!/loja_id/.test(String(eL.message || ''))) throw eL;
      r = await query(
        `INSERT INTO presencas (utilizador_id, tipo, criado_em)
         VALUES ($1, $2, COALESCE($3::timestamptz, NOW())) RETURNING id, criado_em`,
        [utilizador_id, tipo, quando]
      );
    }
    res.json({ ok: true, id: r.rows[0].id, nome: u.rows[0].nome, tipo, criado_em: r.rows[0].criado_em });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Listar presenças (admin/gestor). */
app.get('/api/presencas', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const { data, utilizador_id } = req.query;
    let sql = `SELECT p.id, p.utilizador_id, u.nome, p.tipo, p.criado_em
               FROM presencas p JOIN utilizadores u ON u.id = p.utilizador_id WHERE 1=1`;
    const params = [];
    if (data) { params.push(data); sql += ` AND p.criado_em::date = $${params.length}`; }
    if (utilizador_id) { params.push(utilizador_id); sql += ` AND p.utilizador_id = $${params.length}`; }
    const ordP = ` ORDER BY p.criado_em DESC LIMIT 500`;
    const r = await queryEmpresa(
      `${sql} AND u.empresa_id = $${params.length + 1}${ordP}`, [...params, empresaDe(req)],
      `${sql}${ordP}`, params
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Presenças biométricas — próprio utilizador ou qualquer um se admin/gestor (?utilizador_id=). */
app.get('/api/me/presencas', auth, async (req, res) => {
  try {
    const isPriv = ['admin','gestor'].includes(req.user.role);
    const uid = (isPriv && req.query.utilizador_id) ? req.query.utilizador_id : req.user.id;
    const r = await query(
      `SELECT id, tipo, criado_em FROM presencas
       WHERE utilizador_id = $1 AND criado_em >= NOW() - INTERVAL '60 days'
       ORDER BY criado_em DESC LIMIT 200`,
      [uid]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

/** Assiduidade — próprio utilizador ou qualquer um se admin/gestor (?utilizador_id=). */
app.get('/api/me/assiduidade', auth, async (req, res) => {
  try {
    const isPriv = ['admin','gestor'].includes(req.user.role);
    const uid = (isPriv && req.query.utilizador_id) ? req.query.utilizador_id : req.user.id;
    const { inicio, fim } = req.query;
    if (!inicio || !fim) return res.status(400).json({ erro: 'inicio e fim obrigatórios' });
    const sql = `
      WITH hoje AS (SELECT (NOW() AT TIME ZONE 'Africa/Luanda')::date AS d),
      dias AS (SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS d),
      dias_com_escala_dia AS (
        SELECT DISTINCT data::date AS d FROM escala WHERE data BETWEEN $1::date AND $2::date
      ),
      esperados AS (
        SELECT data::date AS d, turno FROM escala
        WHERE data BETWEEN $1::date AND $2::date AND utilizador_id = $3
        UNION
        SELECT dias.d, et.turno FROM dias
        JOIN escala_template et ON et.dia_semana = ((EXTRACT(ISODOW FROM dias.d)::int) - 1)
        WHERE et.utilizador_id = $3
          AND NOT EXISTS (SELECT 1 FROM dias_com_escala_dia x WHERE x.d = dias.d)
      ),
      trabalhados AS (
        SELECT t.data::date AS d, t.nome AS turno
        FROM turno_equipa_real er
        JOIN turnos t ON t.id = er.turno_id
        WHERE t.data BETWEEN $1::date AND $2::date AND er.utilizador_id = $3
      )
      SELECT
        (SELECT COUNT(*) FROM (SELECT DISTINCT d,turno FROM esperados) x)::int AS turnos_esperados,
        (SELECT COUNT(*) FROM (SELECT DISTINCT d,turno FROM esperados WHERE d < (SELECT d FROM hoje)) x)::int AS turnos_esperados_passados,
        (SELECT COUNT(*) FROM (SELECT DISTINCT d,turno FROM trabalhados) x)::int AS turnos_trabalhados,
        (SELECT COUNT(*) FROM (
          SELECT DISTINCT e.d,e.turno FROM esperados e WHERE e.d < (SELECT d FROM hoje)
          EXCEPT SELECT DISTINCT d,turno FROM trabalhados
        ) x)::int AS faltas,
        (SELECT COALESCE(json_agg(json_build_object('data',to_char(x.d,'YYYY-MM-DD'),'turno',x.turno) ORDER BY x.d,x.turno),'[]'::json)
         FROM (SELECT DISTINCT e.d,e.turno FROM esperados e WHERE e.d < (SELECT d FROM hoje)
               EXCEPT SELECT DISTINCT d,turno FROM trabalhados) x) AS faltas_detalhe
    `;
    const r = await query(sql, [inicio, fim, uid]);
    res.json(r.rows[0] || {});
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
    const empEsc = empresaDe(req);
    const lojaEsc = lojaDe(req);
    const cacheKey = `${data_inicio}\t${data_fim}\te${empEsc}\tl${lojaEsc}`;
    const now = Date.now();
    const hit = _escalaSemanaCache.get(cacheKey);
    if (hit && now - hit.at < ESCALA_SEMANA_CACHE_MS) {
      return res.json(hit.body);
    }
    const selSem = `SELECT e.id, e.data, e.turno, e.notas, e.utilizador_id, e.area_trabalho,
                u.nome as utilizador_nome, u.role as utilizador_role
         FROM escala e
         LEFT JOIN utilizadores u ON e.utilizador_id::text = u.id::text
         WHERE e.data >= $1 AND e.data <= $2`;
    const ordSem = ` ORDER BY e.data, CASE e.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`;
    const selTpl = `SELECT et.id, et.dia_semana, et.turno, et.utilizador_id, et.notas, et.area_trabalho, u.nome as utilizador_nome
        FROM escala_template et
        LEFT JOIN utilizadores u ON et.utilizador_id::text = u.id::text`;
    const ordTpl = ` ORDER BY et.dia_semana, CASE et.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END, u.nome`;
    const [sem, tpl] = await Promise.all([
      queryEmpresa(
        `${selSem} AND e.loja_id = $3${ordSem}`, [data_inicio, data_fim, lojaEsc],
        `${selSem} AND u.empresa_id = $3${ordSem}`, [data_inicio, data_fim, empEsc]
      ).catch(() => query(`${selSem}${ordSem}`, [data_inicio, data_fim])),
      queryEmpresa(
        `${selTpl} WHERE et.loja_id = $1${ordTpl}`, [lojaEsc],
        `${selTpl} WHERE u.empresa_id = $1${ordTpl}`, [empEsc]
      ).catch(() => query(`${selTpl}${ordTpl}`, []))
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
    const selE = `SELECT e.id, e.data, e.turno, e.notas, e.utilizador_id, e.area_trabalho,
              u.nome as utilizador_nome, u.role as utilizador_role
       FROM escala e
       LEFT JOIN utilizadores u ON e.utilizador_id::text = u.id::text
       WHERE e.data >= $1 AND e.data <= $2`;
    const ordE = ` ORDER BY e.data, CASE e.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`;
    const r = await queryEmpresa(
      `${selE} AND e.loja_id = $3${ordE}`, [data_inicio, data_fim, lojaDe(req)],
      `${selE} AND u.empresa_id = $3${ordE}`, [data_inicio, data_fim, empresaDe(req)]
    ).catch(() => query(`${selE}${ordE}`, [data_inicio, data_fim]));
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
      const r = await queryEmpresa(
        `INSERT INTO escala (data, turno, utilizador_id, notas, area_trabalho, loja_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (data, turno, utilizador_id) DO UPDATE SET notas = EXCLUDED.notas, area_trabalho = EXCLUDED.area_trabalho, loja_id = EXCLUDED.loja_id
         RETURNING *`,
        [data, turno, utilizador_id, notas || '', area, lojaDe(req)],
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
    const selT = `SELECT et.id, et.dia_semana, et.turno, et.utilizador_id, et.notas, et.area_trabalho, u.nome as utilizador_nome
      FROM escala_template et
      LEFT JOIN utilizadores u ON et.utilizador_id::text = u.id::text`;
    const ordT = ` ORDER BY et.dia_semana, CASE et.turno WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END, u.nome`;
    const r = await queryEmpresa(
      `${selT} WHERE et.loja_id = $1${ordT}`, [lojaDe(req)],
      `${selT} WHERE u.empresa_id = $1${ordT}`, [empresaDe(req)]
    ).catch(() => query(`${selT}${ordT}`, []));
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
    const ins = await queryEmpresa(
      `INSERT INTO escala_template (dia_semana, turno, utilizador_id, notas, area_trabalho, loja_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dia_semana, turno, utilizador_id) DO UPDATE SET notas=EXCLUDED.notas, area_trabalho=EXCLUDED.area_trabalho, loja_id=EXCLUDED.loja_id
       RETURNING *`,
      [dia_semana, turno, u, n, area, lojaDe(req)],
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
    const chkT = await queryEmpresa(
      `SELECT 1 FROM escala_template et LEFT JOIN utilizadores u ON et.utilizador_id::text = u.id::text WHERE et.id=$1 AND u.empresa_id=$2`,
      [req.params.id, empresaDe(req)],
      `SELECT 1 FROM escala_template WHERE id=$1`, [req.params.id]
    );
    if (!chkT.rows.length) return res.status(404).json({ erro: 'Registo de escala não encontrado' });

    await query(`DELETE FROM escala_template WHERE id=$1`, [req.params.id]);
    clearEscalaSemanaCache();
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/escala/template/:id', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const chkT = await queryEmpresa(
      `SELECT 1 FROM escala_template et LEFT JOIN utilizadores u ON et.utilizador_id::text = u.id::text WHERE et.id=$1 AND u.empresa_id=$2`,
      [req.params.id, empresaDe(req)],
      `SELECT 1 FROM escala_template WHERE id=$1`, [req.params.id]
    );
    if (!chkT.rows.length) return res.status(404).json({ erro: 'Registo de escala não encontrado' });

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
  const selectEquipa = async (id) => {
    const r = await query(
      `SELECT er.*,
              COALESCE(u.nome, CASE WHEN er.utilizador_id LIKE 'ext:%' THEN substring(er.utilizador_id from 5) END) AS utilizador_nome,
              COALESCE(u.role::text, CASE WHEN er.utilizador_id LIKE 'ext:%' THEN 'externo' END) AS utilizador_role,
              uc.nome AS cobrindo_utilizador_nome
       FROM turno_equipa_real er
       LEFT JOIN utilizadores u ON er.utilizador_id::text = u.id::text
       LEFT JOIN utilizadores uc ON er.cobrindo_utilizador_id::text = uc.id::text
       WHERE er.turno_id=$1
       ORDER BY er.criado_em ASC`,
      [id]
    );
    return r.rows;
  };
  try {
    res.json(await selectEquipa(req.params.id));
  } catch (e) {
    if (!e.message.includes('does not exist')) {
      return res.status(500).json({ erro: e.message });
    }
    try {
      await withAdvisoryLock(7654321008, async () => {
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
      });
      res.json(await selectEquipa(req.params.id));
    } catch (e2) { res.status(500).json({ erro: e2.message }); }
  }
});

/** Verifica se o turno já tem comissões pagas (saídas de caixa com
 *  descrição "Comissão — ..."). Devolve { paga: boolean, total: number }. */
async function comissoesJaPagasNoTurno(turnoId) {
  try {
    const r = await query(
      `SELECT COALESCE(SUM(valor),0) AS total, COUNT(*) AS n
       FROM turno_saidas
       WHERE turno_id=$1 AND descricao ~* '^Comiss[aã]o\\s*[—-]'`,
      [turnoId]
    );
    const total = parseFloat(r.rows[0].total) || 0;
    const n = parseInt(r.rows[0].n, 10) || 0;
    return { paga: n > 0, total, n };
  } catch (_) {
    return { paga: false, total: 0, n: 0 };
  }
}

app.post('/api/turnos/:id/equipa-real', auth, async (req, res) => {
  try {
    const { utilizador_id, cobrindo_utilizador_id, hora_extra, motivo_falta, notas } = req.body || {};
    if (!utilizador_id) return res.status(400).json({ erro: 'utilizador_id é obrigatório' });
    // Bloqueia alterações à equipa real depois de já haver comissão paga
    // no turno — mudar quem trabalhou recalcula a regra "metade" e
    // tornaria os pagamentos já feitos inconsistentes.
    const pago = await comissoesJaPagasNoTurno(req.params.id);
    if (pago.paga) {
      // Permite UPDATE de quem já está registado (notas/hora_extra), mas
      // bloqueia INSERT de um novo nome.
      const ja = await query(
        'SELECT 1 FROM turno_equipa_real WHERE turno_id=$1 AND utilizador_id=$2 LIMIT 1',
        [req.params.id, String(utilizador_id)]
      );
      if (!ja.rows.length) {
        return res.status(409).json({
          erro: `Já há ${pago.n} pagamento${pago.n === 1 ? '' : 's'} de comissão neste turno (total ${pago.total.toLocaleString('pt-AO')} Kz). Para adicionar alguém a «Quem realmente trabalhou», anula primeiro as saídas de caixa de comissão.`
        });
      }
    }
    const cobre = cobrindo_utilizador_id ? String(cobrindo_utilizador_id) : null;
    const he = !!hora_extra;
    const motivo = (motivo_falta || '').trim();
    // "Motivo" deixou de ser obrigatório quando há cobertura.
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
    // Mesma protecção: não permitir remover alguém depois de pagamentos
    // de comissão no turno.
    const pago = await comissoesJaPagasNoTurno(req.params.id);
    if (pago.paga) {
      return res.status(409).json({
        erro: `Já há ${pago.n} pagamento${pago.n === 1 ? '' : 's'} de comissão neste turno. Para remover de «Quem realmente trabalhou», anula primeiro as saídas de caixa de comissão.`
      });
    }
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

/**
 * Resumo de assiduidade por utilizador no período [inicio, fim] (datas ISO inclusive).
 * Tudo na granularidade de TURNO (não de dia).
 * - turnos_esperados: nº de turnos DISTINTOS em que o utilizador estava escalado.
 *   Fonte: tabela `escala` para a data; quando não há nenhuma linha em `escala` para
 *   essa data (qualquer turno/utilizador), usa `escala_template` da `dia_semana`.
 * - turnos_trabalhados: nº de turnos com presença registada em `turno_equipa_real`.
 * - faltas: turnos onde estava ESCALADO mas NÃO HÁ presença registada (set difference).
 * - horas_extra: turnos com presença + `hora_extra=true` + NÃO estava escalado
 *   (presenças não escaladas marcadas como hora extra).
 */
app.get('/api/assiduidade', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const { inicio, fim } = req.query;
    if (!inicio || !fim) return res.status(400).json({ erro: 'inicio e fim são obrigatórios (YYYY-MM-DD)' });
    const sql = `
      WITH hoje AS (
        SELECT (NOW() AT TIME ZONE 'Africa/Luanda')::date AS d
      ),
      dias AS (
        SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS d
      ),
      dias_com_escala_dia AS (
        SELECT DISTINCT data::date AS d FROM escala WHERE data BETWEEN $1::date AND $2::date
      ),
      esperados AS (
        SELECT e.utilizador_id::text AS utilizador_id, e.data::date AS d, e.turno
        FROM escala e
        WHERE e.data BETWEEN $1::date AND $2::date AND e.utilizador_id IS NOT NULL {LOJA_ESC}
        UNION
        SELECT et.utilizador_id::text AS utilizador_id, dias.d, et.turno
        FROM dias
        JOIN escala_template et ON et.dia_semana = ((EXTRACT(ISODOW FROM dias.d)::int) - 1)
        WHERE et.utilizador_id IS NOT NULL {LOJA_TPL}
          AND NOT EXISTS (SELECT 1 FROM dias_com_escala_dia x WHERE x.d = dias.d)
      ),
      trabalhados AS (
        SELECT er.utilizador_id::text AS utilizador_id,
               t.data::date AS d,
               t.nome AS turno,
               COALESCE(er.hora_extra, FALSE) AS hora_extra
        FROM turno_equipa_real er
        JOIN turnos t ON t.id = er.turno_id
        WHERE t.data BETWEEN $1::date AND $2::date {LOJA_TRB}
      )
      SELECT u.id::text AS utilizador_id,
             u.nome AS utilizador_nome,
             u.role AS utilizador_role,
             COALESCE((
               SELECT COUNT(*) FROM (SELECT DISTINCT d, turno FROM esperados e WHERE e.utilizador_id = u.id::text) x
             ), 0)::int AS turnos_esperados,
             /** Esperados cuja data já passou (estritamente < hoje, em Luanda). Usado para taxa de assiduidade. */
             COALESCE((
               SELECT COUNT(*) FROM (
                 SELECT DISTINCT e.d, e.turno FROM esperados e
                 WHERE e.utilizador_id = u.id::text AND e.d < (SELECT d FROM hoje)
               ) x
             ), 0)::int AS turnos_esperados_passados,
             COALESCE((
               SELECT COUNT(*) FROM (SELECT DISTINCT d, turno FROM trabalhados t WHERE t.utilizador_id = u.id::text) x
             ), 0)::int AS turnos_trabalhados,
             /** Faltas: estava escalado, NÃO trabalhou e a data já passou. Turnos de hoje/futuro não contam. */
             COALESCE((
               SELECT COUNT(*) FROM (
                 SELECT DISTINCT e.d, e.turno
                 FROM esperados e
                 WHERE e.utilizador_id = u.id::text AND e.d < (SELECT d FROM hoje)
                 EXCEPT
                 SELECT DISTINCT t.d, t.turno FROM trabalhados t WHERE t.utilizador_id = u.id::text
               ) x
             ), 0)::int AS faltas,
             COALESCE((
               SELECT COUNT(*) FROM (
                 SELECT DISTINCT t.d, t.turno
                 FROM trabalhados t
                 WHERE t.utilizador_id = u.id::text
                   AND t.hora_extra IS TRUE
                   AND NOT EXISTS (
                     SELECT 1 FROM esperados e
                     WHERE e.utilizador_id = u.id::text AND e.d = t.d AND e.turno = t.turno
                   )
               ) x
             ), 0)::int AS horas_extra,
             COALESCE((
               SELECT json_agg(json_build_object('data', to_char(x.d, 'YYYY-MM-DD'), 'turno', x.turno) ORDER BY x.d, x.turno)
               FROM (
                 SELECT DISTINCT e.d, e.turno
                 FROM esperados e
                 WHERE e.utilizador_id = u.id::text AND e.d < (SELECT d FROM hoje)
                 EXCEPT
                 SELECT DISTINCT t.d, t.turno FROM trabalhados t WHERE t.utilizador_id = u.id::text
               ) x
             ), '[]'::json) AS faltas_detalhe,
             COALESCE((
               SELECT json_agg(json_build_object('data', to_char(x.d, 'YYYY-MM-DD'), 'turno', x.turno) ORDER BY x.d, x.turno)
               FROM (
                 SELECT DISTINCT t.d, t.turno FROM trabalhados t WHERE t.utilizador_id = u.id::text
               ) x
             ), '[]'::json) AS trabalhados_detalhe,
             COALESCE((
               SELECT json_agg(json_build_object('data', to_char(x.d, 'YYYY-MM-DD'), 'turno', x.turno) ORDER BY x.d, x.turno)
               FROM (
                 SELECT DISTINCT t.d, t.turno
                 FROM trabalhados t
                 WHERE t.utilizador_id = u.id::text
                   AND t.hora_extra IS TRUE
                   AND NOT EXISTS (
                     SELECT 1 FROM esperados e
                     WHERE e.utilizador_id = u.id::text AND e.d = t.d AND e.turno = t.turno
                   )
               ) x
             ), '[]'::json) AS horas_extra_detalhe
      FROM utilizadores u
      WHERE u.ativo = TRUE {EMPRESA_FILTRO}
      ORDER BY u.nome ASC
    `;
    const montarAssiduidade = (comLoja, comEmpresa) => sql
      .replace('{LOJA_ESC}', comLoja ? 'AND e.loja_id = $4' : '')
      .replace('{LOJA_TPL}', comLoja ? 'AND et.loja_id = $4' : '')
      .replace('{LOJA_TRB}', comLoja ? 'AND t.loja_id = $4' : '')
      .replace('{EMPRESA_FILTRO}', comEmpresa ? 'AND u.empresa_id = $3' : '');
    const r = await query(montarAssiduidade(true, true), [inicio, fim, empresaDe(req), lojaDe(req)])
      .catch((eA) => {
        if (!/loja_id/.test(String(eA.message || ''))) throw eA;
        return queryEmpresa(
          montarAssiduidade(false, true), [inicio, fim, empresaDe(req)],
          montarAssiduidade(false, false), [inicio, fim]
        );
      });
    const rows = r.rows.map((row) => {
      const esp = parseInt(row.turnos_esperados, 10) || 0;
      const espPassados = parseInt(row.turnos_esperados_passados, 10) || 0;
      const trab = parseInt(row.turnos_trabalhados, 10) || 0;
      const falt = parseInt(row.faltas, 10) || 0;
      const he = parseInt(row.horas_extra, 10) || 0;
      return {
        utilizador_id: row.utilizador_id,
        utilizador_nome: row.utilizador_nome,
        utilizador_role: row.utilizador_role,
        turnos_esperados: esp,
        turnos_esperados_passados: espPassados,
        turnos_trabalhados: trab,
        faltas: falt,
        horas_extra: he,
        faltas_detalhe: Array.isArray(row.faltas_detalhe) ? row.faltas_detalhe : [],
        trabalhados_detalhe: Array.isArray(row.trabalhados_detalhe) ? row.trabalhados_detalhe : [],
        horas_extra_detalhe: Array.isArray(row.horas_extra_detalhe) ? row.horas_extra_detalhe : [],
        // Aliases para compat com clientes antigos que tinham o JS em cache.
        dias_esperados: esp,
        dias_trabalhados: trab
      };
    });
    res.json({ inicio, fim, rows });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/**
 * Lê auditoria com filtros opcionais. Apenas admin/gestor.
 * `?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&utilizador_id=…&acao=texto&limit=200`.
 */
app.get('/api/auditoria', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    await ensureAuditoria();
    /** Limite mais conservador (era 200/500) — auditoria pode crescer rápido. */
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const params = [];
    const where = [];
    /** Datas e horas são sempre interpretadas em Africa/Luanda. */
    const reTime = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
    const reDate = /^\d{4}-\d{2}-\d{2}$/;
    const inicioStr = reDate.test(String(req.query.inicio || '')) ? String(req.query.inicio) : '';
    const fimStr = reDate.test(String(req.query.fim || '')) ? String(req.query.fim) : '';
    const horaIniM = reTime.exec(String(req.query.hora_inicio || ''));
    const horaFimM = reTime.exec(String(req.query.hora_fim || ''));
    const horaIni = horaIniM ? `${horaIniM[1].padStart(2, '0')}:${horaIniM[2]}:${horaIniM[3] || '00'}` : null;
    const horaFim = horaFimM ? `${horaFimM[1].padStart(2, '0')}:${horaFimM[2]}:${horaFimM[3] || '59'}` : null;
    /** Se houver hora sem data, usa hoje em Luanda (vem do servidor para coerência). */
    if (inicioStr || horaIni) {
      const dataIni = inicioStr || `(NOW() AT TIME ZONE 'Africa/Luanda')::date::text`;
      const horaIniSql = horaIni || '00:00:00';
      if (inicioStr) {
        params.push(`${inicioStr} ${horaIniSql}`);
        where.push(`a.criado_em >= ($${params.length}::timestamp AT TIME ZONE 'Africa/Luanda')`);
      } else {
        params.push(horaIniSql);
        where.push(`a.criado_em >= ((((NOW() AT TIME ZONE 'Africa/Luanda')::date || ' ' || $${params.length})::timestamp) AT TIME ZONE 'Africa/Luanda')`);
      }
    }
    if (fimStr || horaFim) {
      const horaFimSql = horaFim || '23:59:59';
      if (fimStr) {
        params.push(`${fimStr} ${horaFimSql}`);
        where.push(`a.criado_em <= ($${params.length}::timestamp AT TIME ZONE 'Africa/Luanda')`);
      } else {
        params.push(horaFimSql);
        where.push(`a.criado_em <= ((((NOW() AT TIME ZONE 'Africa/Luanda')::date || ' ' || $${params.length})::timestamp) AT TIME ZONE 'Africa/Luanda')`);
      }
    }
    if (req.query.utilizador_id) { params.push(String(req.query.utilizador_id)); where.push(`a.utilizador_id = $${params.length}`); }
    if (req.query.acao) {
      params.push('%' + String(req.query.acao).toLowerCase() + '%');
      where.push(`(LOWER(a.acao) LIKE $${params.length} OR LOWER(a.caminho) LIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT a.id,
             to_char(a.criado_em AT TIME ZONE 'Africa/Luanda', 'YYYY-MM-DD HH24:MI:SS') AS quando_local,
             a.criado_em,
             a.utilizador_id, a.utilizador_nome, a.utilizador_role,
             a.metodo, a.caminho, a.acao, a.descricao, a.status, a.ip, a.payload
      FROM auditoria a
      ${whereSql}
      ORDER BY a.criado_em DESC, a.id DESC
      LIMIT ${limit}
    `;
    /** statement_timeout (15s) na conexão reservada — em pool exausto o cliente vê erro claro em vez de pendurar. */
    const client = await pool.connect();
    try {
      try { await client.query(`SET statement_timeout = '15s'`); } catch (_) {}
      const r = await client.query(sql, params);
      res.json({ rows: r.rows, limit });
    } finally {
      try { await client.query(`SET statement_timeout = 0`); } catch (_) {}
      client.release();
    }
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});
if (require.main === module) {
  app.listen(PORT, () => console.log(`StockOS v3 na porta ${PORT}`));
}
module.exports = app;
