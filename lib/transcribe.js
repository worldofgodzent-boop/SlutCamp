'use strict';
/*
 * Whisper transcription for the live safety bot.
 *
 * Production (Render): set OPENAI_API_KEY in the service environment and this
 * module calls the OpenAI transcription API directly from Node — no local
 * files, no external credential machinery.
 *
 * Local dev fallback: when OPENAI_API_KEY is not set but the workspace
 * openai-whisper skill exists on this machine, shell out to its CLI (which
 * uses the locally stored connector credential). This path only exists on
 * the dev box; it is never available in production.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com';
const LOCAL_CLI = '/home/hatch/workspace/skills/openai-whisper/bin/transcribe.py';

const MIME_BY_EXT = {
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
};

async function transcribeViaApi(filePath) {
  const key = process.env.OPENAI_API_KEY;
  const ext = path.extname(filePath).toLowerCase() || '.webm';
  const buf = await fs.promises.readFile(filePath);
  const fd = new FormData();
  fd.append('model', 'whisper-1');
  fd.append('language', 'en');
  fd.append('file', new Blob([buf], { type: MIME_BY_EXT[ext] || 'audio/webm' }),
    'chunk' + (MIME_BY_EXT[ext] ? ext : '.webm'));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(API_BASE + '/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: fd,
      signal: ctl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error('whisper api ' + r.status + ': ' + body.slice(0, 200));
    }
    const data = await r.json();
    return String(data.text || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

function transcribeViaLocalCli(filePath) {
  return new Promise((resolve, reject) => {
    execFile('python3', [LOCAL_CLI, filePath], { timeout: 90000 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(String(stdout || '').trim());
      });
  });
}

let warnedNoBackend = false;

/* Returns the transcript text ('' when silent/unintelligible). Throws only
 * when a configured backend fails; callers log and move on. */
async function transcribeAudio(filePath) {
  if (process.env.OPENAI_API_KEY) return transcribeViaApi(filePath);
  if (fs.existsSync(LOCAL_CLI)) return transcribeViaLocalCli(filePath);
  if (!warnedNoBackend) {
    warnedNoBackend = true;
    console.warn('[safety-bot] No transcription backend: OPENAI_API_KEY is not set ' +
      'and the local whisper CLI is absent. Spoken-audio monitoring is OFF.');
  }
  return '';
}

module.exports = { transcribeAudio };
