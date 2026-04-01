#!/usr/bin/env python3
"""Emite linhas export PG*=... para forçar IPv4 (PGHOSTADDR) e evitar falha IPv6 nos runners."""
import os
import shlex
import socket
import sys
import urllib.parse


def ipv4_for_host(host: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror as e:
        print(f"DNS IPv4 falhou para {host}: {e}", file=sys.stderr)
        sys.exit(1)
    if not infos:
        print(f"Sem registo A para {host}", file=sys.stderr)
        sys.exit(1)
    return infos[0][4][0]


def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DATABASE_URL", "")
    if not url:
        print("Uso: pg_env_from_url.py <postgres-uri>", file=sys.stderr)
        sys.exit(1)
    u = urllib.parse.urlparse(url)
    host = u.hostname
    if not host:
        print("URI sem hostname", file=sys.stderr)
        sys.exit(1)
    port = u.port or 5432
    ipv4 = ipv4_for_host(host, port)
    user = urllib.parse.unquote(u.username) if u.username else "postgres"
    pwd = urllib.parse.unquote(u.password or "")
    db = (u.path or "/postgres").lstrip("/") or "postgres"
    for k, v in [
        ("PGHOST", host),
        ("PGHOSTADDR", ipv4),
        ("PGUSER", user),
        ("PGPASSWORD", pwd),
        ("PGPORT", str(port)),
        ("PGDATABASE", db),
        ("PGSSLMODE", "require"),
    ]:
        print(f"export {k}={shlex.quote(v)}")


if __name__ == "__main__":
    main()
