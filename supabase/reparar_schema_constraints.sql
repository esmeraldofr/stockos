-- FASE 2 — TROCA DE CONSTRAINTS (idempotente, mas SÓ com o código NOVO no ar).
-- Remove as constraints antigas de unicidade que o código ANTIGO usa em
-- ON CONFLICT (ex.: armazem_inventario_diario ON CONFLICT (data, produto_id)
-- no main actual). Correr isto em produção com o código antigo PARTE a app:
-- «no unique or exclusion constraint matching the ON CONFLICT specification».
-- Ordem certa: 1) fase aditiva → 2) promover código a main → 3) esta fase.
-- Os índices únicos por loja já existem (criados na fase aditiva); estes
-- CREATE ... IF NOT EXISTS são só rede de segurança se a fase 1 não correu.
CREATE UNIQUE INDEX IF NOT EXISTS idx_amz_inv_diario_loja ON armazem_inventario_diario (loja_id, data, produto_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_loja_data_nome ON turnos (loja_id, data, nome);
ALTER TABLE armazem_inventario_diario DROP CONSTRAINT IF EXISTS armazem_inventario_diario_data_produto_id_key;
ALTER TABLE turnos DROP CONSTRAINT IF EXISTS turnos_data_nome_key;
