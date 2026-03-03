// ============================================================
//  StockOS — Servidor API (Express + PostgreSQL)
//  Ficheiro: api/server.js 
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Base de dados ────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // necessário para Supabase
});

// ── Middleware ────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || '*',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ]
}));
app.use(express.json());
app.use(express.static('public'));  // servir o frontend

// ── Helper ────────────────────────────────────────────────────
const query = (text, params) => pool.query(text, params);

// ============================================================
//  ROTAS — PRODUTOS
// ============================================================

// GET /api/produtos — listar todos
app.get('/api/produtos', async (req, res) => {
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
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/produtos/:id
app.get('/api/produtos/:id', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_produtos_stock WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/produtos — criar
app.post('/api/produtos', async (req, res) => {
  try {
    const { nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, stock_atual, armazem_id, descricao } = req.body;
    if (!nome || !sku) return res.status(400).json({ erro: 'Nome e SKU são obrigatórios' });

    const result = await query(`
      INSERT INTO produtos (nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, stock_atual, armazem_id, descricao)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [nome, sku, categoria_id, unidade||'un', preco_custo||0, preco_venda||0, stock_minimo||0, stock_atual||0, armazem_id, descricao]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'SKU já existe' });
    res.status(500).json({ erro: err.message });
  }
});

// PUT /api/produtos/:id — actualizar
app.put('/api/produtos/:id', async (req, res) => {
  try {
    const { nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, armazem_id, descricao } = req.body;
    const result = await query(`
      UPDATE produtos SET nome=$1, sku=$2, categoria_id=$3, unidade=$4, preco_custo=$5,
        preco_venda=$6, stock_minimo=$7, armazem_id=$8, descricao=$9, atualizado_em=NOW()
      WHERE id=$10 RETURNING *`,
      [nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, armazem_id, descricao, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// DELETE /api/produtos/:id — desactivar (soft delete)
app.delete('/api/produtos/:id', async (req, res) => {
  try {
    await query(`UPDATE produtos SET ativo=false WHERE id=$1`, [req.params.id]);
    res.json({ mensagem: 'Produto desactivado com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ============================================================
//  ROTAS — MOVIMENTAÇÕES
// ============================================================

// GET /api/movimentacoes
app.get('/api/movimentacoes', async (req, res) => {
  try {
    const { tipo } = req.query;
    let sql = `
      SELECT m.*, p.nome AS produto_nome, p.sku,
             ao.nome AS origem_nome, ad.nome AS destino_nome,
             u.nome AS utilizador_nome
      FROM movimentacoes m
      JOIN produtos p ON p.id = m.produto_id
      LEFT JOIN armazens ao ON ao.id = m.armazem_origem
      LEFT JOIN armazens ad ON ad.id = m.armazem_destino
      LEFT JOIN utilizadores u ON u.id = m.utilizador_id
      WHERE 1=1`;
    const params = [];
    if (tipo) { params.push(tipo); sql += ` AND m.tipo = $${params.length}`; }
    sql += ` ORDER BY m.criado_em DESC LIMIT 200`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/movimentacoes — registar nova (trigger actualiza stock)
app.post('/api/movimentacoes', async (req, res) => {
  try {
    const { produto_id, tipo, quantidade, armazem_origem, armazem_destino, motivo, referencia } = req.body;
    if (!produto_id || !tipo || !quantidade) return res.status(400).json({ erro: 'Campos obrigatórios em falta' });

    const result = await query(`
      INSERT INTO movimentacoes (produto_id, tipo, quantidade, armazem_origem, armazem_destino, motivo, referencia)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [produto_id, tipo, quantidade, armazem_origem||null, armazem_destino||null, motivo, referencia||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.message.includes('Stock insuficiente')) return res.status(400).json({ erro: err.message });
    res.status(500).json({ erro: err.message });
  }
});

// ============================================================
//  ROTAS — VENDAS
// ============================================================

// GET /api/vendas
app.get('/api/vendas', async (req, res) => {
  try {
    const { estado } = req.query;
    let sql = `
      SELECT v.*, 
             COALESCE(json_agg(json_build_object(
               'id', vi.id, 'produto_nome', vi.produto_nome,
               'quantidade', vi.quantidade, 'preco_unitario', vi.preco_unitario,
               'total_linha', vi.total_linha
             )) FILTER (WHERE vi.id IS NOT NULL), '[]') AS itens
      FROM vendas v
      LEFT JOIN venda_itens vi ON vi.venda_id = v.id
      WHERE 1=1`;
    const params = [];
    if (estado) { params.push(estado); sql += ` AND v.estado = $${params.length}`; }
    sql += ` GROUP BY v.id ORDER BY v.criado_em DESC`;
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/vendas — criar venda completa
app.post('/api/vendas', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { cliente_id, cliente_nome, metodo_pagamento, desconto_pct, itens, notas } = req.body;
    if (!itens || !itens.length) return res.status(400).json({ erro: 'A venda precisa de pelo menos 1 item' });

    const subtotal = itens.reduce((s, i) => s + (i.quantidade * i.preco_unitario), 0);
    const total    = subtotal * (1 - (desconto_pct || 0) / 100);

    // Criar cabeçalho da venda (trigger gera o ID automático)
    const venda = await client.query(`
      INSERT INTO vendas (cliente_id, cliente_nome, metodo_pagamento, desconto_pct, subtotal, total, notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cliente_id||null, cliente_nome||'— Avulso —', metodo_pagamento||'dinheiro', desconto_pct||0, subtotal, total, notas||null]
    );
    const vendaId = venda.rows[0].id;

    // Inserir itens e baixar stock
    for (const item of itens) {
      await client.query(`
        INSERT INTO venda_itens (venda_id, produto_id, produto_nome, produto_sku, quantidade, preco_unitario)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [vendaId, item.produto_id, item.produto_nome, item.produto_sku, item.quantidade, item.preco_unitario]
      );
      // Regista movimentação de saída (trigger baixa o stock)
      await client.query(`
        INSERT INTO movimentacoes (produto_id, tipo, quantidade, motivo, referencia)
        VALUES ($1, 'saida', $2, $3, $4)`,
        [item.produto_id, item.quantidade, `Venda ${vendaId}`, vendaId]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(venda.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message.includes('Stock insuficiente')) return res.status(400).json({ erro: err.message });
    res.status(500).json({ erro: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/vendas/:id/cancelar
app.patch('/api/vendas/:id/cancelar', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const venda = await client.query(`SELECT * FROM vendas WHERE id=$1`, [req.params.id]);
    if (!venda.rows.length) return res.status(404).json({ erro: 'Venda não encontrada' });
    if (venda.rows[0].estado === 'cancelada') return res.status(400).json({ erro: 'Venda já cancelada' });

    await client.query(`UPDATE vendas SET estado='cancelada' WHERE id=$1`, [req.params.id]);

    // Repor stock
    const itens = await client.query(`SELECT * FROM venda_itens WHERE venda_id=$1`, [req.params.id]);
    for (const item of itens.rows) {
      await client.query(`
        INSERT INTO movimentacoes (produto_id, tipo, quantidade, motivo, referencia)
        VALUES ($1, 'entrada', $2, $3, $4)`,
        [item.produto_id, item.quantidade, `Cancelamento venda ${req.params.id}`, req.params.id]
      );
    }

    await client.query('COMMIT');
    res.json({ mensagem: `Venda ${req.params.id} cancelada — stock reposto` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ erro: err.message });
  } finally {
    client.release();
  }
});

// ============================================================
//  ROTAS — CLIENTES
// ============================================================
app.get('/api/clientes', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_clientes_resumo ORDER BY nome`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/clientes', async (req, res) => {
  try {
    const { nome, telefone, email, nif, endereco } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const result = await query(`
      INSERT INTO clientes (nome, telefone, email, nif, endereco)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [nome, telefone, email, nif, endereco]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
//  ROTAS — ARMAZÉNS
// ============================================================
app.get('/api/armazens', async (req, res) => {
  try {
    const result = await query(`
      SELECT a.*, COUNT(p.id) AS total_produtos, COALESCE(SUM(p.stock_atual),0) AS total_unidades
      FROM armazens a LEFT JOIN produtos p ON p.armazem_id = a.id AND p.ativo=true
      WHERE a.ativo=true GROUP BY a.id ORDER BY a.nome`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/armazens', async (req, res) => {
  try {
    const { nome, endereco, responsavel } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const result = await query(`INSERT INTO armazens (nome, endereco, responsavel) VALUES ($1,$2,$3) RETURNING *`, [nome, endereco, responsavel]);
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
//  ROTAS — ALERTAS & DASHBOARD
// ============================================================
app.get('/api/alertas', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM v_alertas_stock`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const [produtos, stock, alertas, receita] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM produtos WHERE ativo=true`),
      query(`SELECT COALESCE(SUM(stock_atual),0) AS total FROM produtos WHERE ativo=true`),
      query(`SELECT COUNT(*) AS total FROM v_alertas_stock`),
      query(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS vendas FROM vendas WHERE estado='concluida' AND DATE_TRUNC('month', criado_em) = DATE_TRUNC('month', NOW())`)
    ]);
    res.json({
      total_produtos: parseInt(produtos.rows[0].total),
      total_stock:    parseInt(stock.rows[0].total),
      total_alertas:  parseInt(alertas.rows[0].total),
      receita_mes:    parseFloat(receita.rows[0].total),
      vendas_mes:     parseInt(receita.rows[0].vendas)
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
//  ROTAS — CATEGORIAS
// ============================================================
app.get('/api/categorias', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM categorias ORDER BY nome`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
//  ROTA — SAÚDE DO SERVIDOR
// ============================================================
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), versao: '2.1.0' });
  } catch (err) {
    res.status(500).json({ status: 'erro', detalhe: err.message });
  }
});

// Fallback — servir o frontend para qualquer rota não encontrada
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// ── Iniciar servidor ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ StockOS API a correr na porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
});
