#!/usr/bin/env node
// Gera build-info.json com a versão actual no momento do build.
// Corre via "postinstall" no Vercel (env VERCEL_GIT_*) ou local (fallback git).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function safeGit(cmd) {
  try { return execSync('git ' + cmd, { stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
  catch (_) { return ''; }
}

const sha = process.env.VERCEL_GIT_COMMIT_SHA || safeGit('rev-parse HEAD');
const ref = process.env.VERCEL_GIT_COMMIT_REF || process.env.VERCEL_GIT_BRANCH || safeGit('rev-parse --abbrev-ref HEAD');
const msgRaw = process.env.VERCEL_GIT_COMMIT_MESSAGE || (sha ? safeGit(`log -1 --format=%s ${sha}`) : '');
const commitTs = sha
  ? safeGit(`log -1 --format=%cI ${sha}`)
  : '';

const info = {
  builtAt: new Date().toISOString(),
  commitAt: commitTs || null,
  sha: sha ? sha.slice(0, 7) : null,
  fullSha: sha || null,
  ref: ref || null,
  msg: msgRaw ? msgRaw.split('\n')[0].slice(0, 120) : null,
  source: process.env.VERCEL ? 'vercel' : 'local'
};

const out = path.join(__dirname, '..', 'build-info.json');
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
console.log('[build-info]', info);
