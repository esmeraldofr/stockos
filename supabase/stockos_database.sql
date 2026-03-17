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
  categoria VARCHAR(20)   NOT NULL DEFAULT 'outro', -- comida, bebida, outro
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
  turno_id    UUID            NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  produto_id  UUID            NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
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
  turno_id      UUID            NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
  tpa           NUMERIC(15,2)   NOT NULL DEFAULT 0,
  transferencia NUMERIC(15,2)   NOT NULL DEFAULT 0,
  dinheiro      NUMERIC(15,2)   NOT NULL DEFAULT 0,
  saida         NUMERIC(15,2)   NOT NULL DEFAULT 0
);

-- ============================================================
--  DADOS INICIAIS — UTILIZADORES
--  Password: usar /api/auth/setup com código STOCKOS2025
-- ============================================================
INSERT INTO utilizadores (nome, email, senha_hash, role) VALUES
  ('Admin', 'admin@stockos.ao', '', 'admin')
  ON CONFLICT (email) DO NOTHING;

-- ============================================================
--  DADOS INICIAIS — PRODUTOS (COMIDA)
-- ============================================================
INSERT INTO produtos (nome, preco, categoria, ordem) VALUES
  ('Carne',           0, 'comida',  1),
  ('Ovo',             0, 'comida',  2),
  ('Enchido',         0, 'comida',  3),
  ('Pão 12',          0, 'comida',  4),
  ('Pão 6',           0, 'comida',  5),
  ('Batata Palha',    0, 'comida',  6),
  ('Malonese',        0, 'comida',  7),
  ('Mostarda',        0, 'comida',  8),
  ('Ketchup',         0, 'comida',  9),
  ('Milho',           0, 'comida', 10),
  ('Óleo',            0, 'comida', 11),
  ('Molho Inglês',    0, 'comida', 12),
  ('Nata',            0, 'comida', 13),
  ('Papel Alumínio',  0, 'comida', 14),
  ('Saco',            0, 'comida', 15),
  ('Palito',          0, 'comida', 16),
  ('Guardanapos',     0, 'comida', 17),
  ('Batata Pré-frita',0, 'comida', 18)
  ON CONFLICT DO NOTHING;

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
  ON CONFLICT DO NOTHING;
