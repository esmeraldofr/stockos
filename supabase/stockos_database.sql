-- ============================================================
--  StockOS v3 — Gestão de Turnos e Stock
--  Sistema baseado em turnos (Manhã / Tarde / Noite)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
--  UTILIZADORES
-- ============================================================
CREATE TABLE IF NOT EXISTS utilizadores (
  id          SERIAL        PRIMARY KEY,
  nome        VARCHAR(150)  NOT NULL,
  email       VARCHAR(200)  NOT NULL UNIQUE,
  senha_hash  TEXT          NOT NULL DEFAULT '',
  role        VARCHAR(20)   NOT NULL DEFAULT 'operador', -- admin, gestor, operador
  ativo       BOOLEAN       NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
--  PRODUTOS
-- ============================================================
CREATE TABLE IF NOT EXISTS produtos (
  id        SERIAL        PRIMARY KEY,
  nome      VARCHAR(200)  NOT NULL,
  preco     NUMERIC(15,2) NOT NULL DEFAULT 0,
  categoria VARCHAR(20)   NOT NULL DEFAULT 'outro', -- ingredientes, bebida, outro
  ordem     INTEGER       NOT NULL DEFAULT 0,
  ativo     BOOLEAN       NOT NULL DEFAULT TRUE,
  tipo_medicao VARCHAR(10) NOT NULL DEFAULT 'unidade' CHECK (tipo_medicao IN ('unidade','peso'))
);

-- ============================================================
--  PRODUTO_PRECO_HISTORICO — vigência por (data, turno). Relatórios: última linha ≤ (data turno, nome turno).
-- ============================================================
CREATE TABLE IF NOT EXISTS produto_preco_historico (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  valid_from DATE NOT NULL,
  valid_from_turno VARCHAR(10) NOT NULL DEFAULT 'manha' CHECK (valid_from_turno IN ('manha','tarde','noite')),
  preco NUMERIC(15,2) NOT NULL DEFAULT 0,
  preco_copos_pacote NUMERIC(15,2) NOT NULL DEFAULT 0,
  qtd_copos_pacote INTEGER NOT NULL DEFAULT 0
);
-- BD já criada sem valid_from_turno: CREATE TABLE IF NOT EXISTS não altera tabelas antigas.
ALTER TABLE produto_preco_historico ADD COLUMN IF NOT EXISTS valid_from_turno VARCHAR(10) NOT NULL DEFAULT 'manha';
ALTER TABLE produto_preco_historico DROP CONSTRAINT IF EXISTS produto_preco_historico_produto_id_valid_from_key;
CREATE UNIQUE INDEX IF NOT EXISTS produto_preco_historico_prod_vig_uidx ON produto_preco_historico (produto_id, valid_from, valid_from_turno);
CREATE INDEX IF NOT EXISTS idx_produto_preco_hist_lookup ON produto_preco_historico (produto_id, valid_from DESC);

-- ============================================================
--  TURNOS (um por turno por dia)
-- ============================================================
CREATE TABLE IF NOT EXISTS turnos (
  id             SERIAL      PRIMARY KEY,
  data           DATE        NOT NULL DEFAULT CURRENT_DATE,
  nome           VARCHAR(10) NOT NULL CHECK (nome IN ('manha','tarde','noite')),
  utilizador_id  INTEGER     REFERENCES utilizadores(id) ON DELETE SET NULL,
  estado         VARCHAR(10) NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto','fechado')),
  notas          TEXT        NOT NULL DEFAULT '',
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fechado_em     TIMESTAMPTZ,
  UNIQUE(data, nome)
);

-- ============================================================
--  TURNO_STOCK (stock por produto por turno)
-- ============================================================
CREATE TABLE IF NOT EXISTS turno_stock (
  id          SERIAL          PRIMARY KEY,
  turno_id    INTEGER         NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  produto_id  INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  encontrado  NUMERIC(10,3),
  entrada     NUMERIC(10,3)   NOT NULL DEFAULT 0,
  deixado     NUMERIC(10,3),
  UNIQUE(turno_id, produto_id)
);
ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS fechados NUMERIC(10,3) NOT NULL DEFAULT 0;
ALTER TABLE turno_stock ALTER COLUMN encontrado DROP DEFAULT;
ALTER TABLE turno_stock ALTER COLUMN encontrado DROP NOT NULL;
ALTER TABLE turno_stock ALTER COLUMN deixado DROP DEFAULT;
ALTER TABLE turno_stock ALTER COLUMN deixado DROP NOT NULL;
-- Valor de vendas (stock×preço) congelado ao fechar o turno; NULL = usar preço actual do produto (turno aberto ou legado).
ALTER TABLE turno_stock ADD COLUMN IF NOT EXISTS valor_vendas_reportado_kz NUMERIC(15,2);

-- ============================================================
--  TURNO_CAIXA (caixa por turno)
-- ============================================================
CREATE TABLE IF NOT EXISTS turno_caixa (
  id            SERIAL          PRIMARY KEY,
  turno_id      INTEGER         NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
  tpa           NUMERIC(15,2),
  transferencia NUMERIC(15,2),
  dinheiro      NUMERIC(15,2),
  saida         NUMERIC(15,2)   NOT NULL DEFAULT 0
);
ALTER TABLE turno_caixa ALTER COLUMN tpa DROP DEFAULT;
ALTER TABLE turno_caixa ALTER COLUMN tpa DROP NOT NULL;
ALTER TABLE turno_caixa ALTER COLUMN transferencia DROP DEFAULT;
ALTER TABLE turno_caixa ALTER COLUMN transferencia DROP NOT NULL;
ALTER TABLE turno_caixa ALTER COLUMN dinheiro DROP DEFAULT;
ALTER TABLE turno_caixa ALTER COLUMN dinheiro DROP NOT NULL;

-- ============================================================
--  ARMAZÉM (inventário e compras)
-- ============================================================
CREATE TABLE IF NOT EXISTS armazem_faturas (
  id SERIAL PRIMARY KEY,
  numero_fatura TEXT NOT NULL DEFAULT '',
  fornecedor TEXT NOT NULL DEFAULT '',
  data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
  notas TEXT NOT NULL DEFAULT '',
  total_valor NUMERIC(15,2) NOT NULL DEFAULT 0,
  criado_por TEXT NOT NULL DEFAULT '',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS armazem_stock (
  id            SERIAL          PRIMARY KEY,
  produto_id    INTEGER         NOT NULL UNIQUE REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade    NUMERIC(12,3)   NOT NULL DEFAULT 0,
  custo_medio   NUMERIC(15,2)   NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS armazem_compras (
  id            SERIAL          PRIMARY KEY,
  produto_id    INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  fatura_id     INTEGER         REFERENCES armazem_faturas(id) ON DELETE SET NULL,
  quantidade    NUMERIC(12,3)   NOT NULL DEFAULT 0,
  caixas        NUMERIC(12,3)   NOT NULL DEFAULT 0,
  qtd_por_caixa NUMERIC(12,3)   NOT NULL DEFAULT 0,
  preco_unitario NUMERIC(15,2)  NOT NULL DEFAULT 0,
  valor_total   NUMERIC(15,2)   NOT NULL DEFAULT 0,
  fornecedor    TEXT            NOT NULL DEFAULT '',
  notas         TEXT            NOT NULL DEFAULT '',
  criado_por    TEXT            NOT NULL DEFAULT '',
  criado_em     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS armazem_inventario_diario (
  id            SERIAL          PRIMARY KEY,
  data          DATE            NOT NULL,
  produto_id    INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  encontrado    NUMERIC(12,3)   NOT NULL DEFAULT 0,
  deixado       NUMERIC(12,3)   NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE(data, produto_id)
);

-- ============================================================
--  MIGRATIONS — add missing columns to existing tables
-- ============================================================
-- Supabase: coluna role pode ser ENUM role_utilizador (acrescentar valor «compras»).
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
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'operador';
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS senha_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS username VARCHAR(50);
UPDATE utilizadores SET username = 'u' || id::text WHERE username IS NULL OR TRIM(COALESCE(username,'')) = '';
UPDATE utilizadores SET username = 'admin' WHERE email = 'admin@stockos.ao';
CREATE UNIQUE INDEX IF NOT EXISTS idx_utilizadores_username_lower ON utilizadores (LOWER(username));
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco NUMERIC(15,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'produtos_nome_key') THEN
    ALTER TABLE produtos ADD CONSTRAINT produtos_nome_key UNIQUE (nome);
  END IF;
END $$;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS sku VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE produtos ALTER COLUMN sku SET DEFAULT '';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria VARCHAR(20) NOT NULL DEFAULT 'outro';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ordem INTEGER NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tipo_medicao VARCHAR(10) NOT NULL DEFAULT 'unidade';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS em_stock_turno BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS venda_por_copo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS kg_por_copo NUMERIC(10,4) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_copos_pacote NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS qtd_copos_pacote INTEGER NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_tara_kg NUMERIC(10,3) NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS armazem_stock (
  id            SERIAL          PRIMARY KEY,
  produto_id    INTEGER         NOT NULL UNIQUE REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade    NUMERIC(12,3)   NOT NULL DEFAULT 0,
  custo_medio   NUMERIC(15,2)   NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS armazem_compras (
  id            SERIAL          PRIMARY KEY,
  produto_id    INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  quantidade    NUMERIC(12,3)   NOT NULL DEFAULT 0,
  caixas        NUMERIC(12,3)   NOT NULL DEFAULT 0,
  qtd_por_caixa NUMERIC(12,3)   NOT NULL DEFAULT 0,
  preco_unitario NUMERIC(15,2)  NOT NULL DEFAULT 0,
  valor_total   NUMERIC(15,2)   NOT NULL DEFAULT 0,
  fornecedor    TEXT            NOT NULL DEFAULT '',
  notas         TEXT            NOT NULL DEFAULT '',
  criado_por    TEXT            NOT NULL DEFAULT '',
  criado_em     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS caixas NUMERIC(12,3) NOT NULL DEFAULT 0;
ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS qtd_por_caixa NUMERIC(12,3) NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS armazem_faturas (
  id SERIAL PRIMARY KEY,
  numero_fatura TEXT NOT NULL DEFAULT '',
  fornecedor TEXT NOT NULL DEFAULT '',
  data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
  notas TEXT NOT NULL DEFAULT '',
  total_valor NUMERIC(15,2) NOT NULL DEFAULT 0,
  criado_por TEXT NOT NULL DEFAULT '',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS fornecedores (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  notas TEXT NOT NULL DEFAULT '',
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por TEXT NOT NULL DEFAULT ''
);
ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL;
ALTER TABLE armazem_compras ADD COLUMN IF NOT EXISTS fatura_id INTEGER REFERENCES armazem_faturas(id) ON DELETE SET NULL;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT '';
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS fechado_em TIMESTAMPTZ;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'aberto';
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS utilizador_id INTEGER;
-- ============================================================
--  ESCALA (escala semanal de turnos)
-- ============================================================
CREATE TABLE IF NOT EXISTS escala (
  id            SERIAL      PRIMARY KEY,
  data          DATE        NOT NULL,
  turno         VARCHAR(10) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
  utilizador_id TEXT,
  notas         TEXT        NOT NULL DEFAULT '',
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(data, turno, utilizador_id)
);
ALTER TABLE escala ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text;
ALTER TABLE escala DROP CONSTRAINT IF EXISTS escala_data_turno_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'escala_data_turno_utilizador_key') THEN
    ALTER TABLE escala ADD CONSTRAINT escala_data_turno_utilizador_key UNIQUE (data, turno, utilizador_id);
  END IF;
END $$;

-- ============================================================
--  ESCALA TEMPLATE (escala semanal reutilizável)
-- ============================================================
CREATE TABLE IF NOT EXISTS escala_template (
  id            SERIAL      PRIMARY KEY,
  dia_semana    INTEGER     NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  turno         VARCHAR(10) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
  utilizador_id TEXT,
  notas         TEXT        NOT NULL DEFAULT '',
  UNIQUE(dia_semana, turno, utilizador_id)
);
ALTER TABLE escala_template ALTER COLUMN utilizador_id DROP NOT NULL;
ALTER TABLE escala_template ALTER COLUMN utilizador_id TYPE TEXT USING utilizador_id::text;
ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT '';
ALTER TABLE escala_template DROP CONSTRAINT IF EXISTS escala_template_dia_semana_turno_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'escala_template_dia_turno_utilizador_key') THEN
    ALTER TABLE escala_template ADD CONSTRAINT escala_template_dia_turno_utilizador_key UNIQUE (dia_semana, turno, utilizador_id);
  END IF;
END $$;

ALTER TABLE escala ADD COLUMN IF NOT EXISTS area_trabalho SMALLINT;
ALTER TABLE escala_template ADD COLUMN IF NOT EXISTS area_trabalho SMALLINT;

-- ============================================================
--  DADOS INICIAIS — UTILIZADORES
--  Senhas: definidas pelo admin ou password inicial na criação do utilizador
-- ============================================================
INSERT INTO utilizadores (nome, email, senha_hash, role, username) VALUES
  ('Admin', 'admin@stockos.ao', '', 'admin', 'admin')
  ON CONFLICT (email) DO NOTHING;
UPDATE utilizadores SET username = 'u' || id::text WHERE username IS NULL OR TRIM(COALESCE(username,'')) = '';
UPDATE utilizadores SET username = 'admin' WHERE email = 'admin@stockos.ao';

-- ============================================================
--  DADOS INICIAIS — PRODUTOS (INGREDIENTES)
-- ============================================================
INSERT INTO produtos (nome, preco, categoria, ordem) VALUES
  ('Carne',           0, 'ingredientes',  1),
  ('Ovo',             0, 'ingredientes',  2),
  ('Enchido',         0, 'ingredientes',  3),
  ('Pão 12',          0, 'ingredientes',  4),
  ('Pão 6',           0, 'ingredientes',  5),
  ('Batata Palha',    0, 'ingredientes',  6),
  ('Malonese',        0, 'ingredientes',  7),
  ('Mostarda',        0, 'ingredientes',  8),
  ('Ketchup',         0, 'ingredientes',  9),
  ('Milho',           0, 'ingredientes', 10),
  ('Óleo',            0, 'ingredientes', 11),
  ('Molho Inglês',    0, 'ingredientes', 12),
  ('Nata',            0, 'ingredientes', 13),
  ('Papel Alumínio',  0, 'ingredientes', 14),
  ('Saco',            0, 'ingredientes', 15),
  ('Palito',          0, 'ingredientes', 16),
  ('Guardanapos',     0, 'ingredientes', 17),
  ('Batata Pré-frita',0, 'ingredientes', 18)
  ON CONFLICT (nome) DO NOTHING;

-- ============================================================
--  DADOS INICIAIS — PRODUTOS (BEBIDAS)
-- ============================================================
INSERT INTO produtos (nome, preco, categoria, ordem) VALUES
  ('Água Pequena',      200,  'bebida', 19),
  ('Smirnoff',         1000,  'bebida', 20),
  ('Gin Gordons Lata', 1000,  'bebida', 21),
  ('Coca Cola Lata',    700,  'bebida', 22),
  ('Speed Lata',       1000,  'bebida', 23),
  ('Blue Laranja Lata', 700,  'bebida', 24),
  ('Sprite Lata',       700,  'bebida', 25),
  ('Blue Limão Lata',   700,  'bebida', 26),
  ('Eka',               700,  'bebida', 27),
  ('Booster',           700,  'bebida', 28),
  ('Booster Morango',   700,  'bebida', 29),
  ('Booster Manga',     700,  'bebida', 30),
  ('Compal Lata',       700,  'bebida', 31),
  ('Sumol Ananas',      700,  'bebida', 32),
  ('Sumol Laranja',     700,  'bebida', 33),
  ('Sumol Manga',       700,  'bebida', 34),
  ('Cuca Lata',         700,  'bebida', 35),
  ('Nocal Lata',        700,  'bebida', 36),
  ('Dopel',             700,  'bebida', 37)
  ON CONFLICT (nome) DO NOTHING;

-- ============================================================
--  TURNO_ENTRADAS (registos de entrada de stock por turno)
-- ============================================================
CREATE TABLE IF NOT EXISTS turno_entradas (
  id          SERIAL          PRIMARY KEY,
  turno_id    INTEGER         NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  produto_id  INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  tipo        VARCHAR(10)     NOT NULL DEFAULT 'entrada' CHECK (tipo IN ('entrada','tirar')),
  origem      VARCHAR(10)     NOT NULL DEFAULT 'armazem' CHECK (origem IN ('armazem','compra')),
  preco       NUMERIC(15,2)   NOT NULL DEFAULT 0,
  quantidade  NUMERIC(10,3)   NOT NULL DEFAULT 0,
  notas       TEXT            NOT NULL DEFAULT '',
  criado_em   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  TURNO_SAIDAS (saídas de caixa por turno)
-- ============================================================
CREATE TABLE IF NOT EXISTS turno_saidas (
  id          SERIAL          PRIMARY KEY,
  turno_id    INTEGER         NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  descricao   TEXT            NOT NULL DEFAULT '',
  valor       NUMERIC(15,2)   NOT NULL DEFAULT 0,
  notas       TEXT            NOT NULL DEFAULT '',
  criado_em   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS armazem_libertacoes (
  id            SERIAL          PRIMARY KEY,
  data          DATE            NOT NULL,
  valor         NUMERIC(15,2)   NOT NULL,
  notas         TEXT            NOT NULL DEFAULT '',
  criado_em     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  criado_por    TEXT            NOT NULL DEFAULT ''
);
ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS justificacao_excesso TEXT NOT NULL DEFAULT '';
ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS turno_saida_id INTEGER REFERENCES turno_saidas(id) ON DELETE SET NULL;
ALTER TABLE armazem_faturas ADD COLUMN IF NOT EXISTS foto_fatura_url TEXT NOT NULL DEFAULT '';

-- ============================================================
--  ESCALA_TEMPLATE (modelo semanal: dia da semana + turno)
--  dia_semana: 0=Segunda … 6=Domingo
-- ============================================================
CREATE TABLE IF NOT EXISTS escala_template (
  id              SERIAL        PRIMARY KEY,
  dia_semana      SMALLINT      NOT NULL CHECK (dia_semana >= 0 AND dia_semana <= 6),
  turno           VARCHAR(10)   NOT NULL CHECK (turno IN ('manha','tarde','noite')),
  utilizador_id   TEXT,
  notas           TEXT          NOT NULL DEFAULT '',
  criado_em       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(dia_semana, turno, utilizador_id)
);

-- ============================================================
--  ESCALAS (atribuições por data concreta: dia + turno)
-- ============================================================
CREATE TABLE IF NOT EXISTS escalas (
  id              SERIAL        PRIMARY KEY,
  data            DATE          NOT NULL,
  turno           VARCHAR(10)   NOT NULL CHECK (turno IN ('manha','tarde','noite')),
  utilizador_id   TEXT,
  notas           TEXT          NOT NULL DEFAULT '',
  criado_em       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(data, turno, utilizador_id)
);

-- ============================================================
--  DEPÓSITOS BANCO: valor = bruto por turno; valor_saidas = saída no depósito
--  (total do dia) num registo; saidas_destino = produto/destino dessa saída (no mesmo registo)
-- ============================================================
CREATE TABLE IF NOT EXISTS depositos_banco (
  id                SERIAL          PRIMARY KEY,
  turno_id          INTEGER         NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
  data_deposito     DATE            NOT NULL DEFAULT CURRENT_DATE,
  valor             NUMERIC(15,2)   NOT NULL,
  valor_saidas      NUMERIC(15,2)   NOT NULL DEFAULT 0,
  saidas_destino    TEXT            NOT NULL DEFAULT '',
  bordero_foto_url  TEXT            NOT NULL DEFAULT '',
  valor_tpa         NUMERIC(15,2)   NOT NULL DEFAULT 0,
  referencia        TEXT            NOT NULL DEFAULT '',
  notas             TEXT            NOT NULL DEFAULT '',
  criado_por        TEXT            NOT NULL DEFAULT '',
  criado_em         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  RECEITAS (composição de produtos de menu)
-- ============================================================
CREATE TABLE IF NOT EXISTS receitas (
  id            SERIAL          PRIMARY KEY,
  produto_id    INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  componente_id INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade    NUMERIC(10,3)   NOT NULL DEFAULT 1,
  UNIQUE(produto_id, componente_id)
);

-- ============================================================
--  TURNO_VENDAS (vendas de menu por turno)
-- ============================================================
CREATE TABLE IF NOT EXISTS turno_vendas (
  id          SERIAL          PRIMARY KEY,
  turno_id    INTEGER         NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  produto_id  INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade  NUMERIC(10,3)   NOT NULL DEFAULT 0,
  UNIQUE(turno_id, produto_id)
);
ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS preco_unit_snapshot NUMERIC(15,2);
ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS preco_copos_pacote_snapshot NUMERIC(15,2);
ALTER TABLE turno_vendas ADD COLUMN IF NOT EXISTS qtd_copos_pacote_snapshot INTEGER;

-- ============================================================
--  TURNO_PEDIDOS — pedidos ao balcão (uma fatura por pedido)
--  produto_id: o mesmo tipo que produtos.id (INTEGER por omissão; se id for UUID,
--  criar via API ensureTurnoPedidos ou ALTER COLUMN para UUID + FK).
-- ============================================================
CREATE TABLE IF NOT EXISTS turno_pedidos (
  id            SERIAL          PRIMARY KEY,
  turno_id      INTEGER         NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  cliente_nome  TEXT            NOT NULL DEFAULT '',
  tipo_pagamento VARCHAR(24)    NOT NULL DEFAULT 'dinheiro',
  criado_em     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
ALTER TABLE turno_pedidos ADD COLUMN IF NOT EXISTS tipo_pagamento VARCHAR(24) NOT NULL DEFAULT 'dinheiro';
CREATE TABLE IF NOT EXISTS turno_pedido_linhas (
  id            SERIAL          PRIMARY KEY,
  pedido_id     INTEGER         NOT NULL REFERENCES turno_pedidos(id) ON DELETE CASCADE,
  produto_id    INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  quantidade    NUMERIC(10,3)   NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turno_pedidos_turno ON turno_pedidos(turno_id);
CREATE INDEX IF NOT EXISTS idx_turno_pedido_linhas_pedido ON turno_pedido_linhas(pedido_id);
