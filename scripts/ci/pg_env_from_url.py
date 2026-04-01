#!/usr/bin/env python3
"""Emite linhas export PG*=... para forçar IPv4 (PGHOSTADDR) e evitar falha IPv6 nos runners."""
import os
import shlex
import subprocess
import sys
import urllib.parse


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
    out = subprocess.check_output(["getent", "ahostsv4", host], text=True)
    lines = [ln.split()[0] for ln in out.strip().splitlines() if ln.strip()]
    if not lines:
        print(f"Sem IPv4 (ahostsv4) para {host}", file=sys.stderr)
        sys.exit(1)
    ipv4 = lines[0]
    user = urllib.parse.unquote(u.username) if u.username else "postgres"
    pwd = urllib.parse.unquote(u.password or "")
    port = u.port or 5432
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
