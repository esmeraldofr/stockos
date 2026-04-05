-- Bucket público para fotos de borderô (depósitos). Referência: api/server.js BORDERO_BUCKET.
-- Executar na base do projeto Supabase (SQL Editor ou psql) se o bucket ainda não existir.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('depositos-bordero', 'depositos-bordero', true, 52428800)
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit;
