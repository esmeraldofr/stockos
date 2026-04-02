-- Executar no Supabase: SQL Editor, como role postgres (não como stockos_app).
-- Ajusta «stockos_app» ao nome do user que está na DATABASE_URL da Vercel (sem password).

GRANT USAGE ON SCHEMA public TO stockos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stockos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stockos_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO stockos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO stockos_app;

-- Se ainda vires «must be owner» ao correr migrações pela API, o DDL tem de ser feito aqui uma vez, por exemplo:
-- ALTER TABLE public.utilizadores OWNER TO stockos_app;
-- (só se quiseres que o mesmo role faça ALTER TABLE; caso contrário mantém owner postgres e aplica schema só neste editor.)
