-- Repor password admin e verificar (2026-03-22)
UPDATE utilizadores
  SET senha_hash = encode(sha256(('admin123stockos-pwd-salt-2025')::bytea), 'hex')
  WHERE email = 'admin@stockos.ao';

SELECT id, email, role, ativo,
  LEFT(senha_hash, 16) || '...' AS hash_preview
FROM utilizadores WHERE email = 'admin@stockos.ao';
