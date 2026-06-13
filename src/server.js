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

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const uploadBulk = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ffmpeg: ffmpegInstaller.path,
    ffmpegExists: fs.existsSync(ffmpegInstaller.path),
    node: process.version
  });
});

// Get groups for a user
app.get('/api/groups', async (req, res) => {
  const { userId, apiKey } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId wajib' });
  try {
    const resp = await axios.get(
      `https://groups.roblox.com/v2/users/${userId}/groups/roles`,
      { validateStatus: () => true }
    );
    if (resp.status !== 200) throw new Error('Gagal fetch groups');
    // Filter groups where user has upload permission (role rank >= 200 or owner)
    const groups = (resp.data?.data || [])
      .filter(g => g.role?.rank >= 200 || g.group?.owner?.userId == userId)
      .map(g => ({
        id: g.group.id,
        name: g.group.name,
        role: g.role?.name
      }));
    res.json({ groups });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Single process + upload
app.post('/api/process-upload', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `processed_${Date.now()}.mp3`);
  try {
    const { apiKey, userId, groupId, name, description, speed, amplify } = req.body;
    console.log('=== UPLOAD REQUEST ===');
    console.log('name:', name, '| speed:', speed, '| amplify:', amplify, '| groupId:', groupId);

    if (!apiKey || !userId || !name) return res.status(400).json({ error: 'apiKey, userId, dan name wajib' });
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });

    const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 2.3));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || -4));
    const safeName = sanitizeName(name);

    await processAudio(inputPath, outputPath, speedVal, amplifyVal);

    const creator = groupId && groupId !== 'personal'
      ? { groupId: parseInt(groupId, 10) }
      : { userId: parseInt(userId, 10) };

    const assetId = await uploadToRoblox(outputPath, apiKey, creator, safeName, description || '');
    console.log('SUCCESS assetId:', assetId);
    res.json({ success: true, assetId, name: safeName });

  } catch (err) {
    console.error('UPLOAD FAILED:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    cleanup(inputPath, outputPath);
  }
});

// BULK process + upload
app.post('/api/bulk-upload', uploadBulk.array('audio', 50), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'Tidak ada file' });

  const { apiKey, userId, groupId, speed, amplify, namePrefix } = req.body;
  if (!apiKey || !userId) return res.status(400).json({ error: 'apiKey dan userId wajib' });

  const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 2.3));
  const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || -4));
  const creator = groupId && groupId !== 'personal'
    ? { groupId: parseInt(groupId, 10) }
    : { userId: parseInt(userId, 10) };

  // Use SSE to stream progress to client
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {}
  };

  send({ type: 'start', total: files.length });

  const results = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const outputPath = path.join(os.tmpdir(), `bulk_${Date.now()}_${i}.mp3`);
    const originalName = file.originalname.replace(/\.[^.]+$/, '');
    const safeName = sanitizeName((namePrefix ? namePrefix + ' ' : '') + originalName);

    send({ type: 'progress', index: i, total: files.length, name: originalName, status: 'processing' });

    try {
      await processAudio(file.path, outputPath, speedVal, amplifyVal);
      const assetId = await uploadToRoblox(outputPath, apiKey, creator, safeName, '');
      results.push({ name: safeName, assetId, status: 'success' });
      send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'success', assetId });
    } catch(e) {
      results.push({ name: safeName, status: 'error', error: e.message });
      send({ type: 'progress', index: i, total: files.length, name: safeName, status: 'error', error: e.message });
    } finally {
      cleanup(file.path, outputPath);
    }

    // Small delay between uploads to avoid rate limiting
    if (i < files.length - 1) await sleep(1500);
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
    const speedVal = Math.max(0.5, Math.min(10, parseFloat(req.body.speed) || 2.3));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(req.body.amplify) || -4));
    await processAudio(inputPath, outputPath, speedVal, amplifyVal);
    const audioData = fs.readFileSync(outputPath);
    res.json({ success: true, audio: audioData.toString('base64'), size: audioData.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    cleanup(inputPath, outputPath);
  }
});

// ===== REUPLOAD BY ASSET ID =====

// Fetch audio from Roblox by Asset ID
async function fetchRobloxAudio(assetId) {
  // Try multiple endpoints
  const urls = [
    `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`,
    `https://assetdelivery.roblox.com/v2/asset/?id=${assetId}`,
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Referer': 'https://www.roblox.com/',
  };

  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxRedirects: 10,
        validateStatus: () => true,
        headers
      });

      if (resp.status === 200 && resp.data.byteLength > 1000) {
        console.log(`Fetched asset ${assetId}: ${resp.data.byteLength} bytes from ${url}`);
        return Buffer.from(resp.data);
      }

      // Handle redirect via Location header
      if (resp.headers?.location) {
        const red = await axios.get(resp.headers.location, {
          responseType: 'arraybuffer',
          timeout: 20000,
          validateStatus: () => true,
          headers
        });
        if (red.status === 200 && red.data.byteLength > 1000) {
          return Buffer.from(red.data);
        }
      }
    } catch(e) {
      console.error(`Fetch attempt failed for ${url}:`, e.message);
    }
  }

  throw new Error(`Asset ${assetId} gagal di-fetch. Pastikan asset public dan ID benar.`);
}

// Get audio duration using ffprobe
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) reject(err);
      else resolve(meta?.format?.duration || 0);
    });
  });
}

// Single reupload by ID
app.post('/api/reupload', express.json(), async (req, res) => {
  const tmpPath = path.join(os.tmpdir(), `fetch_${Date.now()}.mp3`);
  const outPath = path.join(os.tmpdir(), `reup_${Date.now()}.mp3`);
  try {
    const { apiKey, userId, groupId, assetId, name, manualSpeed } = req.body;
    if (!apiKey || !userId || !assetId) return res.status(400).json({ error: 'apiKey, userId, assetId wajib' });

    console.log(`Reupload: assetId=${assetId} name=${name} manualSpeed=${manualSpeed}`);

    // Fetch from Roblox
    const audioBuffer = await fetchRobloxAudio(assetId);
    fs.writeFileSync(tmpPath, audioBuffer);

    // Get duration of fetched (bypassed) audio
    const bypassedDuration = await getAudioDuration(tmpPath);
    console.log(`Bypassed duration: ${bypassedDuration}s`);

    let detectedSpeed = null;
    let playbackSpeed = 1;

    if (manualSpeed && parseFloat(manualSpeed) > 0) {
      // Manual: user knows the bypass speed
      detectedSpeed = parseFloat(manualSpeed);
      playbackSpeed = Math.round((1 / detectedSpeed) * 100000) / 100000;
    } else {
      // Auto detect: estimate from duration
      // Roblox normal song durations are typically 1-5 minutes
      // We compare to common durations to estimate speed
      // heuristic: assume original was between 2-5 min (120-300s)
      const estimatedOriginalDuration = bypassedDuration;
      // We can't know original without reference, so we measure what we have
      // and return duration info for user to cross-check
      detectedSpeed = null;
      playbackSpeed = 1; // will be set by user after seeing info
    }

    // Upload directly (no re-bypass)
    const safeName = sanitizeName(name || `Audio_${assetId}`);
    const creator = groupId && groupId !== 'personal'
      ? { groupId: parseInt(groupId, 10) }
      : { userId: parseInt(userId, 10) };

    // Copy tmpPath to outPath (no processing needed)
    fs.copyFileSync(tmpPath, outPath);
    const newAssetId = await uploadToRoblox(outPath, apiKey, creator, safeName, '');

    res.json({
      success: true,
      assetId: newAssetId,
      name: safeName,
      bypassedDuration: bypassedDuration.toFixed(2),
      detectedSpeed,
      playbackSpeed,
      originalAssetId: assetId
    });

  } catch(e) {
    console.error('Reupload error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    cleanup(tmpPath, outPath);
  }
});

// Bulk reupload by IDs (SSE)
app.post('/api/bulk-reupload', express.json(), async (req, res) => {
  const { apiKey, userId, groupId, items, manualSpeed } = req.body;
  // items = [{assetId, name}, ...]
  if (!apiKey || !userId || !items?.length) {
    return res.status(400).json({ error: 'apiKey, userId, items wajib' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };
  send({ type: 'start', total: items.length });

  const creator = groupId && groupId !== 'personal'
    ? { groupId: parseInt(groupId, 10) }
    : { userId: parseInt(userId, 10) };

  const results = [];

  for (let i = 0; i < items.length; i++) {
    const { assetId, name } = items[i];
    const tmpPath = path.join(os.tmpdir(), `rfetch_${Date.now()}_${i}.mp3`);
    const outPath = path.join(os.tmpdir(), `rout_${Date.now()}_${i}.mp3`);

    send({ type: 'progress', index: i, total: items.length, name: name||assetId, status: 'fetching' });

    // Per-item timeout: 45 seconds max
    const itemTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 45s — asset lambat di-fetch')), 45000));

    try {
      await Promise.race([
        (async () => {
          const audioBuffer = await fetchRobloxAudio(assetId);
          fs.writeFileSync(tmpPath, audioBuffer);

          const bypassedDuration = await getAudioDuration(tmpPath);
          const spd = manualSpeed ? parseFloat(manualSpeed) : null;
          const playbackSpeed = spd ? Math.round((1/spd)*100000)/100000 : 1;

          send({ type: 'progress', index: i, total: items.length, name: name||assetId, status: 'uploading' });

          const safeName = sanitizeName(name || `Audio_${assetId}`);
          fs.copyFileSync(tmpPath, outPath);
          const newAssetId = await uploadToRoblox(outPath, apiKey, creator, safeName, '');

          results.push({ name: safeName, assetId: newAssetId, originalAssetId: assetId, playbackSpeed, bypassedDuration: bypassedDuration.toFixed(2), status: 'success' });
          send({ type: 'progress', index: i, total: items.length, name: safeName, status: 'success', assetId: newAssetId, playbackSpeed });
        })(),
        itemTimeout
      ]);
    } catch(e) {
      results.push({ name: name||assetId, originalAssetId: assetId, status: 'error', error: e.message });
      send({ type: 'progress', index: i, total: items.length, name: name||assetId, status: 'error', error: e.message });
    } finally {
      cleanup(tmpPath, outPath);
    }

    if (i < items.length - 1) await sleep(1000);
  }

  send({ type: 'done', results });
  res.end();
});


function sanitizeName(name) {
  return (name || 'Audio').replace(/[^\w\s\-]/g, '').trim().slice(0, 50) || 'Audio';
}

function processAudio(inputPath, outputPath, speed, amplifyDb) {
  return new Promise((resolve, reject) => {
    const filters = [...buildAtempoChain(speed), `volume=${amplifyDb}dB`];
    ffmpeg(inputPath)
      .audioFilters(filters)
      .audioBitrate('128k')
      .audioChannels(2)
      .audioFrequency(44100)
      .toFormat('mp3')
      .on('end', resolve)
      .on('error', (err, stdout, stderr) => {
        reject(new Error('ffmpeg: ' + err.message));
      })
      .save(outputPath);
  });
}

function buildAtempoChain(speed) {
  // Direct upload (speed=1), skip processing
  if (Math.abs(speed - 1.0) < 0.01) return ['atempo=1.0'];

  // aresample before+after reduces robot/artifact voice at high speeds
  const filters = ['aresample=44100'];
  let rem = speed;
  while (rem > 2.0) { filters.push('atempo=2.0'); rem /= 2.0; }
  while (rem < 0.5) { filters.push('atempo=0.5'); rem *= 2.0; }
  if (Math.abs(rem - 1.0) > 0.001) filters.push(`atempo=${rem.toFixed(6)}`);
  filters.push('aresample=44100');
  return filters;
}

async function uploadToRoblox(filePath, apiKey, creator, name, description) {
  const fileBuffer = fs.readFileSync(filePath);
  if (fileBuffer.length > 19.5 * 1024 * 1024) {
    throw new Error(`File terlalu besar (${(fileBuffer.length/1024/1024).toFixed(1)}MB). Batas 20MB.`);
  }

  const requestMeta = JSON.stringify({
    displayName: name,
    description: description || '',
    assetType: 'Audio',
    creationContext: { creator }
  });

  console.log('Uploading:', name, '| creator:', JSON.stringify(creator));

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
    for (let i = 0; i < 15; i++) {
      await sleep(3000);
      try {
        const opRes = await axios.get(
          `https://apis.roblox.com/assets/v1/operations/${data.operationId}`,
          { headers: { 'x-api-key': apiKey }, validateStatus: () => true }
        );
        if (opRes.data?.done) {
          const id = opRes.data?.response?.assetId || opRes.data?.assetId;
          if (id) return id;
        }
      } catch(e) {}
    }
    return `pending:${data.operationId}`;
  }

  const assetId = data.assetId || data?.response?.assetId;
  if (assetId) return assetId;
  throw new Error('Tidak ada assetId di response: ' + JSON.stringify(data));
}

// Fetch audio duration using ffprobe
function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(null); return; }
      resolve(metadata?.format?.duration || null);
    });
  });
}

// Fetch asset from Roblox by ID
async function fetchAssetById(assetId) {
  const url = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    validateStatus: () => true,
    headers: { 'User-Agent': 'Roblox/WinInet' }
  });
  if (response.status !== 200) throw new Error(`Asset ID ${assetId} tidak ditemukan atau tidak public (status ${response.status})`);
  return Buffer.from(response.data);
}

// Single reupload by ID
app.post('/api/reupload-id', express.json(), async (req, res) => {
  const tmpInput = path.join(os.tmpdir(), `rid_in_${Date.now()}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `rid_out_${Date.now()}.mp3`);
  try {
    const { apiKey, userId, groupId, assetId, name, bypassSpeed } = req.body;
    if (!apiKey || !userId || !assetId) return res.status(400).json({ error: 'apiKey, userId, assetId wajib' });

    console.log('Reupload ID:', assetId, '| bypassSpeed:', bypassSpeed);

    // Fetch audio
    const audioBuffer = await fetchAssetById(assetId);
    fs.writeFileSync(tmpInput, audioBuffer);

    // Get duration of fetched (bypassed) audio
    const bypassedDuration = await getAudioDuration(tmpInput);
    console.log('Bypassed duration:', bypassedDuration);

    // Detect or use manual bypass speed
    let detectedSpeed = parseFloat(bypassSpeed) || null;
    let detectionMethod = 'manual';

    if (!detectedSpeed && bypassedDuration) {
      // We can't know original duration without reference, default to 2.3
      detectedSpeed = 2.3;
      detectionMethod = 'default';
    }
    if (!detectedSpeed) detectedSpeed = 2.3;

    const playbackSpeed = Math.round((1 / detectedSpeed) * 100000) / 100000;
    const safeName = sanitizeName(name || `Audio_${assetId}`);
    const creator = groupId && groupId !== 'personal'
      ? { groupId: parseInt(groupId, 10) }
      : { userId: parseInt(userId, 10) };

    // Upload as-is (no bypass processing)
    const newAssetId = await uploadToRoblox(tmpInput, apiKey, creator, safeName, '');
    console.log('Reupload success:', newAssetId);

    res.json({
      success: true,
      originalId: assetId,
      newAssetId,
      name: safeName,
      bypassSpeed: detectedSpeed,
      playbackSpeed,
      bypassedDuration,
      detectionMethod
    });
  } catch(e) {
    console.error('Reupload ID error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    cleanup(tmpInput, tmpOut);
  }
});

// Bulk reupload by ID (SSE streaming)
app.post('/api/bulk-reupload-id', express.json(), async (req, res) => {
  const { apiKey, userId, groupId, items } = req.body;
  // items: [{assetId, name, bypassSpeed}]
  if (!apiKey || !userId || !items?.length) {
    return res.status(400).json({ error: 'apiKey, userId, items wajib' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };
  send({ type: 'start', total: items.length });

  const creator = groupId && groupId !== 'personal'
    ? { groupId: parseInt(groupId, 10) }
    : { userId: parseInt(userId, 10) };

  const results = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tmpInput = path.join(os.tmpdir(), `brid_${Date.now()}_${i}.mp3`);
    send({ type: 'progress', index: i, total: items.length, name: item.name || item.assetId, status: 'processing' });

    try {
      const audioBuffer = await fetchAssetById(item.assetId);
      fs.writeFileSync(tmpInput, audioBuffer);

      // Get duration for auto-detect
      const bypassedDuration = await getAudioDuration(tmpInput);
      const detectedSpeed = parseFloat(item.bypassSpeed) || 2.3;
      const playbackSpeed = Math.round((1 / detectedSpeed) * 100000) / 100000;
      const safeName = sanitizeName(item.name || `Audio_${item.assetId}`);

      const newAssetId = await uploadToRoblox(tmpInput, apiKey, creator, safeName, '');

      const result = {
        status: 'success',
        originalId: item.assetId,
        newAssetId,
        name: safeName,
        bypassSpeed: detectedSpeed,
        playbackSpeed,
        bypassedDuration
      };
      results.push(result);
      send({ type: 'progress', index: i, total: items.length, name: safeName, status: 'success', ...result });
    } catch(e) {
      results.push({ status: 'error', originalId: item.assetId, name: item.name || item.assetId, error: e.message });
      send({ type: 'progress', index: i, total: items.length, name: item.name || item.assetId, status: 'error', error: e.message });
    } finally {
      cleanup(tmpInput);
    }

    if (i < items.length - 1) await sleep(1500);
  }

  send({ type: 'done', results });
  res.end();
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
