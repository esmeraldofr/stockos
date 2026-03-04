-- ============================================================
--  StockOS — Base de Dados PostgreSQL
--  Versão: 2.1 · Luanda
--  Gerado automaticamente para uso em produção
-- ============================================================

-- Extensões úteis
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  LIMPEZA (ordem inversa de dependências)
-- ============================================================
DROP TABLE IF EXISTS auditoria_alteracoes CASCADE;
DROP TABLE IF EXISTS auditoria_log CASCADE;
DROP TABLE IF EXISTS venda_itens CASCADE;
DROP TABLE IF EXISTS vendas CASCADE;
DROP TABLE IF EXISTS comanda_itens CASCADE;
DROP TABLE IF EXISTS comandas CASCADE;
DROP TABLE IF EXISTS fechos_caixa CASCADE;
DROP TABLE IF EXISTS desperdicios CASCADE;
DROP TABLE IF EXISTS escalas CASCADE;
DROP TABLE IF EXISTS movimentacoes CASCADE;
DROP TABLE IF EXISTS mesas CASCADE;
DROP TABLE IF EXISTS turnos CASCADE;
DROP TABLE IF EXISTS produtos CASCADE;
DROP TABLE IF EXISTS clientes CASCADE;
DROP TABLE IF EXISTS armazens CASCADE;
DROP TABLE IF EXISTS utilizadores CASCADE;
DROP TABLE IF EXISTS categorias CASCADE;

-- ============================================================
--  ENUM TYPES
-- ============================================================
DROP TYPE IF EXISTS tipo_movimentacao CASCADE;
DROP TYPE IF EXISTS estado_venda CASCADE;
DROP TYPE IF EXISTS metodo_pagamento CASCADE;
DROP TYPE IF EXISTS tipo_auditoria CASCADE;
DROP TYPE IF EXISTS unidade_medida CASCADE;
DROP TYPE IF EXISTS role_utilizador CASCADE;

CREATE TYPE tipo_movimentacao  AS ENUM ('entrada', 'saida', 'transferencia', 'ajuste');
CREATE TYPE estado_venda       AS ENUM ('concluida', 'cancelada', 'pendente');
CREATE TYPE metodo_pagamento   AS ENUM ('dinheiro', 'transferencia', 'cartao', 'credito');
CREATE TYPE tipo_auditoria     AS ENUM ('contagem', 'ajuste', 'importacao', 'venda', 'cancelamento');
CREATE TYPE unidade_medida     AS ENUM ('un', 'kg', 'l', 'm', 'cx', 'par');
CREATE TYPE role_utilizador    AS ENUM ('admin', 'gestor', 'operador', 'viewer');

-- ============================================================
--  TABELA: utilizadores
-- ============================================================
CREATE TABLE utilizadores (
    id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome          VARCHAR(150)  NOT NULL,
    email         VARCHAR(200)  NOT NULL UNIQUE,
    senha_hash    TEXT          NOT NULL,
    role          role_utilizador NOT NULL DEFAULT 'operador',
    ativo         BOOLEAN       NOT NULL DEFAULT TRUE,
    criado_em     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE utilizadores IS 'Utilizadores do sistema StockOS';

-- ============================================================
--  TABELA: armazens
-- ============================================================
CREATE TABLE armazens (
    id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome          VARCHAR(150)  NOT NULL UNIQUE,
    endereco      TEXT,
    responsavel   VARCHAR(150),
    ativo         BOOLEAN       NOT NULL DEFAULT TRUE,
    criado_em     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE armazens IS 'Armazéns e localizações físicas do stock';

-- ============================================================
--  TABELA: categorias
-- ============================================================
CREATE TABLE categorias (
    id            SERIAL        PRIMARY KEY,
    nome          VARCHAR(100)  NOT NULL UNIQUE,
    descricao     TEXT,
    criado_em     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE categorias IS 'Categorias de produtos';

-- ============================================================
--  TABELA: turnos
-- ============================================================
CREATE TABLE turnos (
    id                  SERIAL          PRIMARY KEY,
    nome                VARCHAR(20)     NOT NULL CHECK (nome IN ('manha','tarde','noite')),
    data                DATE            NOT NULL DEFAULT CURRENT_DATE,
    utilizador_id       UUID            REFERENCES utilizadores(id) ON DELETE SET NULL,
    estado              VARCHAR(10)     NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto','fechado')),
    fundo_inicial       NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_vendas        NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_dinheiro      NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_transferencia NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_cartao        NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_desperdicio   NUMERIC(15,2)   NOT NULL DEFAULT 0,
    notas               TEXT            NOT NULL DEFAULT '',
    aberto_em           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    fechado_em          TIMESTAMPTZ,
    UNIQUE (nome, data)
);

COMMENT ON TABLE turnos IS 'Turnos de trabalho (manhã, tarde, noite)';

-- ============================================================
--  TABELA: mesas
-- ============================================================
CREATE TABLE mesas (
    id          SERIAL          PRIMARY KEY,
    numero      INTEGER         NOT NULL UNIQUE,
    capacidade  INTEGER         NOT NULL DEFAULT 4,
    estado      VARCHAR(20)     NOT NULL DEFAULT 'livre' CHECK (estado IN ('livre','ocupada','reservada')),
    criado_em   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE mesas IS 'Mesas do restaurante/estabelecimento';

-- ============================================================
--  TABELA: escalas
-- ============================================================
CREATE TABLE escalas (
    id              SERIAL      PRIMARY KEY,
    utilizador_id   UUID        NOT NULL REFERENCES utilizadores(id) ON DELETE CASCADE,
    data            DATE        NOT NULL,
    turno           VARCHAR(20) NOT NULL CHECK (turno IN ('manha','tarde','noite')),
    criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (utilizador_id, data, turno)
);

COMMENT ON TABLE escalas IS 'Escalas de trabalho dos utilizadores';

-- ============================================================
--  TABELA: clientes
-- ============================================================
CREATE TABLE clientes (
    id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome          VARCHAR(200)  NOT NULL,
    telefone      VARCHAR(30),
    email         VARCHAR(200),
    nif           VARCHAR(50),
    endereco      TEXT,
    ativo         BOOLEAN       NOT NULL DEFAULT TRUE,
    criado_em     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE clientes IS 'Clientes registados no sistema';

-- ============================================================
--  TABELA: produtos
-- ============================================================
CREATE TABLE produtos (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome            VARCHAR(200)    NOT NULL,
    sku             VARCHAR(100)    NOT NULL UNIQUE,
    categoria_id    INTEGER         REFERENCES categorias(id) ON DELETE SET NULL,
    unidade         unidade_medida  NOT NULL DEFAULT 'un',
    preco_custo     NUMERIC(15,2)   NOT NULL DEFAULT 0 CHECK (preco_custo >= 0),
    preco_venda     NUMERIC(15,2)   NOT NULL DEFAULT 0 CHECK (preco_venda >= 0),
    stock_minimo    INTEGER         NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
    stock_atual     INTEGER         NOT NULL DEFAULT 0 CHECK (stock_atual >= 0),
    armazem_id      UUID            REFERENCES armazens(id) ON DELETE SET NULL,
    descricao       TEXT,
    ativo           BOOLEAN         NOT NULL DEFAULT TRUE,
    criado_em       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    atualizado_em   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE produtos       IS 'Catálogo completo de produtos';
COMMENT ON COLUMN produtos.preco_custo IS 'Preço em centavos/kwanzas × 100 para evitar float';
COMMENT ON COLUMN produtos.preco_venda IS 'Preço de venda ao público';

-- Índices de pesquisa rápida
CREATE INDEX idx_produtos_sku       ON produtos(sku);
CREATE INDEX idx_produtos_categoria ON produtos(categoria_id);
CREATE INDEX idx_produtos_armazem   ON produtos(armazem_id);
CREATE INDEX idx_produtos_stock     ON produtos(stock_atual);

-- ============================================================
--  TABELA: movimentacoes
-- ============================================================
CREATE TABLE movimentacoes (
    id              UUID                PRIMARY KEY DEFAULT uuid_generate_v4(),
    produto_id      UUID                NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
    tipo            tipo_movimentacao   NOT NULL,
    quantidade      INTEGER             NOT NULL CHECK (quantidade > 0),
    armazem_origem  UUID                REFERENCES armazens(id) ON DELETE SET NULL,
    armazem_destino UUID                REFERENCES armazens(id) ON DELETE SET NULL,
    motivo          TEXT,
    referencia      VARCHAR(100),       -- ex: "VND-0001", "PO-0045"
    turno_id        INTEGER             REFERENCES turnos(id) ON DELETE SET NULL,
    utilizador_id   UUID                REFERENCES utilizadores(id) ON DELETE SET NULL,
    criado_em       TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE movimentacoes IS 'Histórico completo de todas as movimentações de stock';
COMMENT ON COLUMN movimentacoes.referencia IS 'Referência externa: número de venda, PO, etc.';

CREATE INDEX idx_mov_produto    ON movimentacoes(produto_id);
CREATE INDEX idx_mov_tipo       ON movimentacoes(tipo);
CREATE INDEX idx_mov_criado     ON movimentacoes(criado_em DESC);

-- ============================================================
--  TABELA: vendas
-- ============================================================
CREATE TABLE vendas (
    id              VARCHAR(20)         PRIMARY KEY,  -- ex: VND-0001
    cliente_id      UUID                REFERENCES clientes(id) ON DELETE SET NULL,
    cliente_nome    VARCHAR(200),                     -- snapshot em caso de cliente avulso
    utilizador_id   UUID                REFERENCES utilizadores(id) ON DELETE SET NULL,
    metodo_pagamento metodo_pagamento   NOT NULL DEFAULT 'dinheiro',
    desconto_pct    NUMERIC(5,2)        NOT NULL DEFAULT 0 CHECK (desconto_pct BETWEEN 0 AND 100),
    subtotal        NUMERIC(15,2)       NOT NULL DEFAULT 0,
    total           NUMERIC(15,2)       NOT NULL DEFAULT 0,
    estado          estado_venda        NOT NULL DEFAULT 'concluida',
    turno_id        INTEGER             REFERENCES turnos(id) ON DELETE SET NULL,
    mesa_id         INTEGER             REFERENCES mesas(id) ON DELETE SET NULL,
    comanda_id      INTEGER,
    notas           TEXT,
    criado_em       TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    atualizado_em   TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE vendas IS 'Cabeçalho de cada transacção de venda';

CREATE INDEX idx_vendas_cliente  ON vendas(cliente_id);
CREATE INDEX idx_vendas_estado   ON vendas(estado);
CREATE INDEX idx_vendas_criado   ON vendas(criado_em DESC);

-- ============================================================
--  TABELA: venda_itens
-- ============================================================
CREATE TABLE venda_itens (
    id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    venda_id        VARCHAR(20)     NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
    produto_id      UUID            REFERENCES produtos(id) ON DELETE SET NULL,
    produto_nome    VARCHAR(200)    NOT NULL,  -- snapshot do nome
    produto_sku     VARCHAR(100),              -- snapshot do SKU
    quantidade      INTEGER         NOT NULL CHECK (quantidade > 0),
    preco_unitario  NUMERIC(15,2)   NOT NULL CHECK (preco_unitario >= 0),
    total_linha     NUMERIC(15,2)   GENERATED ALWAYS AS (quantidade * preco_unitario) STORED
);

COMMENT ON TABLE venda_itens IS 'Linhas/itens de cada venda';

CREATE INDEX idx_vitens_venda   ON venda_itens(venda_id);
CREATE INDEX idx_vitens_produto ON venda_itens(produto_id);

-- ============================================================
--  TABELA: comandas
-- ============================================================
CREATE TABLE comandas (
    id              SERIAL          PRIMARY KEY,
    mesa_id         INTEGER         REFERENCES mesas(id) ON DELETE SET NULL,
    turno_id        INTEGER         REFERENCES turnos(id) ON DELETE SET NULL,
    utilizador_id   UUID            REFERENCES utilizadores(id) ON DELETE SET NULL,
    num_pessoas     INTEGER         NOT NULL DEFAULT 1,
    estado          VARCHAR(10)     NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta','fechada','cancelada')),
    total           NUMERIC(15,2)   NOT NULL DEFAULT 0,
    notas           TEXT            NOT NULL DEFAULT '',
    aberta_em       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    fechada_em      TIMESTAMPTZ
);

COMMENT ON TABLE comandas IS 'Comandas abertas nas mesas';

-- ============================================================
--  TABELA: comanda_itens
-- ============================================================
CREATE TABLE comanda_itens (
    id              SERIAL          PRIMARY KEY,
    comanda_id      INTEGER         NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
    produto_id      UUID            REFERENCES produtos(id) ON DELETE SET NULL,
    quantidade      INTEGER         NOT NULL CHECK (quantidade > 0),
    preco_unitario  NUMERIC(15,2)   NOT NULL,
    subtotal        NUMERIC(15,2)   NOT NULL,
    estado          VARCHAR(10)     NOT NULL DEFAULT 'ativo' CHECK (estado IN ('ativo','cancelado')),
    notas           TEXT            NOT NULL DEFAULT ''
);

COMMENT ON TABLE comanda_itens IS 'Itens de cada comanda';

-- ============================================================
--  TABELA: desperdicios
-- ============================================================
CREATE TABLE desperdicios (
    id              SERIAL          PRIMARY KEY,
    turno_id        INTEGER         REFERENCES turnos(id) ON DELETE SET NULL,
    produto_id      UUID            REFERENCES produtos(id) ON DELETE SET NULL,
    quantidade      INTEGER         NOT NULL CHECK (quantidade > 0),
    motivo          TEXT,
    utilizador_id   UUID            REFERENCES utilizadores(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE desperdicios IS 'Registo de desperdícios por turno';

-- ============================================================
--  TABELA: fechos_caixa
-- ============================================================
CREATE TABLE fechos_caixa (
    id                  SERIAL          PRIMARY KEY,
    turno_id            INTEGER         NOT NULL UNIQUE REFERENCES turnos(id) ON DELETE CASCADE,
    utilizador_id       UUID            REFERENCES utilizadores(id) ON DELETE SET NULL,
    total_vendas        NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_dinheiro      NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_transferencia NUMERIC(15,2)   NOT NULL DEFAULT 0,
    total_cartao        NUMERIC(15,2)   NOT NULL DEFAULT 0,
    dinheiro_contado    NUMERIC(15,2)   NOT NULL DEFAULT 0,
    diferenca           NUMERIC(15,2)   NOT NULL DEFAULT 0,
    num_vendas          INTEGER         NOT NULL DEFAULT 0,
    total_desperdicio   NUMERIC(15,2)   NOT NULL DEFAULT 0,
    notas               TEXT            NOT NULL DEFAULT '',
    criado_em           TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE fechos_caixa IS 'Fecho de caixa no fim de cada turno';

-- ============================================================
--  TABELA: auditoria_log
-- ============================================================
CREATE TABLE auditoria_log (
    id          UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    tipo        tipo_auditoria  NOT NULL,
    descricao   TEXT            NOT NULL,
    utilizador_id UUID          REFERENCES utilizadores(id) ON DELETE SET NULL,
    criado_em   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE auditoria_log IS 'Registo de operações de inventário para auditoria';

CREATE INDEX idx_audit_tipo    ON auditoria_log(tipo);
CREATE INDEX idx_audit_criado  ON auditoria_log(criado_em DESC);

-- ============================================================
--  TABELA: auditoria_alteracoes
-- ============================================================
CREATE TABLE auditoria_alteracoes (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    auditoria_id    UUID        NOT NULL REFERENCES auditoria_log(id) ON DELETE CASCADE,
    produto_id      UUID        REFERENCES produtos(id) ON DELETE SET NULL,
    produto_nome    VARCHAR(200) NOT NULL,
    stock_antes     INTEGER     NOT NULL,
    stock_depois    INTEGER     NOT NULL,
    diferenca       INTEGER     GENERATED ALWAYS AS (stock_depois - stock_antes) STORED
);

COMMENT ON TABLE auditoria_alteracoes IS 'Detalhe de cada alteração de stock por operação de auditoria';

CREATE INDEX idx_audit_alt_log     ON auditoria_alteracoes(auditoria_id);
CREATE INDEX idx_audit_alt_produto ON auditoria_alteracoes(produto_id);

-- ============================================================
--  TRIGGERS: atualizado_em automático
-- ============================================================
CREATE OR REPLACE FUNCTION set_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_utilizadores_updated BEFORE UPDATE ON utilizadores FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER trg_armazens_updated     BEFORE UPDATE ON armazens     FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER trg_clientes_updated     BEFORE UPDATE ON clientes     FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER trg_produtos_updated     BEFORE UPDATE ON produtos     FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER trg_vendas_updated       BEFORE UPDATE ON vendas       FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- ============================================================
--  TRIGGER: stock automático ao registar movimentação
-- ============================================================
CREATE OR REPLACE FUNCTION atualizar_stock_por_movimentacao()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.tipo = 'entrada' THEN
        UPDATE produtos SET stock_atual = stock_atual + NEW.quantidade WHERE id = NEW.produto_id;
    ELSIF NEW.tipo = 'saida' THEN
        IF (SELECT stock_atual FROM produtos WHERE id = NEW.produto_id) < NEW.quantidade THEN
            RAISE EXCEPTION 'Stock insuficiente para o produto %', NEW.produto_id;
        END IF;
        UPDATE produtos SET stock_atual = stock_atual - NEW.quantidade WHERE id = NEW.produto_id;
    ELSIF NEW.tipo = 'ajuste' THEN
        UPDATE produtos SET stock_atual = NEW.quantidade WHERE id = NEW.produto_id;
    -- transferência é tratada com dois registos separados (saida + entrada)
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_movimentacao_stock
    AFTER INSERT ON movimentacoes
    FOR EACH ROW
    EXECUTE FUNCTION atualizar_stock_por_movimentacao();

-- ============================================================
--  TRIGGER: sequência automática de ID de venda
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS venda_seq START 1;

CREATE OR REPLACE FUNCTION gerar_id_venda()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.id IS NULL OR NEW.id = '' THEN
        NEW.id = 'VND-' || LPAD(NEXTVAL('venda_seq')::TEXT, 4, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_venda_id
    BEFORE INSERT ON vendas
    FOR EACH ROW
    EXECUTE FUNCTION gerar_id_venda();

-- ============================================================
--  VIEWS ÚTEIS
-- ============================================================

-- Produtos com estado de stock
CREATE OR REPLACE VIEW v_produtos_stock AS
SELECT
    p.id,
    p.nome,
    p.sku,
    c.nome                          AS categoria,
    p.unidade,
    p.preco_custo,
    p.preco_venda,
    p.stock_atual,
    p.stock_minimo,
    a.nome                          AS armazem,
    CASE
        WHEN p.stock_atual = 0                         THEN 'Esgotado'
        WHEN p.stock_atual <= p.stock_minimo           THEN 'Crítico'
        WHEN p.stock_atual <= p.stock_minimo * 1.5     THEN 'Baixo'
        ELSE                                                'OK'
    END                             AS estado_stock,
    (p.stock_atual * p.preco_custo) AS valor_stock
FROM produtos p
LEFT JOIN categorias c ON c.id = p.categoria_id
LEFT JOIN armazens    a ON a.id = p.armazem_id
WHERE p.ativo = TRUE;

-- Resumo de vendas por cliente
CREATE OR REPLACE VIEW v_clientes_resumo AS
SELECT
    cl.id,
    cl.nome,
    cl.telefone,
    cl.email,
    COUNT(v.id)                     AS total_vendas,
    COALESCE(SUM(v.total), 0)       AS receita_total,
    MAX(v.criado_em)                AS ultima_compra
FROM clientes cl
LEFT JOIN vendas v ON v.cliente_id = cl.id AND v.estado = 'concluida'
GROUP BY cl.id, cl.nome, cl.telefone, cl.email;

-- Alertas de stock mínimo
CREATE OR REPLACE VIEW v_alertas_stock AS
SELECT
    p.id,
    p.nome,
    p.sku,
    p.stock_atual,
    p.stock_minimo,
    a.nome AS armazem,
    CASE WHEN p.stock_atual <= p.stock_minimo THEN 'Crítico' ELSE 'Baixo' END AS nivel
FROM produtos p
LEFT JOIN armazens a ON a.id = p.armazem_id
WHERE p.ativo = TRUE
  AND p.stock_atual <= (p.stock_minimo * 1.5)
ORDER BY p.stock_atual ASC;

-- Receita do mês actual
CREATE OR REPLACE VIEW v_receita_mes AS
SELECT
    COUNT(*)                AS total_vendas,
    SUM(total)              AS receita_total,
    AVG(total)              AS ticket_medio,
    DATE_TRUNC('month', criado_em) AS mes
FROM vendas
WHERE estado = 'concluida'
GROUP BY DATE_TRUNC('month', criado_em)
ORDER BY mes DESC;

-- ============================================================
--  DADOS INICIAIS
-- ============================================================

-- Utilizadores
INSERT INTO utilizadores (id, nome, email, senha_hash, role) VALUES
    ('00000000-0000-0000-0000-000000000001', 'João Silva',   'joao.silva@stockos.ao',   crypt('admin123', gen_salt('bf')), 'admin'),
    ('00000000-0000-0000-0000-000000000002', 'Maria Costa',  'maria.costa@stockos.ao',  crypt('gestor123', gen_salt('bf')), 'gestor'),
    ('00000000-0000-0000-0000-000000000003', 'Admin Sistema','admin@stockos.ao',        crypt('stockos2025', gen_salt('bf')), 'admin');

-- Armazéns
INSERT INTO armazens (id, nome, endereco, responsavel) VALUES
    ('10000000-0000-0000-0000-000000000001', 'Luanda Central', 'Rua Amilcar Cabral, 45, Maianga, Luanda', 'João Silva'),
    ('10000000-0000-0000-0000-000000000002', 'Viana',          'Zona Industrial, Viana, Luanda',          'Maria Costa');

-- Categorias
INSERT INTO categorias (nome, descricao) VALUES
    ('Eletrónicos',   'Cabos, adaptadores e componentes eletrónicos'),
    ('Periféricos',   'Teclados, ratos, headsets e periféricos de computador'),
    ('Armazenamento', 'Discos, pen drives, cartões de memória'),
    ('Displays',      'Monitores, projetores e ecrãs'),
    ('Outros',        'Produtos diversos não categorizados');

-- Clientes
INSERT INTO clientes (id, nome, telefone, email, nif, endereco) VALUES
    ('20000000-0000-0000-0000-000000000001', 'Empresa ABC Lda',  '+244 923 456 789', 'geral@abc.co.ao',       '5000123456LA045', 'Bairro Maianga, Luanda'),
    ('20000000-0000-0000-0000-000000000002', 'Pedro Lopes',       '+244 912 345 678', 'pedro.lopes@gmail.com', '',                'Talatona, Luanda Sul'),
    ('20000000-0000-0000-0000-000000000003', 'Farmácia Saúde',    '+244 934 567 890', 'compras@fsaude.ao',     '5000987654LA045', 'Sambizanga, Luanda');

-- Produtos (stock inicial via INSERT directo — sem trigger para dados seed)
ALTER TABLE produtos DISABLE TRIGGER trg_produtos_updated;

INSERT INTO produtos (id, nome, sku, categoria_id, unidade, preco_custo, preco_venda, stock_minimo, stock_atual, armazem_id, descricao) VALUES
    ('30000000-0000-0000-0000-000000000001', 'Cabo HDMI 2.0 2m',   'ELT-CAB-001', 1, 'un', 1850.00,  2500.00,  10, 45, '10000000-0000-0000-0000-000000000001', 'Cabo HDMI de alta qualidade 4K'),
    ('30000000-0000-0000-0000-000000000002', 'Pen Drive 64GB',      'ARM-PEN-064', 3, 'un', 2400.00,  3200.00,  15,  8, '10000000-0000-0000-0000-000000000001', 'Pen drive USB 3.0 64GB'),
    ('30000000-0000-0000-0000-000000000003', 'Teclado USB ABNT2',   'PER-TEC-001', 2, 'un', 4500.00,  6000.00,   5, 22, '10000000-0000-0000-0000-000000000002', 'Teclado padrão ABNT2 com fio'),
    ('30000000-0000-0000-0000-000000000004', 'Monitor 24" FHD',     'DIS-MON-024', 4, 'un',45000.00, 58000.00,   3,  2, '10000000-0000-0000-0000-000000000001', 'Monitor Full HD 1920x1080 IPS'),
    ('30000000-0000-0000-0000-000000000005', 'Mouse Óptico USB',    'PER-MOU-001', 2, 'un', 2200.00,  3000.00,   8, 31, '10000000-0000-0000-0000-000000000002', 'Rato óptico USB 1200 DPI'),
    ('30000000-0000-0000-0000-000000000006', 'Cabo de Rede Cat6',   'ELT-CAT-006', 1, 'm',   120.00,   200.00,  50, 18, '10000000-0000-0000-0000-000000000001', 'Cabo UTP Cat6 por metro'),
    ('30000000-0000-0000-0000-000000000007', 'SSD 480GB SATA',      'ARM-SSD-480', 3, 'un',18000.00, 24000.00,   5, 12, '10000000-0000-0000-0000-000000000002', 'SSD SATA III 480GB 550MB/s');

ALTER TABLE produtos ENABLE TRIGGER trg_produtos_updated;

-- Movimentações históricas (inserir sem trigger de stock pois stock_atual já está nos produtos)
ALTER TABLE movimentacoes DISABLE TRIGGER trg_movimentacao_stock;

INSERT INTO movimentacoes (produto_id, tipo, quantidade, armazem_origem, armazem_destino, motivo, referencia, utilizador_id, criado_em) VALUES
    ('30000000-0000-0000-0000-000000000001', 'entrada',       20, NULL,                                     '10000000-0000-0000-0000-000000000001', 'Reposição mensal',      NULL,       '00000000-0000-0000-0000-000000000001', '2025-03-01 09:15:00+00'),
    ('30000000-0000-0000-0000-000000000002', 'saida',          5, '10000000-0000-0000-0000-000000000001', NULL,                                     'Venda #2341',           'VND-2341', '00000000-0000-0000-0000-000000000002', '2025-03-01 11:30:00+00'),
    ('30000000-0000-0000-0000-000000000003', 'transferencia',  3, '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'Redistribuição',        NULL,       '00000000-0000-0000-0000-000000000003', '2025-02-28 15:00:00+00'),
    ('30000000-0000-0000-0000-000000000004', 'saida',          1, '10000000-0000-0000-0000-000000000001', NULL,                                     'Venda #2340',           'VND-2340', '00000000-0000-0000-0000-000000000001', '2025-02-28 10:00:00+00'),
    ('30000000-0000-0000-0000-000000000006', 'entrada',       30, NULL,                                     '10000000-0000-0000-0000-000000000001', 'Compra #PO-0045',       'PO-0045',  '00000000-0000-0000-0000-000000000003', '2025-02-27 08:00:00+00'),
    ('30000000-0000-0000-0000-000000000005', 'ajuste',         2, NULL,                                     '10000000-0000-0000-0000-000000000002', 'Correcção inventário',  NULL,       '00000000-0000-0000-0000-000000000003', '2025-02-26 16:45:00+00');

ALTER TABLE movimentacoes ENABLE TRIGGER trg_movimentacao_stock;

-- Vendas
INSERT INTO vendas (id, cliente_id, cliente_nome, utilizador_id, metodo_pagamento, desconto_pct, subtotal, total, estado, criado_em) VALUES
    ('VND-0001', '20000000-0000-0000-0000-000000000001', 'Empresa ABC Lda', '00000000-0000-0000-0000-000000000001', 'transferencia', 0,   9950.00,  9950.00, 'concluida', '2025-02-28 14:30:00+00'),
    ('VND-0002', NULL,                                   '— Avulso —',       '00000000-0000-0000-0000-000000000002', 'dinheiro',      0,   2400.00,  2400.00, 'concluida', '2025-02-28 16:05:00+00'),
    ('VND-0003', '20000000-0000-0000-0000-000000000002', 'Pedro Lopes',      '00000000-0000-0000-0000-000000000001', 'cartao',        5,   6700.00,  6365.00, 'concluida', '2025-03-01 09:10:00+00'),
    ('VND-0004', '20000000-0000-0000-0000-000000000003', 'Farmácia Saúde',   '00000000-0000-0000-0000-000000000001', 'transferencia', 10, 36000.00, 32400.00, 'concluida', '2025-03-01 11:45:00+00');

-- Itens das vendas
INSERT INTO venda_itens (venda_id, produto_id, produto_nome, produto_sku, quantidade, preco_unitario) VALUES
    ('VND-0001', '30000000-0000-0000-0000-000000000001', 'Cabo HDMI 2.0 2m',  'ELT-CAB-001', 3, 1850.00),
    ('VND-0001', '30000000-0000-0000-0000-000000000005', 'Mouse Óptico USB',   'PER-MOU-001', 2, 2200.00),
    ('VND-0002', '30000000-0000-0000-0000-000000000002', 'Pen Drive 64GB',     'ARM-PEN-064', 1, 2400.00),
    ('VND-0003', '30000000-0000-0000-0000-000000000003', 'Teclado USB ABNT2',  'PER-TEC-001', 1, 4500.00),
    ('VND-0003', '30000000-0000-0000-0000-000000000005', 'Mouse Óptico USB',   'PER-MOU-001', 1, 2200.00),
    ('VND-0004', '30000000-0000-0000-0000-000000000007', 'SSD 480GB SATA',     'ARM-SSD-480', 2,18000.00);

-- Auditoria log histórico
INSERT INTO auditoria_log (id, tipo, descricao, utilizador_id, criado_em) VALUES
    ('40000000-0000-0000-0000-000000000001', 'contagem',   'Contagem física mensal — Fevereiro',     '00000000-0000-0000-0000-000000000001', '2025-02-15 09:00:00+00'),
    ('40000000-0000-0000-0000-000000000002', 'ajuste',     'Correcção — produto danificado',         '00000000-0000-0000-0000-000000000002', '2025-02-20 14:30:00+00'),
    ('40000000-0000-0000-0000-000000000003', 'importacao', 'Importação CSV — reposição de stock',    '00000000-0000-0000-0000-000000000003', '2025-02-25 08:00:00+00');

INSERT INTO auditoria_alteracoes (auditoria_id, produto_id, produto_nome, stock_antes, stock_depois) VALUES
    ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Cabo HDMI 2.0 2m', 30, 45),
    ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Pen Drive 64GB',   12,  8),
    ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000004', 'Monitor 24" FHD',   4,  3),
    ('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000006', 'Cabo de Rede Cat6', 0, 48),
    ('40000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000005', 'Mouse Óptico USB', 25, 31);

-- ============================================================
--  SEQUÊNCIA de vendas: avançar para não conflituar com seeds
-- ============================================================
SELECT SETVAL('venda_seq', 5);

-- ============================================================
--  QUERIES DE VERIFICAÇÃO (comentadas — descomente para testar)
-- ============================================================
/*
-- Ver todos os produtos com estado de stock
SELECT nome, sku, stock_atual, stock_minimo, estado_stock, armazem FROM v_produtos_stock;

-- Ver alertas activos
SELECT * FROM v_alertas_stock;

-- Receita total
SELECT * FROM v_receita_mes;

-- Resumo de clientes
SELECT * FROM v_clientes_resumo;

-- Histórico de movimentações
SELECT m.criado_em, p.nome, m.tipo, m.quantidade, m.motivo
FROM movimentacoes m
JOIN produtos p ON p.id = m.produto_id
ORDER BY m.criado_em DESC;
*/

-- ============================================================
--  FIM DO SCRIPT
-- ============================================================
