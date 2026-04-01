#!/usr/bin/env python3
"""
Define DATABASE_URL no ambiente Preview do projecto Vercel (API REST).
Assim os deploys feitos pela integração Git (sem --env do CLI) usam a BD de dev.

Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, DATABASE_URL_DEV
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


def main() -> None:
    token = os.environ.get("VERCEL_TOKEN", "").strip()
    project_id = os.environ.get("VERCEL_PROJECT_ID", "").strip()
    db_url = os.environ.get("DATABASE_URL_DEV", "").strip()
    if not token or not project_id or not db_url:
        print("::error::VERCEL_TOKEN, VERCEL_PROJECT_ID e DATABASE_URL_DEV são obrigatórios.", file=sys.stderr)
        sys.exit(1)

    team = os.environ.get("VERCEL_TEAM_ID", "").strip()
    q = f"?teamId={team}" if team else ""
    env_root = f"https://api.vercel.com/v9/projects/{project_id}/env"
    list_url = f"{env_root}{q}"
    headers = {"Authorization": f"Bearer {token}"}

    def req(method: str, url: str, data: bytes | None = None) -> dict:
        h = {**headers, "Content-Type": "application/json"} if data else headers
        r = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                body = resp.read().decode()
                return json.loads(body) if body.strip() else {}
        except urllib.error.HTTPError as e:
            err = e.read().decode() if e.fp else str(e)
            print(f"::error::HTTP {e.code} {method} {url}: {err}", file=sys.stderr)
            raise

    listed = req("GET", list_url)
    envs = listed.get("envs") or []
    for e in envs:
        if e.get("key") != "DATABASE_URL":
            continue
        targets = list(e.get("target") or [])
        if targets != ["preview"]:
            if "preview" in targets:
                print(
                    "::warning::DATABASE_URL partilha Preview com outros ambientes na Vercel; "
                    "não removo automaticamente. Corrige no dashboard se Preview usar BD de produção.",
                    file=sys.stderr,
                )
            continue
        eid = e.get("id")
        if not eid:
            continue
        del_url = f"{env_root}/{eid}{q}"
        req("DELETE", del_url)
        print(f"Removido env antigo DATABASE_URL (preview) id={eid}")

    body = json.dumps(
        {
            "key": "DATABASE_URL",
            "value": db_url,
            "type": "encrypted",
            "target": ["preview"],
        }
    ).encode()
    req("POST", f"{env_root}{q}", body)
    print("DATABASE_URL de Preview actualizado na Vercel.")


if __name__ == "__main__":
    main()
