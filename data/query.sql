SELECT p.nome AS produto, c.nome AS componente, r.quantidade
FROM receitas r
JOIN produtos p ON p.id = r.produto_id
JOIN produtos c ON c.id = r.componente_id
ORDER BY p.nome, r.quantidade DESC
