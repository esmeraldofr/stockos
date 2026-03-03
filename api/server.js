require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stockos-secret-2025';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const query = (text, params) => pool.query(text, params);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public'));

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function createToken(payload) {
  const h = base64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const b = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now()/1000) + 8*3600 }));
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
  return (req, res, next) => { if (!roles.includes(req.user.role)) return res.status(403).json({ erro: 'Sem permissão' }); next(); };
}

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
  } catch(e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
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

app.post('/api/auth/alterar-password', auth, async (req, res) => {
  try {
    const { passwordAtual, passwordNova } = req.body;
    const r = await query('SELECT * FROM utilizadores WHERE id=$1', [req.user.id]);
    if (r.rows[0].senha_hash !== hashPassword(passwordAtual)) return res.status(400).json({ erro: 'Password actual incorrecta' });
    await query('UPDATE utilizadores SET senha_hash=$1 WHERE id=$2', [hashPassword(passwordNova), req.user.id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const r = await query('SELECT id,email,nome,role FROM utilizadores WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/produtos', auth, async (req, res) => {
  try {
    const r = await query('SELECT p.*, c.nome as categoria_nome, a.nome as armazem_nome FROM produtos p LEFT JOIN categorias c ON p.categoria_id=c.id LEFT JOIN armazens a ON p.armazem_id=a.id ORDER BY p.nome');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/produtos', auth, async (req, res) => {
  try {
    const { nome, sku, categoria_id, armazem_id, quantidade, quantidade_minima, preco_custo, preco_venda, unidade } = req.body;
    const r = await query('INSERT INTO produtos (nome,sku,categoria_id,armazem_id,quantidade,quantidade_minima,preco_custo,preco_venda,unidade) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [nome, sku, categoria_id, armazem_id, quantidade||0, quantidade_minima||0, preco_custo, preco_venda, unidade||'un']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.put('/api/produtos/:id', auth, async (req, res) => {
  try {
    const { nome, sku, categoria_id, armazem_id, quantidade_minima, preco_custo, preco_venda, unidade } = req.body;
    const r = await query('UPDATE produtos SET nome=$1,sku=$2,categoria_id=$3,armazem_id=$4,quantidade_minima=$5,preco_custo=$6,preco_venda=$7,unidade=$8 WHERE id=$9 RETURNING *',
      [nome, sku, categoria_id, armazem_id, quantidade_minima, preco_custo, preco_venda, unidade, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.delete('/api/produtos/:id', auth, requireRole('admin'), async (req, res) => {
  try { await query('DELETE FROM produtos WHERE id=$1', [req.params.id]); res.json({ sucesso: true }); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/categorias', auth, async (req, res) => {
  try { const r = await query('SELECT * FROM categorias ORDER BY nome'); res.json(r.rows); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/categorias', auth, async (req, res) => {
  try {
    const r = await query('INSERT INTO categorias (nome,descricao) VALUES ($1,$2) RETURNING *', [req.body.nome, req.body.descricao]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/armazens', auth, async (req, res) => {
  try { const r = await query('SELECT * FROM armazens ORDER BY nome'); res.json(r.rows); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/armazens', auth, requireRole('admin'), async (req, res) => {
  try {
    const r = await query('INSERT INTO armazens (nome,localizacao) VALUES ($1,$2) RETURNING *', [req.body.nome, req.body.localizacao]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/movimentos', auth, async (req, res) => {
  try {
    const r = await query('SELECT m.*, p.nome as produto_nome, p.sku, u.nome as utilizador_nome FROM movimentos m LEFT JOIN produtos p ON m.produto_id=p.id LEFT JOIN utilizadores u ON m.utilizador_id=u.id ORDER BY m.created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/movimentos', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { produto_id, tipo, quantidade, motivo, referencia } = req.body;
    const prod = await client.query('SELECT quantidade FROM produtos WHERE id=$1 FOR UPDATE', [produto_id]);
    if (!prod.rows.length) throw new Error('Produto não encontrado');
    const qtdAtual = prod.rows[0].quantidade;
    const qtdNova  = tipo === 'entrada' ? qtdAtual + quantidade : qtdAtual - quantidade;
    if (qtdNova < 0) throw new Error('Quantidade insuficiente em stock');
    await client.query('UPDATE produtos SET quantidade=$1 WHERE id=$2', [qtdNova, produto_id]);
    const r = await client.query('INSERT INTO movimentos (produto_id,tipo,quantidade,quantidade_anterior,quantidade_atual,motivo,referencia,utilizador_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [produto_id, tipo, quantidade, qtdAtual, qtdNova, motivo, referencia, req.user.id]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch(e) { await client.query('ROLLBACK'); res.status(400).json({ erro: e.message }); }
  finally { client.release(); }
});

app.get('/api/vendas', auth, async (req, res) => {
  try {
    const r = await query("SELECT v.*, u.nome as utilizador_nome, json_agg(json_build_object('produto_nome',p.nome,'quantidade',iv.quantidade,'preco_unitario',iv.preco_unitario)) as itens FROM vendas v LEFT JOIN itens_venda iv ON v.id=iv.venda_id LEFT JOIN produtos p ON iv.produto_id=p.id LEFT JOIN utilizadores u ON v.utilizador_id=u.id GROUP BY v.id, u.nome ORDER BY v.created_at DESC LIMIT 50");
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/vendas', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { cliente, itens, desconto, notas } = req.body;
    let total = 0;
    for (const item of itens) {
      const p = await client.query('SELECT quantidade,preco_venda FROM produtos WHERE id=$1 FOR UPDATE', [item.produto_id]);
      if (p.rows[0].quantidade < item.quantidade) throw new Error('Stock insuficiente');
      total += p.rows[0].preco_venda * item.quantidade;
    }
    total -= desconto || 0;
    const venda = await client.query('INSERT INTO vendas (cliente,total,desconto,notas,utilizador_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [cliente, total, desconto||0, notas, req.user.id]);
    for (const item of itens) {
      const p = await client.query('SELECT preco_venda FROM produtos WHERE id=$1', [item.produto_id]);
      await client.query('INSERT INTO itens_venda (venda_id,produto_id,quantidade,preco_unitario) VALUES ($1,$2,$3,$4)',
        [venda.rows[0].id, item.produto_id, item.quantidade, p.rows[0].preco_venda]);
      await client.query('UPDATE produtos SET quantidade=quantidade-$1 WHERE id=$2', [item.quantidade, item.produto_id]);
    }
    await client.query('COMMIT');
    res.json(venda.rows[0]);
  } catch(e) { await client.query('ROLLBACK'); res.status(400).json({ erro: e.message }); }
  finally { client.release(); }
});
app.patch('/api/vendas/:id/cancelar', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const r = await query("UPDATE vendas SET estado='cancelado' WHERE id=$1 RETURNING *", [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try { const r = await query('SELECT id,email,nome,role,ativo FROM utilizadores ORDER BY nome'); res.json(r.rows); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try {
    const { email, nome, role } = req.body;
    const r = await query('INSERT INTO utilizadores (email,nome,role,senha_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,nome,role',
      [email, nome, role, hashPassword('StockOS2025!')]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.put('/api/utilizadores/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const { nome, role, ativo } = req.body;
    const r = await query('UPDATE utilizadores SET nome=$1,role=$2,ativo=$3 WHERE id=$4 RETURNING id,email,nome,role,ativo',
      [nome, role, ativo, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [p, sb, m, v] = await Promise.all([
      query('SELECT COUNT(*) as total, SUM(quantidade*preco_custo) as valor_total FROM produtos'),
      query('SELECT COUNT(*) as total FROM produtos WHERE quantidade<=quantidade_minima'),
      query("SELECT COUNT(*) as total FROM movimentos WHERE created_at>NOW()-INTERVAL '30 days'"),
      query("SELECT COUNT(*) as total, COALESCE(SUM(total),0) as valor FROM vendas WHERE created_at>NOW()-INTERVAL '30 days' AND estado!='cancelado'")
    ]);
    res.json({ produtos: parseInt(p.rows[0].total), valor_stock: parseFloat(p.rows[0].valor_total)||0,
      stock_baixo: parseInt(sb.rows[0].total), movimentos_mes: parseInt(m.rows[0].total),
      vendas_mes: parseInt(v.rows[0].total), valor_vendas_mes: parseFloat(v.rows[0].valor)||0 });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => console.log(`StockOS API na porta ${PORT}`));
module.exports = app;
