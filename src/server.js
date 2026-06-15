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

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegInstaller.path, node: process.version });
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
  const outputPath = path.join(os.tmpdir(), `out_${Date.now()}.ogg`);
  try {
    const { apiKey, userId, groupId, name, description, speed, amplify } = req.body;
    if (!apiKey || !userId || !name) return res.status(400).json({ error: 'apiKey, userId, name wajib' });
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 1));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || 0));
    const safeName = sanitizeName(name);
    const creator = resolveCreator(userId, groupId);
    await processAudio(inputPath, outputPath, speedVal, amplifyVal);
    const assetId = await uploadToRoblox(outputPath, apiKey, creator, safeName, description || '');
    res.json({ success: true, assetId, name: safeName });
  } catch(err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  } finally { cleanup(inputPath, outputPath); }
});

// Bulk upload SSE
app.post('/api/bulk-upload', upload.array('audio', 50), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Tidak ada file' });
  const { apiKey, userId, groupId, speed, amplify, namePrefix } = req.body;
  if (!apiKey || !userId) return res.status(400).json({ error: 'apiKey dan userId wajib' });
  const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 1));
  const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || 0));
  const creator = resolveCreator(userId, groupId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };
  send({ type: 'start', total: files.length });
  const results = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const outputPath = path.join(os.tmpdir(), `bulk_${Date.now()}_${i}.ogg`);
    const rawName = (() => { try { return Buffer.from(file.originalname,'latin1').toString('utf8'); } catch(e) { return file.originalname; } })();
    const baseName = rawName.replace(/\.[^.]+$/, '');
    const safeName = sanitizeName((namePrefix ? namePrefix + ' ' : '') + baseName);

    send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'processing' });
    try {
      await processAudio(file.path, outputPath, speedVal, amplifyVal);
      const assetId = await uploadToRoblox(outputPath, apiKey, creator, safeName, '');
      results.push({ name: safeName, assetId, status: 'success' });
      send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'success', assetId });
    } catch(e) {
      results.push({ name: safeName, status: 'error', error: e.message });
      send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'error', error: e.message });
    } finally { cleanup(file.path, outputPath); }
    if (i < files.length - 1) await sleep(1200);
  }

  send({ type: 'done', results });
  res.end();
});

// Preview
app.post('/api/preview', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `preview_${Date.now()}.ogg`);
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

// Set permission for a single asset
app.post('/api/set-permission', async (req, res) => {
  const { apiKey, assetId, target } = req.body;
  if (!apiKey || !assetId || !target) return res.status(400).json({ error: 'apiKey, assetId, target wajib' });

  try {
    let body = {};

    if (target.type === 'public') {
      // Set asset to public via Open Cloud
      body = {
        requests: [{
          subject: { allUsers: {} },
          action: 'USE'
        }]
      };
    } else if (target.type === 'group') {
      body = {
        requests: [{
          subject: { group: { id: String(target.id) } },
          action: 'USE'
        }]
      };
    } else if (target.type === 'user') {
      body = {
        requests: target.ids.map(id => ({
          subject: { user: { id: String(id) } },
          action: 'USE'
        }))
      };
    } else if (target.type === 'experience') {
      body = {
        requests: target.ids.map(id => ({
          subject: { experience: { universeId: String(id) } },
          action: 'USE'
        }))
      };
    }

    const response = await axios.post(
      `https://apis.roblox.com/assets/v1/assets/${assetId}/permissions`,
      body,
      {
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        validateStatus: () => true,
        timeout: 15000
      }
    );

    console.log(`Permission ${assetId} → status ${response.status}:`, JSON.stringify(response.data));

    if (response.status === 401) throw new Error('API Key tidak valid');
    if (response.status === 403) throw new Error('Tidak punya akses ke asset ini');
    if (response.status >= 400) {
      const msg = response.data?.message || response.data?.errors?.[0]?.message || JSON.stringify(response.data);
      throw new Error(`Roblox ${response.status}: ${msg}`);
    }

    res.json({ success: true });
  } catch(e) {
    console.error('Permission error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===== AUDIO PROCESSING =====
function processAudio(inputPath, outputPath, speed, amplifyDb) {
  return new Promise((resolve, reject) => {
    const isDirect = Math.abs(speed - 1.0) < 0.001 && Math.abs(amplifyDb) < 0.001;

    let cmd = ffmpeg(inputPath)
      .audioChannels(2)
      .audioFrequency(44100)
      .audioQuality(3);

    if (isDirect) {
      // No filters — pure conversion
      cmd = cmd.toFormat('ogg');
    } else {
      // Key insight: to avoid robot voice, we need to:
      // 1. Resample UP to higher rate first (gives atempo more data to work with)
      // 2. Apply atempo (pitch-preserving time stretch)
      // 3. Resample back to 44100
      // 4. Apply volume if needed
      const filters = [];

      // Step 1: upsample for better quality processing
      filters.push('aresample=resampler=swr:sample_rate=96000:ocl=stereo');

      // Step 2: atempo chain (each node 0.5–2.0)
      let rem = speed;
      while (rem > 2.0) { filters.push('atempo=2.0'); rem /= 2.0; }
      while (rem < 0.5) { filters.push('atempo=0.5'); rem *= 2.0; }
      if (Math.abs(rem - 1.0) > 0.0001) filters.push(`atempo=${rem.toFixed(8)}`);

      // Step 3: downsample back
      filters.push('aresample=resampler=swr:sample_rate=44100');

      // Step 4: volume
      if (Math.abs(amplifyDb) > 0.01) filters.push(`volume=${amplifyDb}dB`);

      cmd = cmd.audioFilters(filters).toFormat('ogg');
    }

    cmd
      .on('start', c => console.log('ffmpeg:', c))
      .on('end', resolve)
      .on('error', (err, _, stderr) => {
        console.error('ffmpeg error:', err.message);
        console.error('stderr:', stderr);
        reject(new Error('ffmpeg: ' + err.message));
      })
      .save(outputPath);
  });
}

// ===== ROBLOX UPLOAD =====
async function uploadToRoblox(filePath, apiKey, creator, name, description) {
  const fileBuffer = fs.readFileSync(filePath);
  if (fileBuffer.length > 19.5 * 1024 * 1024) throw new Error(`File terlalu besar (${(fileBuffer.length/1024/1024).toFixed(1)}MB). Batas 20MB.`);

  const form = new FormData();
  form.append('request', JSON.stringify({
    displayName: name, description: description || '',
    assetType: 'Audio',
    creationContext: { creator }
  }), { contentType: 'application/json' });
  form.append('fileContent', fileBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });

  const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: { 'x-api-key': apiKey, ...form.getHeaders() },
    maxContentLength: Infinity, maxBodyLength: Infinity,
    timeout: 120000, validateStatus: () => true
  });

  console.log('Roblox status:', response.status, JSON.stringify(response.data));
  if (response.status === 401) throw new Error('API Key tidak valid atau expired');
  if (response.status === 403) throw new Error('API Key tidak punya permission Assets Write');
  if (response.status >= 400) throw new Error(`Roblox ${response.status}: ${response.data?.message || JSON.stringify(response.data)}`);

  const data = response.data;
  if (data.operationId) {
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      try {
        const op = await axios.get(`https://apis.roblox.com/assets/v1/operations/${data.operationId}`, {
          headers: { 'x-api-key': apiKey }, validateStatus: () => true
        });
        if (op.data?.done) {
          const id = op.data?.response?.assetId || op.data?.assetId;
          if (id) return id;
        }
      } catch(e) {}
    }
    return `pending:${data.operationId}`;
  }
  const assetId = data.assetId || data?.response?.assetId;
  if (assetId) return assetId;
  throw new Error('Tidak ada assetId: ' + JSON.stringify(data));
}

// ===== HELPERS =====
function resolveCreator(userId, groupId) {
  return groupId && groupId !== 'personal' && groupId !== ''
    ? { groupId: parseInt(groupId, 10) }
    : { userId: parseInt(userId, 10) };
}
function sanitizeName(name) {
  return (name || 'Audio').replace(/[^\w\s\-]/g, '').trim().slice(0, 50) || 'Audio';
}
function cleanup(...paths) {
  paths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`SoundForge server running on port ${PORT}`));
