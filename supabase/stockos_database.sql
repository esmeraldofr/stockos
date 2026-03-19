-- ============================================================
--  StockOS v3 — Gestão de Turnos e Stock
--  Sistema baseado em turnos (Manhã / Tarde / Noite)
-- ============================================================

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
  ativo     BOOLEAN       NOT NULL DEFAULT TRUE
);

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
  encontrado  NUMERIC(10,3)   NOT NULL DEFAULT 0,
  entrada     NUMERIC(10,3)   NOT NULL DEFAULT 0,
  deixado     NUMERIC(10,3)   NOT NULL DEFAULT 0,
  UNIQUE(turno_id, produto_id)
);

-- ============================================================
--  TURNO_CAIXA (caixa por turno)
-- ============================================================
CREATE TABLE IF NOT EXISTS turno_caixa (
  id            SERIAL          PRIMARY KEY,
  turno_id      INTEGER         NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
  tpa           NUMERIC(15,2)   NOT NULL DEFAULT 0,
  transferencia NUMERIC(15,2)   NOT NULL DEFAULT 0,
  dinheiro      NUMERIC(15,2)   NOT NULL DEFAULT 0,
  saida         NUMERIC(15,2)   NOT NULL DEFAULT 0
);

-- ============================================================
--  MIGRATIONS — add missing columns to existing tables
-- ============================================================
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'operador';
ALTER TABLE utilizadores ADD COLUMN IF NOT EXISTS senha_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco NUMERIC(15,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'produtos_nome_key') THEN
    ALTER TABLE produtos ADD CONSTRAINT produtos_nome_key UNIQUE (nome);
  END IF;
END $$;
ALTER TABLE produtos ALTER COLUMN sku SET DEFAULT '';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria VARCHAR(20) NOT NULL DEFAULT 'outro';
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ordem INTEGER NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS notas TEXT NOT NULL DEFAULT '';
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS fechado_em TIMESTAMPTZ;
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS estado VARCHAR(10) NOT NULL DEFAULT 'aberto';
ALTER TABLE turnos ADD COLUMN IF NOT EXISTS utilizador_id INTEGER;
CREATE TABLE IF NOT EXISTS turno_entradas (
  id          SERIAL          PRIMARY KEY,
  turno_id    INTEGER         NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  produto_id  INTEGER         NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade  NUMERIC(10,3)   NOT NULL DEFAULT 0,
  notas       TEXT            NOT NULL DEFAULT '',
  criado_em   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
--  DADOS INICIAIS — UTILIZADORES
--  Password: usar /api/auth/setup com código STOCKOS2025
-- ============================================================
INSERT INTO utilizadores (nome, email, senha_hash, role) VALUES
  ('Admin', 'admin@stockos.ao', '', 'admin')
  ON CONFLICT (email) DO NOTHING;

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
  quantidade  NUMERIC(10,3)   NOT NULL DEFAULT 0,
  notas       TEXT            NOT NULL DEFAULT '',
  criado_em   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
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
  produto_id  UUID            NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade  NUMERIC(10,3)   NOT NULL DEFAULT 0,
  UNIQUE(turno_id, produto_id)
);
