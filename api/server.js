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

// ── AUTH ──────────────────────────────────────────────────────
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
app.get('/api/auth/me', auth, async (req, res) => {
  const r = await query('SELECT id,email,nome,role FROM utilizadores WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── TURNOS ────────────────────────────────────────────────────
app.get('/api/turnos', auth, async (req, res) => {
  try {
    const r = await query(`SELECT t.*, u.nome as utilizador_nome FROM turnos t LEFT JOIN utilizadores u ON t.utilizador_id=u.id ORDER BY t.data DESC, t.id DESC LIMIT 30`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.get('/api/turnos/ativo', auth, async (req, res) => {
  try {
    const r = await query(`SELECT t.*, u.nome as utilizador_nome FROM turnos t LEFT JOIN utilizadores u ON t.utilizador_id=u.id WHERE t.estado='aberto' ORDER BY t.aberto_em DESC LIMIT 1`);
    res.json(r.rows[0] || null);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/turnos/abrir', auth, async (req, res) => {
  try {
    const { nome, fundo_inicial, notas } = req.body;
    const aberto = await query("SELECT id FROM turnos WHERE estado='aberto' AND nome=$1 AND data=CURRENT_DATE", [nome]);
    if (aberto.rows.length) return res.status(400).json({ erro: `Turno ${nome} já está aberto hoje` });
    const r = await query('INSERT INTO turnos (nome, data, utilizador_id, fundo_inicial, notas) VALUES ($1, CURRENT_DATE, $2, $3, $4) RETURNING *',
      [nome, req.user.id, fundo_inicial||0, notas||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/turnos/:id/fechar', auth, async (req, res) => {
  try {
    const { dinheiro_contado, notas } = req.body;
    const turno = await query('SELECT * FROM turnos WHERE id=$1', [req.params.id]);
    if (!turno.rows.length) return res.status(404).json({ erro: 'Turno não encontrado' });
    const t = turno.rows[0];
    const vendas = await query("SELECT COALESCE(SUM(total),0) as total, COALESCE(SUM(CASE WHEN metodo_pagamento='dinheiro' THEN total ELSE 0 END),0) as dinheiro, COALESCE(SUM(CASE WHEN metodo_pagamento='transferencia' THEN total ELSE 0 END),0) as transferencia, COALESCE(SUM(CASE WHEN metodo_pagamento='cartao' THEN total ELSE 0 END),0) as cartao, COUNT(*) as num FROM vendas WHERE turno_id=$1 AND estado!='cancelado'", [req.params.id]);
    const v = vendas.rows[0];
    const desp = await query('SELECT COALESCE(SUM(d.quantidade * p.preco_custo),0) as total FROM desperdicios d LEFT JOIN produtos p ON d.produto_id=p.id WHERE d.turno_id=$1', [req.params.id]);
    const diferenca = parseFloat(dinheiro_contado||0) - parseFloat(v.dinheiro);
    await query('INSERT INTO fechos_caixa (turno_id, utilizador_id, total_vendas, total_dinheiro, total_transferencia, total_cartao, dinheiro_contado, diferenca, num_vendas, total_desperdicio, notas) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (turno_id) DO UPDATE SET dinheiro_contado=$7, diferenca=$8, notas=$11',
      [req.params.id, req.user.id, v.total, v.dinheiro, v.transferencia, v.cartao, dinheiro_contado||0, diferenca, v.num, desp.rows[0].total, notas||'']);
    const r = await query('UPDATE turnos SET estado=$1, fechado_em=NOW(), total_vendas=$2, total_dinheiro=$3, total_transferencia=$4, total_cartao=$5, total_desperdicio=$6, notas=COALESCE($7,notas) WHERE id=$8 RETURNING *',
      ['fechado', v.total, v.dinheiro, v.transferencia, v.cartao, desp.rows[0].total, notas, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.get('/api/turnos/:id/relatorio', auth, async (req, res) => {
  try {
    const [turno, vendas, desperdicios, movimentos] = await Promise.all([
      query('SELECT t.*, u.nome as utilizador_nome FROM turnos t LEFT JOIN utilizadores u ON t.utilizador_id=u.id WHERE t.id=$1', [req.params.id]),
      query("SELECT COUNT(*) as num, COALESCE(SUM(total),0) as total, COALESCE(SUM(CASE WHEN metodo_pagamento='dinheiro' THEN total ELSE 0 END),0) as dinheiro, COALESCE(SUM(CASE WHEN metodo_pagamento='transferencia' THEN total ELSE 0 END),0) as transferencia, COALESCE(SUM(CASE WHEN metodo_pagamento='cartao' THEN total ELSE 0 END),0) as cartao FROM vendas WHERE turno_id=$1 AND estado!='cancelado'", [req.params.id]),
      query('SELECT d.*, p.nome as produto_nome FROM desperdicios d LEFT JOIN produtos p ON d.produto_id=p.id WHERE d.turno_id=$1', [req.params.id]),
      query('SELECT m.*, p.nome as produto_nome FROM movimentacoes m LEFT JOIN produtos p ON m.produto_id=p.id WHERE m.turno_id=$1', [req.params.id])
    ]);
    res.json({ turno: turno.rows[0], vendas: vendas.rows[0], desperdicios: desperdicios.rows, movimentos: movimentos.rows });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── MESAS ─────────────────────────────────────────────────────
app.get('/api/mesas', auth, async (req, res) => {
  try {
    const r = await query('SELECT m.*, c.id as comanda_id, c.num_pessoas, c.aberta_em FROM mesas m LEFT JOIN comandas c ON c.mesa_id=m.id AND c.estado=\'aberta\' ORDER BY m.numero');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.patch('/api/mesas/:id/estado', auth, async (req, res) => {
  try {
    const r = await query('UPDATE mesas SET estado=$1 WHERE id=$2 RETURNING *', [req.body.estado, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── COMANDAS ──────────────────────────────────────────────────
app.get('/api/comandas', auth, async (req, res) => {
  try {
    const r = await query(`SELECT c.*, m.numero as mesa_numero, u.nome as utilizador_nome,
      json_agg(json_build_object('id',ci.id,'produto_nome',p.nome,'quantidade',ci.quantidade,'preco_unitario',ci.preco_unitario,'subtotal',ci.subtotal,'estado',ci.estado,'notas',ci.notas)) FILTER (WHERE ci.id IS NOT NULL) as itens
      FROM comandas c LEFT JOIN mesas m ON c.mesa_id=m.id LEFT JOIN utilizadores u ON c.utilizador_id=u.id
      LEFT JOIN comanda_itens ci ON ci.comanda_id=c.id LEFT JOIN produtos p ON ci.produto_id=p.id
      WHERE c.estado='aberta' GROUP BY c.id, m.numero, u.nome ORDER BY c.aberta_em DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/comandas', auth, async (req, res) => {
  try {
    const { mesa_id, turno_id, num_pessoas, notas } = req.body;
    await query('UPDATE mesas SET estado=$1 WHERE id=$2', ['ocupada', mesa_id]);
    const r = await query('INSERT INTO comandas (mesa_id, turno_id, utilizador_id, num_pessoas, notas) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [mesa_id, turno_id, req.user.id, num_pessoas||1, notas||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/comandas/:id/itens', auth, async (req, res) => {
  try {
    const { produto_id, quantidade, notas } = req.body;
    const p = await query('SELECT preco_venda FROM produtos WHERE id=$1', [produto_id]);
    if (!p.rows.length) return res.status(404).json({ erro: 'Produto não encontrado' });
    const preco = p.rows[0].preco_venda;
    const subtotal = preco * quantidade;
    const r = await query('INSERT INTO comanda_itens (comanda_id, produto_id, quantidade, preco_unitario, subtotal, notas) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, produto_id, quantidade, preco, subtotal, notas||'']);
    await query('UPDATE comandas SET total = (SELECT COALESCE(SUM(subtotal),0) FROM comanda_itens WHERE comanda_id=$1 AND estado!=\'cancelado\') WHERE id=$1', [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/comandas/:id/fechar', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { metodo_pagamento, desconto, turno_id } = req.body;
    const comanda = await client.query('SELECT * FROM comandas WHERE id=$1', [req.params.id]);
    if (!comanda.rows.length) throw new Error('Comanda não encontrada');
    const c = comanda.rows[0];
    const itens = await client.query("SELECT ci.*, p.nome FROM comanda_itens ci LEFT JOIN produtos p ON ci.produto_id=p.id WHERE ci.comanda_id=$1 AND ci.estado!='cancelado'", [req.params.id]);
    let total = 0;
    for (const item of itens.rows) {
      total += parseFloat(item.subtotal);
      await client.query('UPDATE produtos SET stock_atual = stock_atual - $1 WHERE id=$2', [item.quantidade, item.produto_id]);
    }
    total = total - (desconto||0);
    const venda = await client.query('INSERT INTO vendas (cliente_nome, utilizador_id, metodo_pagamento, total, subtotal, desconto_pct, turno_id, mesa_id, comanda_id, estado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,\'concluido\') RETURNING *',
      ['Mesa ' + (c.mesa_id||''), req.user.id, metodo_pagamento||'dinheiro', total, total, desconto||0, turno_id||c.turno_id, c.mesa_id, c.id]);
    await client.query('UPDATE comandas SET estado=$1, fechada_em=NOW(), total=$2 WHERE id=$3', ['fechada', total, req.params.id]);
    await client.query('UPDATE mesas SET estado=$1 WHERE id=$2', ['livre', c.mesa_id]);
    await client.query('COMMIT');
    res.json(venda.rows[0]);
  } catch(e) { await client.query('ROLLBACK'); res.status(400).json({ erro: e.message }); }
  finally { client.release(); }
});
app.delete('/api/comandas/:id/itens/:itemId', auth, async (req, res) => {
  try {
    await query('UPDATE comanda_itens SET estado=$1 WHERE id=$2', ['cancelado', req.params.itemId]);
    await query('UPDATE comandas SET total=(SELECT COALESCE(SUM(subtotal),0) FROM comanda_itens WHERE comanda_id=$1 AND estado!=\'cancelado\') WHERE id=$1', [req.params.id]);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── DESPERDÍCIO ───────────────────────────────────────────────
app.get('/api/desperdicios', auth, async (req, res) => {
  try {
    const r = await query('SELECT d.*, p.nome as produto_nome, u.nome as utilizador_nome FROM desperdicios d LEFT JOIN produtos p ON d.produto_id=p.id LEFT JOIN utilizadores u ON d.utilizador_id=u.id ORDER BY d.created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/desperdicios', auth, async (req, res) => {
  try {
    const { turno_id, produto_id, quantidade, motivo } = req.body;
    await query('UPDATE produtos SET stock_atual = stock_atual - $1 WHERE id=$2', [quantidade, produto_id]);
    const r = await query('INSERT INTO desperdicios (turno_id, produto_id, quantidade, motivo, utilizador_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [turno_id, produto_id, quantidade, motivo, req.user.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ESCALAS ───────────────────────────────────────────────────
app.get('/api/escalas', auth, async (req, res) => {
  try {
    const r = await query('SELECT e.*, u.nome as utilizador_nome FROM escalas e LEFT JOIN utilizadores u ON e.utilizador_id=u.id ORDER BY e.data DESC, e.turno');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/escalas', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const { utilizador_id, data, turno } = req.body;
    const r = await query('INSERT INTO escalas (utilizador_id, data, turno) VALUES ($1,$2,$3) ON CONFLICT (utilizador_id,data,turno) DO NOTHING RETURNING *',
      [utilizador_id, data, turno]);
    res.json(r.rows[0] || { mensagem: 'Já existe' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.delete('/api/escalas/:id', auth, requireRole('admin','gestor'), async (req, res) => {
  try { await query('DELETE FROM escalas WHERE id=$1', [req.params.id]); res.json({ sucesso: true }); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── PRODUTOS ──────────────────────────────────────────────────
app.get('/api/produtos', auth, async (req, res) => {
  try {
    const r = await query('SELECT p.*, c.nome as categoria_nome, a.nome as armazem_nome FROM produtos p LEFT JOIN categorias c ON p.categoria_id=c.id LEFT JOIN armazens a ON p.armazem_id=a.id WHERE p.ativo=true ORDER BY p.nome');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/produtos', auth, async (req, res) => {
  try {
    const { nome, sku, categoria_id, armazem_id, stock_atual, stock_minimo, preco_custo, preco_venda, unidade, descricao } = req.body;
    const r = await query('INSERT INTO produtos (nome,sku,categoria_id,armazem_id,stock_atual,stock_minimo,preco_custo,preco_venda,unidade,descricao) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [nome, sku, categoria_id, armazem_id, stock_atual||0, stock_minimo||0, preco_custo||0, preco_venda||0, unidade||'un', descricao||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.put('/api/produtos/:id', auth, async (req, res) => {
  try {
    const { nome, sku, categoria_id, armazem_id, stock_minimo, preco_custo, preco_venda, unidade, descricao } = req.body;
    const r = await query('UPDATE produtos SET nome=$1,sku=$2,categoria_id=$3,armazem_id=$4,stock_minimo=$5,preco_custo=$6,preco_venda=$7,unidade=$8,descricao=$9 WHERE id=$10 RETURNING *',
      [nome, sku, categoria_id, armazem_id, stock_minimo, preco_custo, preco_venda, unidade, descricao, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.delete('/api/produtos/:id', auth, requireRole('admin'), async (req, res) => {
  try { await query('UPDATE produtos SET ativo=false WHERE id=$1', [req.params.id]); res.json({ sucesso: true }); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── CATEGORIAS ────────────────────────────────────────────────
app.get('/api/categorias', auth, async (req, res) => {
  try { const r = await query('SELECT * FROM categorias ORDER BY nome'); res.json(r.rows); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/categorias', auth, async (req, res) => {
  try {
    const r = await query('INSERT INTO categorias (nome,descricao) VALUES ($1,$2) RETURNING *', [req.body.nome, req.body.descricao||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ARMAZÉNS ──────────────────────────────────────────────────
app.get('/api/armazens', auth, async (req, res) => {
  try { const r = await query('SELECT * FROM armazens ORDER BY nome'); res.json(r.rows); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/armazens', auth, requireRole('admin'), async (req, res) => {
  try {
    const r = await query('INSERT INTO armazens (nome,localizacao) VALUES ($1,$2) RETURNING *', [req.body.nome, req.body.localizacao||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── MOVIMENTOS ────────────────────────────────────────────────
app.get('/api/movimentos', auth, async (req, res) => {
  try {
    const r = await query('SELECT m.*, p.nome as produto_nome, u.nome as utilizador_nome FROM movimentacoes m LEFT JOIN produtos p ON m.produto_id=p.id LEFT JOIN utilizadores u ON m.utilizador_id=u.id ORDER BY m.criado_em DESC LIMIT 100');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.post('/api/movimentos', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { produto_id, tipo, quantidade, motivo, referencia, turno_id } = req.body;
    const prod = await client.query('SELECT stock_atual FROM produtos WHERE id=$1 FOR UPDATE', [produto_id]);
    if (!prod.rows.length) throw new Error('Produto não encontrado');
    const qtdAtual = prod.rows[0].stock_atual;
    const qtdNova  = tipo === 'entrada' ? qtdAtual + quantidade : qtdAtual - quantidade;
    if (qtdNova < 0) throw new Error('Stock insuficiente');
    await client.query('UPDATE produtos SET stock_atual=$1 WHERE id=$2', [qtdNova, produto_id]);
    const r = await client.query('INSERT INTO movimentacoes (produto_id,tipo,quantidade,motivo,referencia,utilizador_id,turno_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [produto_id, tipo, quantidade, motivo||'', referencia||'', req.user.id, turno_id||null]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch(e) { await client.query('ROLLBACK'); res.status(400).json({ erro: e.message }); }
  finally { client.release(); }
});

// ── UTILIZADORES ──────────────────────────────────────────────
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
    const r = await query('UPDATE utilizadores SET nome=$1,role=$2,ativo=$3 WHERE id=$4 RETURNING id,email,nome,role,ativo', [nome, role, ativo, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [p, sb, turnoAtivo, vendasHoje, despHoje] = await Promise.all([
      query('SELECT COUNT(*) as total, COALESCE(SUM(stock_atual*preco_custo),0) as valor_total FROM produtos WHERE ativo=true'),
      query('SELECT COUNT(*) as total FROM produtos WHERE stock_atual<=stock_minimo AND ativo=true'),
      query("SELECT nome, aberto_em FROM turnos WHERE estado='aberto' ORDER BY aberto_em DESC LIMIT 1"),
      query("SELECT COUNT(*) as num, COALESCE(SUM(total),0) as valor FROM vendas WHERE DATE(criado_em)=CURRENT_DATE AND estado!='cancelado'"),
      query("SELECT COALESCE(SUM(d.quantidade*p.preco_custo),0) as valor FROM desperdicios d LEFT JOIN produtos p ON d.produto_id=p.id WHERE DATE(d.created_at)=CURRENT_DATE")
    ]);
    res.json({
      produtos: parseInt(p.rows[0].total),
      valor_stock: parseFloat(p.rows[0].valor_total)||0,
      stock_baixo: parseInt(sb.rows[0].total),
      turno_ativo: turnoAtivo.rows[0] || null,
      vendas_hoje: parseInt(vendasHoje.rows[0].num),
      valor_vendas_hoje: parseFloat(vendasHoje.rows[0].valor)||0,
      desperdicio_hoje: parseFloat(despHoje.rows[0].valor)||0
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => console.log(`StockOS API na porta ${PORT}`));
module.exports = app;function hashPassword(p) { return crypto.createHash('sha256').update(p + JWT_SECRET).digest('hex'); }
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
// ── AUTO-DEPLOY via GitHub API ────────────────────────────────
app.post('/api/deploy/update-file', async (req, res) => {
  try {
    const { file, content, message } = req.body;
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const REPO = 'esmeraldofr/stockos';
    if (!GITHUB_TOKEN) return res.status(500).json({ erro: 'GITHUB_TOKEN não configurado' });

    // Obter SHA actual do ficheiro
    const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${file}`, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    const fileData = await getRes.json();
    if (!fileData.sha) return res.status(400).json({ erro: 'Ficheiro não encontrado', detail: fileData });

    // Actualizar ficheiro
    const updateRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${file}`, {
      method: 'PUT',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
      body: JSON.stringify({ message: message || 'Auto-update via StockOS', content: Buffer.from(content).toString('base64'), sha: fileData.sha })
    });
    const result = await updateRes.json();
    if (result.commit) res.json({ sucesso: true, commit: result.commit.sha });
    else res.status(400).json({ erro: 'Erro ao actualizar', detail: result });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.listen(PORT, () => console.log(`StockOS API na porta ${PORT}`));
module.exports = app;
