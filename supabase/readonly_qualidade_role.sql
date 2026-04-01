-- =============================================================================
-- Utilizador PostgreSQL só de leitura para o ambiente «Qualidade» (Vercel).
-- Executar UMA VEZ no SQL Editor do projecto Supabase de PRODUÇÃO (como postgres).
--
-- Depois: definir palavra-passe forte e construir a URL para o secret
-- DATABASE_URL_QUALIDADE no GitHub (mesmo host/pooler que produção, user abaixo).
--
-- Nota: qualquer INSERT/UPDATE/DELETE na app em Qualidade vai falhar (esperado).
-- Nota: se tiveres RLS activo em alguma tabela, este role precisa de políticas que
--       permitam SELECT ao role ou o leitor não vê linhas.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockos_qualidade_readonly') THEN
    CREATE ROLE stockos_qualidade_readonly WITH LOGIN;
  END IF;
END
$$;

-- Definir palavra-passe (altera aqui antes de correr, ou corre ALTER ROLE depois)
ALTER ROLE stockos_qualidade_readonly WITH PASSWORD 'SUBSTITUIR_PALAVRA_PASSE_SEGURA';

GRANT CONNECT ON DATABASE postgres TO stockos_qualidade_readonly;
GRANT USAGE ON SCHEMA public TO stockos_qualidade_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO stockos_qualidade_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO stockos_qualidade_readonly;

-- Tabelas novas criadas no futuro (pelo role que as criar — normalmente postgres)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO stockos_qualidade_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO stockos_qualidade_readonly;
