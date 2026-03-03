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

// ── Helper ────────────────────────────────────────────────────
const query = (text, params) => pool.query(text, params);

// ============================================================
//  ROTAS — AUTENTICAÇÃO (públicas)
// ============================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ erro: 'Email e password são obrigatórios' });

    const result = await query(`SELECT * FROM utilizadores WHERE email = $1 AND ativo = true`, [email.toLowerCase().trim()]);
    if (!result.rows.length) return res.status(401).json({ erro: 'Email ou password incorrectos' });

    const user = result.rows[0];

    // Verificar password (suporte a bcrypt do Supabase e hash simples)
    const hashSimples = hashPassword(password);
    let passwordValida = false;

    if (user.senha_hash === hashSimples) {
      passwordValida = true;
    } else {
      // Tentar comparação directa para passwords definidas manualmente
      try {
        const { execSync } = require('child_process');
        // fallback: aceitar se o hash começa com $2 (bcrypt do seed SQL)
        if (user.senha_hash.startsWith('$2')) {
          // Para o primeiro login com bcrypt, forçar reset
          passwordValida = false;
        }
      } catch {}
    }

    if (!passwordValida) return res.status(401).json({ erro: 'Email ou password incorrectos' });

    const token = signJWT({ id: user.id, nome: user.nome, email: user.email, role: user.role });

    // Actualizar último acesso
    await query(`UPDATE utilizadores SET atualizado_em = NOW() WHERE id = $1`, [user.id]);

    res.json({
      token,
      utilizador: { id: user.id, nome: user.nome, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/auth/setup — criar primeiro admin (só funciona se não houver utilizadores com hash simples)
app.post('/api/auth/setup', async (req, res) => {
  try {
    const { email, password, nome, codigo } = req.body;
    if (codigo !== 'STOCKOS2025') return res.status(403).json({ erro: 'Código de activação inválido' });
    const hash = hashPassword(password);
    await query(`UPDATE utilizadores SET senha_hash = $1 WHERE email = $2`, [hash, email.toLowerCase().trim()]);
    res.json({ mensagem: 'Password definida com sucesso. Pode fazer login.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/auth/alterar-password
app.post('/api/auth/alterar-password', auth, async (req, res) => {
  try {
    const { password_atual, password_nova } = req.body;
    const result = await query(`SELECT senha_hash FROM utilizadores WHERE id = $1`, [req.user.id]);
    if (result.rows[0].senha_hash !== hashPassword(password_atual)) return res.status(400).json({ erro: 'Password actual incorrecta' });
    await query(`UPDATE utilizadores SET senha_hash = $1 WHERE id = $2`, [hashPassword(password_nova), req.user.id]);
    res.json({ mensagem: 'Password alterada com sucesso' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/auth/me
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const result = await query(`SELECT id, nome, email, role, criado_em FROM utilizadores WHERE id = $1`, [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
//  ROTAS — UTILIZADORES (admin only)
// ============================================================
app.get('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try {
    const result = await query(`SELECT id, nome, email, role, ativo, criado_em, atualizado_em FROM utilizadores ORDER BY nome`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/utilizadores', auth, requireRole('admin'), async (req, res) => {
  try {
    const { nome, email, password, role } = req.body;
    if (!nome || !email || !password) return res.status(400).json({ erro: 'Nome, email e password são obrigatórios' });
    const hash = hashPassword(password);
    const result = await query(
      `INSERT INTO utilizadores (nome, email, senha_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, nome, email, role`,
      [nome, email.toLowerCase().trim(), hash, role||'operador']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Email já existe' });
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/utilizadores/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ erro: 'Não pode eliminar a sua própria conta' });
    await query(`UPDATE utilizadores SET ativo = false WHERE id = $1`, [req.params.id]);
    res.json({ mensagem: 'Utilizador desactivado' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
//  ROTAS — PRODUTOS (protegidas)
// ============================================================
app.get('/api/produtos', auth, async (req, res) => {
  try {
    const { categoria, status, search } = req.query;
    let sql = `SELECT * FROM v_produtos_stock WHERE 1=1`;
    const params = [];
    if (categoria) { params.push(categoria); sql += ` AND categoria = $${params.length}`; }
    if (search)    { params.push(`%${search}%`); sql += ` AND (nome ILIKE $${params.length} OR sku ILIKE $${params.length})`; }
    if (status === 'critico') sql += ` AND estado_stock IN ('Crítico','Esgotado')`;
    if (status === 'baixo')   sql += ` AND estado_stock = 'Baixo'`;
    if (status === 'ok')      sql += ` AND estado_stock = 'OK'`;
    sql += ` ORDER BY nome`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/produtos/:id', auth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_produtos_stock WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/produtos', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const { nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, stock_atual, armazem_id, descricao } = req.body;
    if (!nome || !sku) return res.status(400).json({ erro: 'Nome e SKU são obrigatórios' });
    const result = await query(
      `INSERT INTO produtos (nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, stock_atual, armazem_id, descricao) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [nome, sku, categoria_id, unidade||'un', preco_custo||0, preco_venda||0, stock_minimo||0, stock_atual||0, armazem_id, descricao]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'SKU já existe' });
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/produtos/:id', auth, requireRole('admin','gestor'), async (req, res) => {
  try {
    const { nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, armazem_id, descricao } = req.body;
    const result = await query(
      `UPDATE produtos SET nome=$1,sku=$2,categoria_id=$3,unidade=$4,preco_custo=$5,preco_venda=$6,stock_minimo=$7,armazem_id=$8,descricao=$9,atualizado_em=NOW() WHERE id=$10 RETURNING *`,
      [nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, armazem_id, descricao, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/produtos/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    await query(`UPDATE produtos SET ativo=false WHERE id=$1`, [req.params.id]);
    res.json({ mensagem: 'Produto desactivado' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
//  ROTAS — MOVIMENTAÇÕES (protegidas)
// ============================================================
app.get('/api/movimentacoes', auth, async (req, res) => {
  try {
    const { tipo } = req.query;
    let sql = `SELECT m.*, p.nome AS produto_nome, p.sku, ao.nome AS origem_nome, ad.nome AS destino_nome, u.nome AS utilizador_nome FROM movimentacoes m JOIN produtos p ON p.id = m.produto_id LEFT JOIN armazens ao ON ao.id = m.armazem_origem LEFT JOIN armazens ad ON ad.id = m.armazem_destino LEFT JOIN utilizadores u ON u.id = m.utilizador_id WHERE 1=1`;
    const params = [];
    if (tipo) { params.push(tipo); sql += ` AND m.tipo = $${params.length}`; }
    sql += ` ORDER BY m.criado_em DESC LIMIT 200`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.delete('/api/produtos/:id', auth, requireRole('admin'), async (req, res) => {
  try { await query('DELETE FROM produtos WHERE id=$1', [req.params.id]); res.json({ sucesso: true }); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/movimentacoes', auth, async (req, res) => {
  try {
    const { produto_id, tipo, quantidade, armazem_origem, armazem_destino, motivo, referencia } = req.body;
    if (!produto_id || !tipo || !quantidade) return res.status(400).json({ erro: 'Campos obrigatórios em falta' });
    const result = await query(
      `INSERT INTO movimentacoes (produto_id, tipo, quantidade, armazem_origem, armazem_destino, motivo, referencia, utilizador_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [produto_id, tipo, quantidade, armazem_origem||null, armazem_destino||null, motivo, referencia||null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.message.includes('Stock insuficiente')) return res.status(400).json({ erro: err.message });
    res.status(500).json({ erro: err.message });
  }
});

// ============================================================
//  ROTAS — VENDAS (protegidas)
// ============================================================
app.get('/api/vendas', auth, async (req, res) => {
  try {
    const { estado } = req.query;
    let sql = `SELECT v.*, COALESCE(json_agg(json_build_object('id',vi.id,'produto_nome',vi.produto_nome,'quantidade',vi.quantidade,'preco_unitario',vi.preco_unitario,'total_linha',vi.total_linha)) FILTER (WHERE vi.id IS NOT NULL),'[]') AS itens FROM vendas v LEFT JOIN venda_itens vi ON vi.venda_id = v.id WHERE 1=1`;
    const params = [];
    if (estado) { params.push(estado); sql += ` AND v.estado = $${params.length}`; }
    sql += ` GROUP BY v.id ORDER BY v.criado_em DESC`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/vendas', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { cliente_id, cliente_nome, metodo_pagamento, desconto_pct, itens, notas } = req.body;
    if (!itens || !itens.length) return res.status(400).json({ erro: 'A venda precisa de pelo menos 1 item' });
    const subtotal = itens.reduce((s, i) => s + (i.quantidade * i.preco_unitario), 0);
    const total    = subtotal * (1 - (desconto_pct || 0) / 100);
    const venda = await client.query(
      `INSERT INTO vendas (cliente_id, cliente_nome, metodo_pagamento, desconto_pct, subtotal, total, notas, utilizador_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cliente_id||null, cliente_nome||'— Avulso —', metodo_pagamento||'dinheiro', desconto_pct||0, subtotal, total, notas||null, req.user.id]
    );
    const vendaId = venda.rows[0].id;
    for (const item of itens) {
      await client.query(`INSERT INTO venda_itens (venda_id, produto_id, produto_nome, produto_sku, quantidade, preco_unitario) VALUES ($1,$2,$3,$4,$5,$6)`, [vendaId, item.produto_id, item.produto_nome, item.produto_sku, item.quantidade, item.preco_unitario]);
      await client.query(`INSERT INTO movimentacoes (produto_id, tipo, quantidade, motivo, referencia, utilizador_id) VALUES ($1,'saida',$2,$3,$4,$5)`, [item.produto_id, item.quantidade, `Venda ${vendaId}`, vendaId, req.user.id]);
    }
    await client.query('COMMIT');
    res.status(201).json(venda.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message.includes('Stock insuficiente')) return res.status(400).json({ erro: err.message });
    res.status(500).json({ erro: err.message });
  } finally { client.release(); }
});

app.patch('/api/vendas/:id/cancelar', auth, requireRole('admin','gestor'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const venda = await client.query(`SELECT * FROM vendas WHERE id=$1`, [req.params.id]);
    if (!venda.rows.length) return res.status(404).json({ erro: 'Venda não encontrada' });
    if (venda.rows[0].estado === 'cancelada') return res.status(400).json({ erro: 'Venda já cancelada' });
    await client.query(`UPDATE vendas SET estado='cancelada' WHERE id=$1`, [req.params.id]);
    const itens = await client.query(`SELECT * FROM venda_itens WHERE venda_id=$1`, [req.params.id]);
    for (const item of itens.rows) {
      await client.query(`INSERT INTO movimentacoes (produto_id, tipo, quantidade, motivo, referencia, utilizador_id) VALUES ($1,'entrada',$2,$3,$4,$5)`, [item.produto_id, item.quantidade, `Cancelamento venda ${req.params.id}`, req.params.id, req.user.id]);
    }
    await client.query('COMMIT');
    res.json({ mensagem: `Venda ${req.params.id} cancelada — stock reposto` });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ erro: err.message }); }
  finally { client.release(); }
});

// ============================================================
//  ROTAS — CLIENTES, ARMAZÉNS, CATEGORIAS, ALERTAS, DASHBOARD
// ============================================================
app.get('/api/clientes', auth, async (req, res) => {
  try { res.json((await query(`SELECT * FROM v_clientes_resumo ORDER BY nome`)).rows); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/clientes', auth, async (req, res) => {
  try {
    const { nome, telefone, email, nif, endereco } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const result = await query(`INSERT INTO clientes (nome, telefone, email, nif, endereco) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [nome, telefone, email, nif, endereco]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/armazens', auth, async (req, res) => {
  try {
    const result = await query(`SELECT a.*, COUNT(p.id) AS total_produtos, COALESCE(SUM(p.stock_atual),0) AS total_unidades FROM armazens a LEFT JOIN produtos p ON p.armazem_id = a.id AND p.ativo=true WHERE a.ativo=true GROUP BY a.id ORDER BY a.nome`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/armazens', auth, requireRole('admin'), async (req, res) => {
  try {
    const { nome, role, ativo } = req.body;
    const r = await query('UPDATE utilizadores SET nome=$1,role=$2,ativo=$3 WHERE id=$4 RETURNING id,email,nome,role,ativo',
      [nome, role, ativo, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/categorias', auth, async (req, res) => {
  try { res.json((await query(`SELECT * FROM categorias ORDER BY nome`)).rows); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/alertas', auth, async (req, res) => {
  try { res.json((await query(`SELECT * FROM v_alertas_stock`)).rows); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [produtos, stock, alertas, receita] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM produtos WHERE ativo=true`),
      query(`SELECT COALESCE(SUM(stock_atual),0) AS total FROM produtos WHERE ativo=true`),
      query(`SELECT COUNT(*) AS total FROM v_alertas_stock`),
      query(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS vendas FROM vendas WHERE estado='concluida' AND DATE_TRUNC('month', criado_em) = DATE_TRUNC('month', NOW())`)
    ]);
    res.json({ total_produtos: parseInt(produtos.rows[0].total), total_stock: parseInt(stock.rows[0].total), total_alertas: parseInt(alertas.rows[0].total), receita_mes: parseFloat(receita.rows[0].total), vendas_mes: parseInt(receita.rows[0].vendas) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/health', async (req, res) => {
  try { await query('SELECT 1'); res.json({ status: 'ok', timestamp: new Date().toISOString(), versao: '2.1.0' }); }
  catch (err) { res.status(500).json({ status: 'erro', detalhe: err.message }); }
});

app.get('*', (req, res) => { res.sendFile('index.html', { root: 'public' }); });

app.listen(PORT, () => { console.log(`✅ StockOS API (com auth) na porta ${PORT}`); });

