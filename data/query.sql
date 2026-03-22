-- Verificar admin (2026-03-22)
SELECT id, email, role, ativo,
  CASE WHEN senha_hash = '' THEN 'VAZIO' ELSE LEFT(senha_hash, 10) || '...' END AS hash_preview
FROM utilizadores WHERE email = 'admin@stockos.ao';
