require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stockos-secret-2025';
const PWD_SALT   = 'stockos-pwd-salt-2025';

const _dbUrl = process.env.DATABASE_URL || '';
const _poolerUrl = 'postgresql://postgres.dakleqewbwbryuchlrzm:LKB2DWbWbc60fZXh@aws-1-eu-west-1.pooler.supabase.com:6543/postgres';
const pool  = new Pool({ connectionString: (_dbUrl && _dbUrl.includes('pooler.supabase.com')) ? _dbUrl : _poolerUrl, ssl: { rejectUnauthorized: false } });
const query = (text, params) => pool.query(text, params);

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
    categoria VARCHAR(20) NOT NULL DEFAULT 'outro', ordem INTEGER NOT NULL DEFAULT 0, ativo BOOLEAN NOT NULL DEFAULT TRUE
  )`, [], 'produtos');
  await qry(`CREATE TABLE IF NOT EXISTS turnos (
    id SERIAL PRIMARY KEY, data DATE NOT NULL DEFAULT CURRENT_DATE, nome VARCHAR(10) NOT NULL CHECK (nome IN ('manha','tarde','noite')),
    utilizador_id INTEGER REFERENCES utilizadores(id) ON DELETE SET NULL,
    estado VARCHAR(10) NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto','fechado')),
    notas TEXT NOT NULL DEFAULT '', criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), fechado_em TIMESTAMPTZ, UNIQUE(data, nome)
  )`, [], 'turnos');
  await qry(`CREATE TABLE IF NOT EXISTS turno_stock (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    encontrado NUMERIC(10,3) NOT NULL DEFAULT 0, entrada NUMERIC(10,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id, produto_id)
  )`, [], 'turno_stock');
  await qry(`CREATE TABLE IF NOT EXISTS turno_caixa (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
    tpa NUMERIC(15,2) NOT NULL DEFAULT 0, transferencia NUMERIC(15,2) NOT NULL DEFAULT 0,
    dinheiro NUMERIC(15,2) NOT NULL DEFAULT 0, saida NUMERIC(15,2) NOT NULL DEFAULT 0
  )`, [], 'turno_caixa');
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
  await run(`ALTER TABLE produtos ALTER COLUMN sku SET DEFAULT ''`, 'sku-default');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco NUMERIC(15,2) NOT NULL DEFAULT 0`, 'preco');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria VARCHAR(20) NOT NULL DEFAULT 'outro'`, 'categoria');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ordem INTEGER NOT NULL DEFAULT 0`, 'ordem');
  await run(`ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE`, 'ativo');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT ''`, 'notas');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`, 'criado_em');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS fechado_em TIMESTAMPTZ`, 'fechado_em');
  await run(`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'aberto'`, 'estado');
  await run(`CREATE TABLE IF NOT EXISTS turno_stock (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    encontrado NUMERIC(10,3) NOT NULL DEFAULT 0, entrada NUMERIC(10,3) NOT NULL DEFAULT 0,
    deixado NUMERIC(10,3) NOT NULL DEFAULT 0, UNIQUE(turno_id, produto_id))`, 'turno_stock');
  await run(`CREATE TABLE IF NOT EXISTS turno_caixa (
    id SERIAL PRIMARY KEY, turno_id INTEGER NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
    tpa NUMERIC(15,2) NOT NULL DEFAULT 0, transferencia NUMERIC(15,2) NOT NULL DEFAULT 0,
    dinheiro NUMERIC(15,2) NOT NULL DEFAULT 0, saida NUMERIC(15,2) NOT NULL DEFAULT 0)`, 'turno_caixa');
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
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ erro: 'Email e password obrigatórios' });
    const r = await query('SELECT * FROM utilizadores WHERE email=$1 AND ativo=true', [email]);
    if (!r.rows.length) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const user = r.rows[0];
    if (user.senha_hash !== hashPassword(password)) return res.status(401).json({ erro: 'Credenciais inválidas' });
    const token = createToken({ id: user.id, email: user.email, nome: user.nome, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, nome: user.nome, role: user.role } });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/auth/setup', async (req, res) => {
  try {
    const { email, codigo, password } = req.body;
    if (codigo !== 'STOCKOS2025') return res.status(400).json({ erro: 'Código inválido' });
    if (!password || password.length < 6) return res.status(400).json({ erro: 'Password deve ter pelo menos 6 caracteres' });
    const r = await query('SELECT * FROM utilizadores WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Utilizador não encontrado' });
    await query('UPDATE utilizadores SET senha_hash=$1 WHERE email=$2', [hashPassword(password), email]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const r = await query('SELECT id,email,nome,role FROM utilizadores WHERE id=$1', [req.user.id]);
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

app.post('/api/produtos', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const { nome, preco, categoria } = req.body;
    const maxOrdem = await query('SELECT COALESCE(MAX(ordem),0)+1 as n FROM produtos');
    const r = await query(
      'INSERT INTO produtos (nome,preco,categoria,ordem) VALUES ($1,$2,$3,$4) RETURNING *',
      [nome, preco||0, categoria||'outro', maxOrdem.rows[0].n]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/produtos/:id', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const { nome, preco, categoria, ordem, ativo } = req.body;
    const r = await query(
      'UPDATE produtos SET nome=$1,preco=$2,categoria=$3,ordem=$4,ativo=$5 WHERE id=$6 RETURNING *',
      [nome, preco, categoria, ordem, ativo, req.params.id]
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
        `SELECT ts.*, p.nome as produto_nome, p.preco, p.categoria, p.ordem
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
    const { produto_id, encontrado, entrada, deixado } = req.body;
    const r = await query(
      `INSERT INTO turno_stock (turno_id, produto_id, encontrado, entrada, deixado)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (turno_id, produto_id)
       DO UPDATE SET encontrado=$3, entrada=$4, deixado=$5
       RETURNING *`,
      [req.params.id, produto_id, encontrado||0, entrada||0, deixado||0]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/turnos/:id/caixa', auth, async (req, res) => {
  try {
    const { tpa, transferencia, dinheiro, saida } = req.body;
    const r = await query(
      `INSERT INTO turno_caixa (turno_id, tpa, transferencia, dinheiro, saida)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (turno_id)
       DO UPDATE SET tpa=$2, transferencia=$3, dinheiro=$4, saida=$5
       RETURNING *`,
      [req.params.id, tpa||0, transferencia||0, dinheiro||0, saida||0]
    );
    const c = r.rows[0];
    c.total_gerado = parseFloat(c.tpa) + parseFloat(c.transferencia) + parseFloat(c.dinheiro);
    c.total_final  = c.total_gerado - parseFloat(c.saida);
    res.json(c);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req, res) => {
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
      const receita = await client.query(
        'SELECT componente_id, quantidade FROM receitas WHERE produto_id=$1',
        [produto_id]
      );
      for (const comp of receita.rows) {
        const deducao = delta * parseFloat(comp.quantidade);
        await client.query(
          `UPDATE turno_stock SET deixado=GREATEST(0, deixado - $1)
           WHERE turno_id=$2 AND produto_id=$3`,
          [deducao, turnoId, comp.componente_id]
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
    const r = await query('SELECT id,email,nome,role,ativo FROM utilizadores ORDER BY nome');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try {
    const { email, nome, role } = req.body;
    const r = await query(
      'INSERT INTO utilizadores (email,nome,role,senha_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,nome,role',
      [email, nome, role||'operador', hashPassword('StockOS2025!')]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/utilizadores/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const { nome, role, ativo, password } = req.body;
    if (password) {
      await query('UPDATE utilizadores SET senha_hash=$1 WHERE id=$2', [hashPassword(password), req.params.id]);
    }
    const r = await query(
      'UPDATE utilizadores SET nome=$1,role=$2,ativo=$3 WHERE id=$4 RETURNING id,email,nome,role,ativo',
      [nome, role, ativo, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => console.log(`StockOS v3 na porta ${PORT}`));
module.exports = app;
