require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stockos-secret-2025';

const pool  = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:LKB2DWbWbc60fZXh@db.dakleqewbwbryuchlrzm.supabase.co:5432/postgres', ssl: { rejectUnauthorized: false } });
const query = (text, params) => pool.query(text, params);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public'));

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
function hashPassword(p) { return crypto.createHash('sha256').update(p + JWT_SECRET).digest('hex'); }
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
  } catch(e) { res.status(500).json({ erro: 'Erro interno' }); }
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
        return { ...s, vendido: vend, valor: val, comparacao };
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
