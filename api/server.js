require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const postgres = require('postgres');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stockos-secret-2025';
const PWD_SALT   = 'stockos-pwd-salt-2025';

const _dbUrl = process.env.DATABASE_URL;
if (!_dbUrl) { console.error('[FATAL] DATABASE_URL não definida'); process.exit(1); }
const _sqlOpts = { ssl: 'require', prepare: false, max: 1, idle_timeout: 1, max_lifetime: 5, connect_timeout: 10 };
let _activeDbUrl = _dbUrl;
function getDbCandidates() {
  const out = [_activeDbUrl, _dbUrl];
  try {
    const u = new URL(_dbUrl);
    const m = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
    if (m) {
      const ref = m[1];
      const baseUser = decodeURIComponent(u.username || 'postgres');
      const users = new Set([
        baseUser,
        `${baseUser}.${ref}`,
        `postgres.${ref}`
      ]);
      for (const usr of users) {
        const pooler = new URL(_dbUrl);
        pooler.hostname = 'aws-0-eu-west-1.pooler.supabase.com';
        pooler.port = '6543';
        pooler.username = usr;
        out.push(pooler.toString());
      }
    }
  } catch (_) {}
  return [...new Set(out)];
}
function createSql(url) { return postgres(url || _activeDbUrl, _sqlOpts); }
const query = async (text, params) => {
  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const url of getDbCandidates()) {
      const sql = createSql(url);
      try {
        const rows = await sql.unsafe(text, params || []);
        _activeDbUrl = url;
        return { rows: Array.from(rows) };
      } catch (e) {
        lastErr = e;
      } finally {
        // Em serverless, fechar cedo reduz saturação do pool em Session mode.
        await sql.end({ timeout: 1 }).catch(() => {});
      }
    }
    if (round === 0) await new Promise(r => setTimeout(r, 120));
  }
  throw lastErr;
};
const pool = {
  query,
  connect: async () => {
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
      for (const url of getDbCandidates()) {
        const sql = createSql(url);
        try {
          const reserved = await sql.reserve();
          _activeDbUrl = url;
          return {
            query: async (text, params) => { const rows = await reserved.unsafe(text, params || []); return { rows: Array.from(rows) }; },
            release: async () => {
              await reserved.release().catch(() => {});
              await sql.end({ timeout: 1 }).catch(() => {});
            }
          };
        } catch (e) {
          lastErr = e;
          await sql.end({ timeout: 1 }).catch(() => {});
        }
      }
      if (round === 0) await new Promise(r => setTimeout(r, 120));
    }
    throw lastErr;
  }
};


async function qry(sql, params, label) {
  try { await query(sql, params); }
  catch(e) { console.error(`[initDB:${label}]`, e.message); }
}

async function initDB() {
  await qry(`CREATE TABLE IF NOT EXISTS utilizadores (
    id SERIAL PRIMARY KEY, nome VARCHAR(150) NOT NULL, email VARCHAR(200) NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL DEFAULT '', role VARCHAR(20) NOT NULL DEFAULT 'operador',
    ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`, [], 'utilizadores');
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
    encontrado NUMERIC(10,3) NOT NULL DEFAULT 0, entrada NUMERIC(10,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(10,3) NOT NULL DEFAULT 0, fechados NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id, produto_id)
  )`, [], 'turno_stock');
  await qry(`ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS fechados NUMERIC(10,3) NOT NULL DEFAULT 0`, [], 'turno_stock-fechados');
  await qry(`CREATE TABLE IF NOT EXISTS turno_caixa (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
    tpa NUMERIC(15,2) NOT NULL DEFAULT 0, transferencia NUMERIC(15,2) NOT NULL DEFAULT 0,
    dinheiro NUMERIC(15,2) NOT NULL DEFAULT 0, saida NUMERIC(15,2) NOT NULL DEFAULT 0
  )`, [], 'turno_caixa');
  await qry(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS venda_avulso BOOLEAN NOT NULL DEFAULT FALSE`, [], 'alter-venda-avulso');
  await qry(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tipo_medicao VARCHAR(10) NOT NULL DEFAULT 'unidade'`, [], 'alter-tipo-medicao');
  await qry(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`, [], 'alter-util');
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
  await qry(`INSERT INTO utilizadores (nome,email,senha_hash,role) VALUES ('Admin','admin@stockos.ao',$1,'admin') ON CONFLICT (email) DO UPDATE SET senha_hash=$1`, [hashPassword('admin123')], 'admin');
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
  console.log('DB ready');
}
const dbReady = initDB();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public'));
app.use(async (req, res, next) => { try { await dbReady; next(); } catch(e) { res.status(500).json({ erro: 'DB não disponível' }); } });

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

async function ensureUsernameColumn() {
  await ensureRoleEnumCompras();
  await query(`ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS username VARCHAR(50)`);
  const r = await query(`SELECT id, email FROM utilizadores WHERE username IS NULL OR TRIM(username) = ''`).catch(() => ({ rows: [] }));
  for (const row of r.rows) {
    await query(`UPDATE utilizadores SET username=$1 WHERE id=$2`, [`u${row.id}`, row.id]).catch(() => {});
  }
  await query(`UPDATE utilizadores SET username = 'admin' WHERE email = 'admin@stockos.ao'`).catch(() => {});
  try {
    await query(`ALTER TABLE utilizadores ALTER COLUMN username SET NOT NULL`);
  } catch (_) {}
  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_utilizadores_username_lower ON utilizadores (LOWER(username))`);
  } catch (_) {}
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
  await migrateDepositosSaidasAntigasAgrupadas().catch((e) => console.error('migrateDepositosSaidasAntigasAgrupadas', e));
}

/** valor = bruto por turno na coluna valor; saída no depósito só no total (valor_saidas num único registo do dia). Líquido total = Σ(valor) − Σ(valor_saidas). */
function parseDepositoValores(body) {
  const saidasRaw = parseFloat(body.valor_saidas);
  const saidas = Number.isNaN(saidasRaw) ? 0 : Math.max(0, saidasRaw);
  const bruto = parseFloat(body.valor_bruto);
  if (!Number.isNaN(bruto) && bruto > 0) {
    const liquido = bruto - saidas;
    if (liquido <= 0) {
      const err = new Error('O valor bruto deve ser maior que as saídas no depósito.');
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
app.get('/api/health', (req, res) => res.json({ status: 'ok', v: 3 }));


app.get('/api/status', async (req, res) => {
  try {
    const r = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
    res.json({ tables: r.rows.map(x => x.table_name) });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

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
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`, 'notas');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`, 'criado_em');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS fechado_em TIMESTAMPTZ`, 'fechado_em');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'aberto'`, 'estado');
  await run(`CREATE TABLE IF NOT EXISTS turno_stock (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    encontrado NUMERIC(10,3) NOT NULL DEFAULT 0, entrada NUMERIC(10,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id, produto_id))`, 'turno_stock');
  await run(`CREATE TABLE IF NOT EXISTS turno_caixa (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
    tpa NUMERIC(15,2) NOT NULL DEFAULT 0, transferencia NUMERIC(15,2) NOT NULL DEFAULT 0,
    dinheiro NUMERIC(15,2) NOT NULL DEFAULT 0, saida NUMERIC(15,2) NOT NULL DEFAULT 0)`, 'turno_caixa');
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
    await run(`CREATE TABLE turno_stock (id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE, produto_id ${pidCol} NOT NULL REFERENCES produtos(id) ON DELETE CASCADE, encontrado NUMERIC(10,3) NOT NULL DEFAULT 0, entrada NUMERIC(10,3) NOT NULL DEFAULT 0, deixado NUMERIC(10,3) NOT NULL DEFAULT 0, fechados NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id,produto_id))`, 'turno_stock-create');
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

app.post('/api/auth/login', async (req, res) => {
  try {
    await ensureUsernameColumn();
    const password = (req.body.password || '').trim();
    const login = loginFromBody(req);
    if (!login || !password) return res.status(400).json({ erro: 'Nome de utilizador e senha são obrigatórios' });
    const r = await query(
      `SELECT * FROM utilizadores WHERE ativo=true AND (LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1))`,
      [login]
    );
    if (!r.rows.length) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const user = r.rows[0];
    if (user.senha_hash !== hashPassword(password)) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const token = createToken({ id: user.id, email: user.email, nome: user.nome, role: user.role, username: user.username });
    res.json({
      token,
      user: { id: user.id, email: user.email, nome: user.nome, role: user.role, username: user.username }
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  await ensureUsernameColumn().catch(() => {});
  const r = await query('SELECT id,email,nome,role,username FROM utilizadores WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
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
    const { nome, preco, categoria, venda_avulso, tipo_medicao } = req.body;
    const medicao = tipo_medicao === 'peso' ? 'peso' : 'unidade';
    const maxOrdem = await query('SELECT COALESCE(MAX(ordem),0)+1 as n FROM produtos');
    const r = await query(
      'INSERT INTO produtos (nome,preco,categoria,ordem,venda_avulso,tipo_medicao) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [nome, preco||0, categoria||'outro', maxOrdem.rows[0].n, !!venda_avulso, medicao]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/produtos/:id', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    const { nome, preco, categoria, ordem, ativo, venda_avulso, tipo_medicao } = req.body;
    const medicao = tipo_medicao === 'peso' ? 'peso' : 'unidade';
    const r = await query(
      'UPDATE produtos SET nome=$1,preco=$2,categoria=$3,ordem=$4,ativo=$5,venda_avulso=$6,tipo_medicao=$7 WHERE id=$8 RETURNING *',
      [nome, preco, categoria, ordem, ativo, !!venda_avulso, medicao, req.params.id]
    );
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
  await query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'armazem_faturas_turno_saida_id_fkey') THEN
      ALTER TABLE armazem_faturas ADD CONSTRAINT armazem_faturas_turno_saida_id_fkey
      FOREIGN KEY (turno_saida_id) REFERENCES turno_saidas(id) ON DELETE SET NULL;
    END IF;
  END $$`).catch(() => {});
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

app.get('/api/armazem/compras', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '80', 10)));
    const r = await query(
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await processArmazemCompraLine(client, req, req.body, {});
    await client.query('COMMIT');
    const merged = await client.query(
      `SELECT c.*, p.nome as produto_nome, p.tipo_medicao
       FROM armazem_compras c
       JOIN produtos p ON p.id=c.produto_id
       WHERE c.id=$1`,
      [row.id]
    );
    res.json(merged.rows[0]);
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({ erro: e.message });
  } finally { client.release(); }
});

app.get('/api/armazem/faturas', auth, requireRole('admin','gestor','compras'), async (req, res) => {
  try {
    await ensureArmazemTables();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '40', 10)));
    const r = await query(
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { numero_fatura, fornecedor, data_emissao, notas, linhas, justificacao_excesso, turno_saida_id } = req.body || {};
    if (!Array.isArray(linhas) || !linhas.length) throw new Error('Adicione pelo menos uma linha à fatura');
    const dataFat = (data_emissao || new Date().toISOString().split('T')[0]).trim();
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
      `INSERT INTO armazem_faturas (numero_fatura, fornecedor, data_emissao, notas, criado_por, justificacao_excesso, turno_saida_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        (numero_fatura || '').trim(),
        (fornecedor || '').trim(),
        dataFat,
        (notas || '').trim(),
        String(req.user.id || ''),
        just,
        tsid
      ]
    );
    const fid = ins.rows[0].id;
    const forn = (fornecedor || '').trim();
    sumTotal = 0;
    for (const linha of linhas) {
      const row = await processArmazemCompraLine(client, req, linha, { fatura_id: fid, fornecedor_header: forn });
      sumTotal += parseFloat(row.valor_total) || 0;
    }
    await client.query('UPDATE armazem_faturas SET total_valor=$1 WHERE id=$2', [sumTotal, fid]);
    await client.query('COMMIT');
    const fat = await query('SELECT * FROM armazem_faturas WHERE id=$1', [fid]);
    const linhasOut = await query(
      `SELECT c.*, p.nome as produto_nome, p.tipo_medicao
       FROM armazem_compras c JOIN produtos p ON p.id=c.produto_id
       WHERE c.fatura_id=$1 ORDER BY c.id`,
      [fid]
    );
    res.json({ ...fat.rows[0], linhas: linhasOut.rows });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({ erro: e.message });
  } finally { client.release(); }
});

// ── TURNOS ────────────────────────────────────────────────────
app.get('/api/dia', auth, async (req, res) => {
  try {
    const data = req.query.data || new Date().toISOString().split('T')[0];
    const turnos = await query(
      `SELECT t.*, u.nome as utilizador_nome FROM turnos t
       LEFT JOIN utilizadores u ON t.utilizador_id=u.id
       WHERE t.data=$1
       ORDER BY CASE t.nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`,
      [data]
    );

    const result = [];
    for (const turno of turnos.rows) {
      // Stock com produto info
      const stock = await query(
        `SELECT ts.*, p.nome as produto_nome, p.preco, p.categoria, p.ordem, p.tipo_medicao
         FROM turno_stock ts
         JOIN produtos p ON ts.produto_id=p.id
         WHERE ts.turno_id=$1
         ORDER BY p.ordem, p.nome`,
        [turno.id]
      );

      // Caixa
      const caixa = await query('SELECT * FROM turno_caixa WHERE turno_id=$1', [turno.id]);

      // Comparação com turno anterior
      const prev = prevTurno(turno.nome, data);
      const prevStock = await query(
        `SELECT ts.produto_id, ts.deixado FROM turno_stock ts
         JOIN turnos t ON ts.turno_id=t.id
         WHERE t.data=$1 AND t.nome=$2`,
        [prev.data, prev.nome]
      );
      const prevMap = {};
      prevStock.rows.forEach(r => { prevMap[r.produto_id] = parseFloat(r.deixado); });

      const stockFinal = stock.rows.map(s => {
        const enc  = parseFloat(s.encontrado);
        const ent  = parseFloat(s.entrada);
        const dei  = parseFloat(s.deixado);
        const vend = Math.max(0, enc + ent - dei);
        const val  = vend * parseFloat(s.preco);

        let comparacao = null;
        if (prevMap[s.produto_id] !== undefined) {
          const diff = enc - prevMap[s.produto_id];
          if (Math.abs(diff) < 0.001) comparacao = 'igual';
          else if (diff < 0) comparacao = `falta ${Math.abs(diff)}`;
          else comparacao = `sobra ${diff}`;
        }
        const prevDeixado = prevMap[s.produto_id] !== undefined ? prevMap[s.produto_id] : null;
        return { ...s, vendido: vend, valor: val, comparacao, prev_deixado: prevDeixado };
      });

      const c = caixa.rows[0] || { tpa:0, transferencia:0, dinheiro:0, saida:0 };
      const totalGerado = parseFloat(c.tpa||0) + parseFloat(c.transferencia||0) + parseFloat(c.dinheiro||0);
      const totalFinal  = totalGerado - parseFloat(c.saida||0);
      const totalVendas = stockFinal.reduce((sum, s) => sum + s.valor, 0);

      result.push({
        ...turno,
        stock: stockFinal,
        caixa: { ...c, total_gerado: totalGerado, total_final: totalFinal },
        total_vendas: totalVendas
      });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/turnos/abrir', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { data, nome } = req.body;
    if (!data || !nome) throw new Error('Data e nome obrigatórios');

    const exists = await client.query('SELECT id FROM turnos WHERE data=$1 AND nome=$2', [data, nome]);
    if (exists.rows.length) throw new Error(`Turno ${nome} já existe para ${data}`);

    const turno = await client.query(
      'INSERT INTO turnos (data, nome, utilizador_id) VALUES ($1,$2,$3) RETURNING *',
      [data, nome, req.user.id]
    );
    const turnoId = turno.rows[0].id;

    // Criar entradas de stock para todos os produtos activos
    const produtos = await client.query('SELECT id FROM produtos WHERE ativo=true ORDER BY ordem');
    for (const p of produtos.rows) {
      // Pré-preencher "encontrado" com o "deixado" do turno anterior
      const prev = prevTurno(nome, data);
      const prevRow = await client.query(
        `SELECT ts.deixado FROM turno_stock ts
         JOIN turnos t ON ts.turno_id=t.id
         WHERE t.data=$1 AND t.nome=$2 AND ts.produto_id=$3`,
        [prev.data, prev.nome, p.id]
      );
      const encontrado = prevRow.rows.length ? prevRow.rows[0].deixado : 0;
      await client.query(
        'INSERT INTO turno_stock (turno_id, produto_id, encontrado) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [turnoId, p.id, encontrado]
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
  try {
    const r = await query(
      "UPDATE turnos SET estado='fechado', fechado_em=NOW() WHERE id=$1 AND estado='aberto' RETURNING *",
      [req.params.id]
    );
    if (!r.rows.length) return res.status(400).json({ erro: 'Turno não encontrado ou já fechado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/turnos/:id/stock', auth, async (req, res) => {
  try {
    const { produto_id, encontrado, deixado, fechados } = req.body;
    const r = await query(
      `INSERT INTO turno_stock (turno_id, produto_id, encontrado, deixado, fechados)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (turno_id, produto_id)
       DO UPDATE SET encontrado=$3, deixado=$4, fechados=$5
       RETURNING *`,
      [req.params.id, produto_id, encontrado||0, deixado||0, fechados||0]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ENTRADAS DE STOCK ──────────────────────────────────────────
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
    if (!notas || !notas.trim())
      throw new Error('A nota é obrigatória');
    const tipoVal   = tipo   === 'tirar'  ? 'tirar'  : 'entrada';
    const origemVal = origem === 'compra' ? 'compra' : 'armazem';
    const precoVal  = origemVal === 'compra' ? (parseFloat(preco) || 0) : 0;

    const registo = await client.query(
      'INSERT INTO turno_entradas (turno_id, produto_id, tipo, origem, preco, quantidade, notas) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [turnoId, produto_id, tipoVal, origemVal, precoVal, quantidade, notas.trim()]
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
    const r = await query(
      `INSERT INTO turno_caixa (turno_id, tpa, transferencia, dinheiro, saida)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (turno_id)
       DO UPDATE SET tpa=$2, transferencia=$3, dinheiro=$4, saida=$5
       RETURNING *`,
      [req.params.id, tpa||0, transferencia||0, dinheiro||0, saida]
    );
    const c = r.rows[0];
    c.total_gerado = parseFloat(c.tpa) + parseFloat(c.transferencia) + parseFloat(c.dinheiro);
    c.total_final  = c.total_gerado - parseFloat(c.saida);
    res.json(c);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── SAÍDAS DE CAIXA ────────────────────────────────────────────
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
    if (!notas || !notas.trim()) throw new Error('A nota é obrigatória');

    const r = await client.query(
      'INSERT INTO turno_saidas (turno_id, descricao, valor, notas) VALUES ($1,$2,$3,$4) RETURNING *',
      [turnoId, descricao.trim(), valor, notas.trim()]
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

// ── DASHBOARD (agregado do dia — só admin) ────────────────────
app.get('/api/dashboard', auth, requireRole('admin'), async (req, res) => {
  try {
    const data = req.query.data || new Date().toISOString().split('T')[0];

    const [turnos, caixa] = await Promise.all([
      query(
        `SELECT nome, estado, criado_em, fechado_em FROM turnos WHERE data=$1
         ORDER BY CASE nome WHEN 'manha' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noite' THEN 3 END`,
        [data]
      ),
      query(
        `SELECT
           COALESCE(SUM(tc.tpa),0)           as tpa,
           COALESCE(SUM(tc.transferencia),0)  as transferencia,
           COALESCE(SUM(tc.dinheiro),0)       as dinheiro,
           COALESCE(SUM(tc.saida),0)          as saida,
           COALESCE(SUM(tc.tpa+tc.transferencia+tc.dinheiro),0) as total_gerado,
           COALESCE(SUM(tc.tpa+tc.transferencia+tc.dinheiro-tc.saida),0) as total_final
         FROM turno_caixa tc
         JOIN turnos t ON tc.turno_id=t.id
         WHERE t.data=$1`,
        [data]
      )
    ]);

    // Total vendas (bebidas com preço)
    const vendas = await query(
      `SELECT COALESCE(SUM(GREATEST(0, ts.encontrado+ts.entrada-ts.deixado) * p.preco),0) as total
       FROM turno_stock ts
       JOIN turnos t ON ts.turno_id=t.id
       JOIN produtos p ON ts.produto_id=p.id
       WHERE t.data=$1`,
      [data]
    );

    res.json({
      data,
      turnos: turnos.rows,
      total_vendas: parseFloat(vendas.rows[0].total) || 0,
      caixa: caixa.rows[0]
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/depositos', auth, requireRole('admin', 'gestor'), async (req, res) => {
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

app.post('/api/depositos', auth, requireRole('admin', 'gestor'), async (req, res) => {
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
    const vtpa = parseFloat(valor_tpa);
    if (Number.isNaN(vtpa) || vtpa < 0) return res.status(400).json({ erro: 'Indique o valor registado no TPA (≥ 0).' });
    await assertTurnoFechado(turno_id);
    const ddep = (data_deposito || new Date().toISOString().split('T')[0]).trim();
    const r = await query(
      `INSERT INTO depositos_banco (turno_id, data_deposito, valor, valor_tpa, valor_saidas, referencia, notas, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (turno_id) DO UPDATE SET
         data_deposito = EXCLUDED.data_deposito,
         valor = EXCLUDED.valor,
         valor_tpa = EXCLUDED.valor_tpa,
         valor_saidas = EXCLUDED.valor_saidas,
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

app.post('/api/depositos/lote', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const { itens, valor_saidas_total } = req.body || {};
    const saidasTotalRaw = parseFloat(valor_saidas_total);
    const saidasTotal = Number.isNaN(saidasTotalRaw) ? 0 : Math.max(0, saidasTotalRaw);
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
      return res.status(400).json({ erro: 'A saída no depósito não pode ser maior que a soma dos valores brutos.' });
    }
    if (sumBruto - saidasTotal <= 0) {
      return res.status(400).json({ erro: 'O total depositado no banco (soma dos brutos menos a saída) tem de ser positivo.' });
    }
    dedup[0].valor_saidas = saidasTotal;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = [];
      for (const row of dedup) {
        const r = await client.query(
          `INSERT INTO depositos_banco (turno_id, data_deposito, valor, valor_tpa, valor_saidas, referencia, notas, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (turno_id) DO UPDATE SET
             data_deposito = EXCLUDED.data_deposito,
             valor = EXCLUDED.valor,
             valor_tpa = EXCLUDED.valor_tpa,
             valor_saidas = EXCLUDED.valor_saidas,
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
            row.referencia,
            row.notas,
            String(req.user.id || '')
          ]
        );
        out.push(r.rows[0]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, registos: out.length, rows: out });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await client.release();
    }
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.delete('/api/depositos/:id', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    await ensureDepositosBanco();
    const r = await query('DELETE FROM depositos_banco WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Depósito não encontrado' });
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ erro: e.message }); }
});

// ── HISTÓRICO ─────────────────────────────────────────────────
app.get('/api/historico', auth, async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    const r = await query(
      `SELECT
         t.data,
         COUNT(DISTINCT t.id) as num_turnos,
         COALESCE(SUM(tc.tpa),0) as tpa,
         COALESCE(SUM(tc.transferencia),0) as transferencia,
         COALESCE(SUM(tc.dinheiro),0) as dinheiro,
         COALESCE(SUM(tc.tpa+tc.transferencia+tc.dinheiro),0) as total_gerado,
         COALESCE(SUM(tc.saida),0) as saida,
         COALESCE(SUM(tc.tpa+tc.transferencia+tc.dinheiro-tc.saida),0) as total_final
       FROM turnos t
       LEFT JOIN turno_caixa tc ON tc.turno_id=t.id
       WHERE t.data BETWEEN $1 AND $2
       GROUP BY t.data
       ORDER BY t.data DESC`,
      [inicio || '2020-01-01', fim || new Date().toISOString().split('T')[0]]
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
      `SELECT tv.*, p.nome as produto_nome, p.preco
       FROM turno_vendas tv JOIN produtos p ON tv.produto_id=p.id
       WHERE tv.turno_id=$1 ORDER BY p.nome`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/turnos/:id/vendas', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const turnoId = req.params.id;
    const { produto_id, quantidade } = req.body;

    const old = await client.query(
      'SELECT quantidade FROM turno_vendas WHERE turno_id=$1 AND produto_id=$2',
      [turnoId, produto_id]
    );
    const oldQty = old.rows.length ? parseFloat(old.rows[0].quantidade) : 0;
    const delta = parseFloat(quantidade) - oldQty;

    await client.query(
      `INSERT INTO turno_vendas (turno_id,produto_id,quantidade) VALUES ($1,$2,$3)
       ON CONFLICT (turno_id,produto_id) DO UPDATE SET quantidade=$3`,
      [turnoId, produto_id, quantidade]
    );

    if (delta !== 0) {
      // Expand recipe recursively: if a component itself has a recipe, use its ingredients instead
      async function expandIngredientes(prodId, fator) {
        const r = await client.query(
          'SELECT componente_id, quantidade FROM receitas WHERE produto_id=$1',
          [prodId]
        );
        if (r.rows.length === 0) {
          // Leaf ingredient — subtract from stock directly
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
      // Aggregate in case the same ingredient appears multiple times
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
}

app.get('/api/escala', auth, async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;
    if (!data_inicio || !data_fim) return res.status(400).json({ erro: 'data_inicio e data_fim são obrigatórios' });
    const r = await query(
      `SELECT e.id, e.data, e.turno, e.notas, e.utilizador_id,
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

app.put('/api/escala', auth, requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const { data, turno, utilizador_id, notas } = req.body;
    if (!data || !turno) return res.status(400).json({ erro: 'Data e turno obrigatórios' });
    if (utilizador_id) {
      const r = await query(
        `INSERT INTO escala (data, turno, utilizador_id, notas)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (data, turno, utilizador_id) DO UPDATE SET notas=$4
         RETURNING *`,
        [data, turno, utilizador_id, notas || '']
      );
      res.json(r.rows[0]);
    } else {
      await query(`DELETE FROM escala WHERE data=$1 AND turno=$2`, [data, turno]);
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
}

app.get('/api/escala/template', auth, async (req, res) => {
  try {
    const r = await query(`
      SELECT et.id, et.dia_semana, et.turno, et.utilizador_id, u.nome as utilizador_nome
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
    const { dia_semana, turno, utilizador_id, notas } = req.body;
    if (dia_semana === undefined || !turno) return res.status(400).json({ erro: 'dia_semana e turno são obrigatórios' });
    const u = utilizador_id || null;
    if (!u) return res.status(400).json({ erro: 'Seleciona um funcionário' });
    const n = notas || '';
    const ins = await query(
      `INSERT INTO escala_template (dia_semana, turno, utilizador_id, notas)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dia_semana, turno, utilizador_id) DO UPDATE SET notas=EXCLUDED.notas
       RETURNING *`,
      [dia_semana, turno, u, n]
    );
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
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
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
