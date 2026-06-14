const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const FormData = require('form-data');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
console.log('ffmpeg path:', ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Single multer instance for all uploads
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegInstaller.path, ffmpegExists: fs.existsSync(ffmpegInstaller.path), node: process.version });
});

// Groups
app.get('/api/groups', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId wajib' });
  try {
    const resp = await axios.get(`https://groups.roblox.com/v2/users/${userId}/groups/roles`, { validateStatus: () => true });
    const groups = (resp.data?.data || [])
      .filter(g => g.role?.rank >= 200 || g.group?.owner?.userId == userId)
      .map(g => ({ id: g.group.id, name: g.group.name, role: g.role?.name }));
    res.json({ groups });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single upload
app.post('/api/process-upload', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `out_${Date.now()}.mp3`);
  try {
    const { apiKey, userId, groupId, name, description, speed, amplify } = req.body;
    if (!apiKey || !userId || !name) return res.status(400).json({ error: 'apiKey, userId, name wajib' });
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });

    const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 1));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || 0));
    const safeName = sanitizeName(name);
    const creator = resolveCreator(userId, groupId);

    console.log(`Single upload: "${safeName}" speed=${speedVal} amp=${amplifyVal}`);
    await processAudio(inputPath, outputPath, speedVal, amplifyVal);
    const assetId = await uploadToRoblox(outputPath, apiKey, creator, safeName, description || '');
    res.json({ success: true, assetId, name: safeName });
  } catch(err) {
    console.error('Single upload error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { cleanup(inputPath, outputPath); }
});

// Bulk upload (SSE) — handles BOTH bypass and direct (speed=1, amplify=0)
app.post('/api/bulk-upload', upload.array('audio', 50), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Tidak ada file' });

  const { apiKey, userId, groupId, speed, amplify, namePrefix } = req.body;
  if (!apiKey || !userId) return res.status(400).json({ error: 'apiKey dan userId wajib' });

  const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 1));
  const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || 0));
  const creator = resolveCreator(userId, groupId);

  console.log(`Bulk upload: ${files.length} files, speed=${speedVal} amp=${amplifyVal} creator=${JSON.stringify(creator)}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };
  send({ type: 'start', total: files.length });

  const results = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const outputPath = path.join(os.tmpdir(), `bulk_${Date.now()}_${i}.mp3`);
    const rawName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const baseName = rawName.replace(/\.[^.]+$/, '');
    const safeName = sanitizeName((namePrefix ? namePrefix + ' ' : '') + baseName);

    console.log(`Bulk item ${i+1}/${files.length}: "${safeName}" file="${file.originalname}" size=${file.size}`);
    send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'processing' });

    try {
      await processAudio(file.path, outputPath, speedVal, amplifyVal);
      const outSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      console.log(`Processed size: ${(outSize/1024/1024).toFixed(2)}MB`);

      const assetId = await uploadToRoblox(outputPath, apiKey, creator, safeName, '');
      results.push({ name: safeName, assetId, status: 'success' });
      send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'success', assetId });
      console.log(`✓ Item ${i+1} success: ${assetId}`);
    } catch(e) {
      console.error(`✗ Item ${i+1} error:`, e.message);
      results.push({ name: safeName, status: 'error', error: e.message });
      send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'error', error: e.message });
    } finally {
      cleanup(file.path, outputPath);
    }

    // Delay between uploads to avoid rate limiting
    if (i < files.length - 1) await sleep(1200);
  }

  send({ type: 'done', results });
  res.end();
});

// Preview
app.post('/api/preview', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `preview_${Date.now()}.mp3`);
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const speedVal = Math.max(0.5, Math.min(10, parseFloat(req.body.speed) || 1));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(req.body.amplify) || 0));
    await processAudio(inputPath, outputPath, speedVal, amplifyVal);
    const audioData = fs.readFileSync(outputPath);
    res.json({ success: true, audio: audioData.toString('base64'), size: audioData.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  } finally { cleanup(inputPath, outputPath); }
});

// ===== HELPERS =====
function resolveCreator(userId, groupId) {
  return groupId && groupId !== 'personal' && groupId !== ''
    ? { groupId: parseInt(groupId, 10) }
    : { userId: parseInt(userId, 10) };
}

function sanitizeName(name) {
  return (name || 'Audio').replace(/[^\w\s\-]/g, '').trim().slice(0, 50) || 'Audio';
}

function processAudio(inputPath, outputPath, speed, amplifyDb) {
  return new Promise((resolve, reject) => {
    const isDirectUpload = Math.abs(speed - 1.0) < 0.01 && Math.abs(amplifyDb) < 0.01;

    if (isDirectUpload) {
      // No processing needed — just copy/convert to mp3
      console.log('Direct upload: converting to mp3 without filters');
      ffmpeg(inputPath)
        .audioChannels(2)
        .audioFrequency(44100)
        .audioBitrate('192k')
        .toFormat('mp3')
        .on('start', cmd => console.log('ffmpeg cmd:', cmd))
        .on('end', resolve)
        .on('error', (err, stdout, stderr) => {
          console.error('ffmpeg error:', err.message, stderr);
          reject(new Error('ffmpeg: ' + err.message));
        })
        .save(outputPath);
      return;
    }

    // Bypass mode — build filter chain carefully to minimize robot voice
    // Key: use rubberband-style approach with aresample + atempo
    // atempo preserves pitch while changing tempo
    const filters = buildFilterChain(speed, amplifyDb);
    console.log('Bypass filters:', filters.join(','));

    ffmpeg(inputPath)
      .audioChannels(2)
      .audioFrequency(44100)
      .audioBitrate('192k')
      .audioFilters(filters)
      .toFormat('mp3')
      .on('start', cmd => console.log('ffmpeg cmd:', cmd))
      .on('end', resolve)
      .on('error', (err, stdout, stderr) => {
        console.error('ffmpeg error:', err.message, stderr);
        reject(new Error('ffmpeg: ' + err.message));
      })
      .save(outputPath);
  });
}

function buildFilterChain(speed, amplifyDb) {
  const filters = [];

  // Resample to consistent rate first
  filters.push('aresample=44100');

  // Build atempo chain (each filter must be 0.5-2.0)
  const atempoFilters = buildAtempoChain(speed);
  filters.push(...atempoFilters);

  // Resample again after tempo change to clean up artifacts
  filters.push('aresample=44100');

  // Apply volume if needed
  if (Math.abs(amplifyDb) > 0.01) {
    filters.push(`volume=${amplifyDb}dB`);
  }

  return filters;
}

function buildAtempoChain(speed) {
  const filters = [];
  let rem = speed;

  // Chain atempo filters, each clamped to 0.5-2.0
  while (rem > 2.0) {
    filters.push('atempo=2.0');
    rem /= 2.0;
  }
  while (rem < 0.5) {
    filters.push('atempo=0.5');
    rem *= 2.0;
  }

  // Apply remaining speed if not 1.0
  if (Math.abs(rem - 1.0) > 0.001) {
    filters.push(`atempo=${rem.toFixed(6)}`);
  }

  if (filters.length === 0) filters.push('atempo=1.0');
  return filters;
}

async function uploadToRoblox(filePath, apiKey, creator, name, description) {
  const fileBuffer = fs.readFileSync(filePath);
  if (fileBuffer.length > 19.5 * 1024 * 1024) {
    throw new Error(`File terlalu besar (${(fileBuffer.length/1024/1024).toFixed(1)}MB). Batas Roblox 20MB.`);
  }

  const requestMeta = JSON.stringify({
    displayName: name,
    description: description || '',
    assetType: 'Audio',
    creationContext: { creator }
  });

  console.log('Upload to Roblox:', name, '| creator:', JSON.stringify(creator));

  const form = new FormData();
  form.append('request', requestMeta, { contentType: 'application/json' });
  form.append('fileContent', fileBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });

  const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: { 'x-api-key': apiKey, ...form.getHeaders() },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
    validateStatus: () => true
  });

  console.log('Roblox status:', response.status, '| data:', JSON.stringify(response.data));

  if (response.status === 401) throw new Error('API Key tidak valid atau expired');
  if (response.status === 403) throw new Error('API Key tidak punya permission Assets Write');
  if (response.status >= 400) {
    const msg = response.data?.message || response.data?.errors?.[0]?.message || JSON.stringify(response.data);
    throw new Error(`Roblox ${response.status}: ${msg}`);
  }

  const data = response.data;

  if (data.operationId) {
    console.log('Polling operationId:', data.operationId);
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      try {
        const opRes = await axios.get(
          `https://apis.roblox.com/assets/v1/operations/${data.operationId}`,
          { headers: { 'x-api-key': apiKey }, validateStatus: () => true }
        );
        console.log(`Poll ${i+1}:`, JSON.stringify(opRes.data));
        if (opRes.data?.done) {
          const id = opRes.data?.response?.assetId || opRes.data?.assetId;
          if (id) return id;
        }
      } catch(e) { console.error('Poll error:', e.message); }
    }
    return `pending:${data.operationId}`;
  }

  const assetId = data.assetId || data?.response?.assetId;
  if (assetId) return assetId;
  throw new Error('Tidak ada assetId: ' + JSON.stringify(data));
}

function cleanup(...paths) {
  paths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
