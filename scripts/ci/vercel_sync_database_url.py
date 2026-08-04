#!/usr/bin/env python3
"""
Sincroniza DATABASE_URL no projecto Vercel via API REST.

Env obrigatórias:
  VERCEL_TOKEN, VERCEL_PROJECT_ID, DATABASE_URL_SYNC_VALUE

Env opcionais:
  VERCEL_TEAM_ID
  VERCEL_SYNC_TARGET   — \"preview\" (default) ou \"production\"
  VERCEL_GIT_BRANCH    — só para preview: ex. develop | qualidade (evita misturar BDs entre previews)
  VERCEL_SYNC_EXTRA_KEY / VERCEL_SYNC_EXTRA_VALUE — segunda variável no mesmo alvo (ex.: STOCKOS_READ_ONLY=1)

Remoção: apaga entradas DATABASE_URL do mesmo alvo sem misturar branches (ex.: ao sinc develop
não remove a variável específica do branch qualidade).
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
    db_url = os.environ.get("DATABASE_URL_SYNC_VALUE", "").strip()
    target = (os.environ.get("VERCEL_SYNC_TARGET") or "preview").strip().lower()
    sync_branch = (os.environ.get("VERCEL_GIT_BRANCH") or "").strip() or None

    if not token or not project_id or not db_url:
        print(
            "::error::VERCEL_TOKEN, VERCEL_PROJECT_ID e DATABASE_URL_SYNC_VALUE são obrigatórios.",
            file=sys.stderr,
        )
        sys.exit(1)
    if target not in ("preview", "production"):
        print("::error::VERCEL_SYNC_TARGET deve ser preview ou production.", file=sys.stderr)
        sys.exit(1)
    if target == "production" and sync_branch:
        print("::warning::VERCEL_GIT_BRANCH ignorado para production.", file=sys.stderr)
        sync_branch = None

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

    def should_delete_preview(e: dict) -> bool:
        targets = list(e.get("target") or [])
        if targets != ["preview"]:
            if "preview" in targets:
                print(
                    "::warning::DATABASE_URL partilha Preview com outros ambientes; não removo.",
                    file=sys.stderr,
                )
            return False
        gb = (e.get("gitBranch") or "").strip()
        if sync_branch:
            if gb == sync_branch:
                return True
            if not gb:
                return True
            return False
        return not gb

    def should_delete_production(e: dict) -> bool:
        targets = list(e.get("target") or [])
        if targets != ["production"]:
            if "production" in targets:
                print(
                    "::warning::DATABASE_URL partilha Production com outros ambientes; não removo.",
                    file=sys.stderr,
                )
            return False
        return True

    def sync_key(key: str, value: str) -> None:
        """Apaga entradas exclusivas do alvo e recria; se a variável for
        PARTILHADA com outros ambientes (ex.: target production+preview+
        development), actualiza o valor NO LUGAR (PATCH) em vez de tentar
        criar uma duplicada — o POST falhava com ENV_ALREADY_EXISTS."""
        listed = req("GET", list_url)
        shared = None
        for e in listed.get("envs") or []:
            if e.get("key") != key:
                continue
            eid = e.get("id")
            if not eid:
                continue
            apagar = (
                should_delete_preview(e) if target == "preview" else should_delete_production(e)
            )
            if apagar:
                req("DELETE", f"{env_root}/{eid}{q}")
                print(f"Removido {key} ({target}) id={eid} gitBranch={e.get('gitBranch')!r}")
            elif target in list(e.get("target") or []):
                shared = e  # partilhada com outros ambientes — actualizar no lugar

        extra = f" branch={sync_branch!r}" if sync_branch else ""
        if shared is not None:
            req(
                "PATCH",
                f"{env_root}/{shared['id']}{q}",
                json.dumps({"value": value}).encode(),
            )
            print(
                f"{key} ({target}) actualizado na variável PARTILHADA "
                f"(targets={shared.get('target')}).{extra}"
            )
            return

        payload: dict = {
            "key": key,
            "value": value,
            "type": "encrypted",
            "target": [target],
        }
        if sync_branch:
            payload["gitBranch"] = sync_branch
        req("POST", f"{env_root}{q}", json.dumps(payload).encode())
        print(f"{key} ({target}) actualizado na Vercel.{extra}")

    sync_key("DATABASE_URL", db_url)

    extra_key = (os.environ.get("VERCEL_SYNC_EXTRA_KEY") or "").strip()
    extra_val = (os.environ.get("VERCEL_SYNC_EXTRA_VALUE") or "").strip()
    if extra_key and extra_val:
        sync_key(extra_key, extra_val)


if __name__ == "__main__":
    main()
