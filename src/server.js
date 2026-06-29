
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegInstaller.path, node: process.version });
});

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
    const { apiKey, userId, groupId, name, description, speed, amplify, pitch } = req.body;
    if (!apiKey || !userId || !name) return res.status(400).json({ error: 'apiKey, userId, name wajib' });
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 1));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || 0));
    const pitchVal = Math.max(-12, Math.min(12, parseFloat(pitch) || 0));
    const safeName = sanitizeName(name);
    const creator = resolveCreator(userId, groupId);
    await processAudio(inputPath, outputPath, speedVal, amplifyVal, pitchVal);
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
  const { apiKey, userId, groupId, speed, amplify, pitch, namePrefix } = req.body;
  if (!apiKey || !userId) return res.status(400).json({ error: 'apiKey dan userId wajib' });
  const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 1));
  const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || 0));
  const pitchVal = Math.max(-12, Math.min(12, parseFloat(pitch) || 0));
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
      await processAudio(file.path, outputPath, speedVal, amplifyVal, pitchVal);
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
    const pitchVal = Math.max(-12, Math.min(12, parseFloat(req.body.pitch) || 0));
    await processAudio(inputPath, outputPath, speedVal, amplifyVal, pitchVal);
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
      body = { requests: [{ subject: { allUsers: {} }, action: 'USE' }] };
    } else if (target.type === 'group') {
      body = { requests: [{ subject: { group: { id: String(target.id) } }, action: 'USE' }] };
    } else if (target.type === 'user') {
      body = { requests: target.ids.map(id => ({ subject: { user: { id: String(id) } }, action: 'USE' })) };
    } else if (target.type === 'experience') {
      body = { requests: target.ids.map(id => ({ subject: { experience: { universeId: String(id) } }, action: 'USE' })) };
    }

    const response = await axios.post(
      `https://apis.roblox.com/assets/v1/assets/${assetId}/permissions`,
      body,
      { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: 15000 }
    );

    console.log(`Permission ${assetId} -> ${response.status}:`, JSON.stringify(response.data));
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

// NOTE: Model (.rbxm/.rbxmx) upload intentionally NOT implemented —
// Roblox Open Cloud API returns "Creating Model from application/octet-stream
// is not supported yet" — this is a hard limitation on Roblox's side.

// ===== AUDIO PROCESSING =====
function processAudio(inputPath, outputPath, speed, amplifyDb, pitchSemitones) {
  return new Promise((resolve, reject) => {
    const isDirect = Math.abs(speed - 1.0) < 0.001 && Math.abs(amplifyDb) < 0.001 && Math.abs(pitchSemitones || 0) < 0.01;

    let cmd = ffmpeg(inputPath).audioChannels(2).audioFrequency(44100).audioQuality(2);

    if (isDirect) {
      cmd = cmd.toFormat('ogg');
    } else {
      const pitch = parseFloat(pitchSemitones) || 0;
      const pitchScale = Math.pow(2, pitch / 12);
      const filters = [];
      // rubberband tuned for vocal clarity: formant preserved, soft detector, smooth transients
      filters.push(`rubberband=tempo=${speed.toFixed(6)}:pitch=${pitchScale.toFixed(6)}:transients=smooth:detector=soft:phase=laminar:window=long:smoothing=on:formant=preserved:pitchq=quality`);
      if (Math.abs(amplifyDb) > 0.01) filters.push(`volume=${amplifyDb}dB`);
      console.log(`rubberband: speed=${speed} pitch=${pitch}st scale=${pitchScale.toFixed(4)} amp=${amplifyDb}dB`);
      cmd = cmd.audioFilters(filters).toFormat('ogg');
    }

    cmd
      .on('start', c => console.log('ffmpeg:', c))
      .on('end', resolve)
      .on('error', (err, _, stderr) => {
        console.error('rubberband failed:', err.message, stderr);
        console.log('Falling back to asetrate...');
        processAsetrate(inputPath, outputPath, speed, amplifyDb, pitchSemitones).then(resolve).catch(reject);
      })
      .save(outputPath);
  });
}

function processAsetrate(inputPath, outputPath, speed, amplifyDb, pitchSemitones) {
  return new Promise((resolve, reject) => {
    const pitch = parseFloat(pitchSemitones) || 0;
    const pitchFactor = Math.pow(2, pitch / 12);
    const targetRate = Math.round(44100 * speed * pitchFactor);
    const filters = [`asetrate=${targetRate}`, 'aresample=44100'];
    if (Math.abs(amplifyDb) > 0.01) filters.push(`volume=${amplifyDb}dB`);
    console.log('asetrate fallback targetRate=', targetRate);
    ffmpeg(inputPath).audioChannels(2).audioFrequency(44100).audioQuality(2)
      .audioFilters(filters).toFormat('ogg')
      .on('end', resolve).on('error', reject).save(outputPath);
  });
}

async function uploadToRoblox(filePath, apiKey, creator, name, description) {
  const fileBuffer = fs.readFileSync(filePath);
  if (fileBuffer.length > 19.5 * 1024 * 1024) throw new Error(`File terlalu besar (${(fileBuffer.length/1024/1024).toFixed(1)}MB). Batas 20MB.`);

  const form = new FormData();
  form.append('request', JSON.stringify({
    displayName: name, description: description || '', assetType: 'Audio', creationContext: { creator }
  }), { contentType: 'application/json' });
  form.append('fileContent', fileBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });

  const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: { 'x-api-key': apiKey, ...form.getHeaders() },
    maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 120000, validateStatus: () => true
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
        const op = await axios.get(`https://apis.roblox.com/assets/v1/operations/${data.operationId}`, { headers: { 'x-api-key': apiKey }, validateStatus: () => true });
        if (op.data?.done) { const id = op.data?.response?.assetId || op.data?.assetId; if (id) return id; }
      } catch(e) {}
    }
    return `pending:${data.operationId}`;
  }
  const assetId = data.assetId || data?.response?.assetId;
  if (assetId) return assetId;
  throw new Error('Tidak ada assetId: ' + JSON.stringify(data));
}

function resolveCreator(userId, groupId) {
  return groupId && groupId !== 'personal' && groupId !== '' ? { groupId: parseInt(groupId, 10) } : { userId: parseInt(userId, 10) };
}
function sanitizeName(name) { return (name || 'Audio').replace(/[^\w\s\-]/g, '').trim().slice(0, 50) || 'Audio'; }
function cleanup(...paths) { paths.forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`SoundForge running on port ${PORT}`));
