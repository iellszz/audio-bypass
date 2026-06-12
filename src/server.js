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

// Debug endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ffmpeg: ffmpegInstaller.path,
    ffmpegExists: fs.existsSync(ffmpegInstaller.path),
    tmpdir: os.tmpdir(),
    platform: process.platform,
    node: process.version
  });
});

// Test API key endpoint
app.post('/api/test-key', express.json(), async (req, res) => {
  const { apiKey, userId } = req.body;
  if (!apiKey || !userId) return res.status(400).json({ error: 'apiKey dan userId wajib' });
  try {
    // Test with a simple GET to Roblox API
    const resp = await axios.get(`https://apis.roblox.com/assets/v1/assets`, {
      headers: { 'x-api-key': apiKey },
      validateStatus: () => true
    });
    res.json({ status: resp.status, data: resp.data });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Process + Upload
app.post('/api/process-upload', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `processed_${Date.now()}.mp3`);

  try {
    const { apiKey, userId, name, description, speed, amplify } = req.body;
    console.log('=== NEW UPLOAD REQUEST ===');
    console.log('name:', name, '| speed:', speed, '| amplify:', amplify);
    console.log('userId:', userId, '| apiKey length:', apiKey?.length);
    console.log('file:', req.file?.originalname, '| size:', req.file?.size, 'bytes | mimetype:', req.file?.mimetype);

    if (!apiKey || !userId || !name) return res.status(400).json({ error: 'apiKey, userId, dan name wajib diisi' });
    if (!req.file) return res.status(400).json({ error: 'File audio tidak ditemukan' });

    const speedVal = Math.max(0.5, Math.min(10, parseFloat(speed) || 2.3));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || -4));
    const safeName = (name || 'Audio').replace(/[^\w\s\-]/g, '').trim().slice(0, 50) || 'Audio';

    console.log('Processing audio: speed=', speedVal, 'amplify=', amplifyVal);

    // Check ffmpeg
    if (!fs.existsSync(ffmpegInstaller.path)) {
      throw new Error('ffmpeg tidak ditemukan di: ' + ffmpegInstaller.path);
    }

    await processAudio(inputPath, outputPath, speedVal, amplifyVal);

    if (!fs.existsSync(outputPath)) throw new Error('Output file tidak terbuat setelah ffmpeg');
    const outSize = fs.statSync(outputPath).size;
    console.log('Processed size:', (outSize/1024/1024).toFixed(2), 'MB');

    if (outSize > 19.5 * 1024 * 1024) {
      throw new Error(`File hasil proses terlalu besar: ${(outSize/1024/1024).toFixed(1)}MB. Batas Roblox 20MB.`);
    }

    const assetId = await uploadToRoblox(outputPath, apiKey, String(userId).trim(), safeName, description || '');
    console.log('=== SUCCESS assetId:', assetId, '===');
    res.json({ success: true, assetId });

  } catch (err) {
    const msg = err.message || 'Unknown error';
    console.error('=== UPLOAD FAILED:', msg, '===');
    res.status(500).json({ error: msg });
  } finally {
    try { if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch(e) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(e) {}
  }
});

// Preview
app.post('/api/preview', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `preview_${Date.now()}.mp3`);
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const speedVal = Math.max(0.5, Math.min(10, parseFloat(req.body.speed) || 2.3));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(req.body.amplify) || -4));
    console.log('Preview: speed=', speedVal, 'amplify=', amplifyVal);
    await processAudio(inputPath, outputPath, speedVal, amplifyVal);
    const audioData = fs.readFileSync(outputPath);
    res.json({ success: true, audio: audioData.toString('base64'), size: audioData.length });
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch(e) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(e) {}
  }
});

function processAudio(inputPath, outputPath, speed, amplifyDb) {
  return new Promise((resolve, reject) => {
    const atempoFilters = buildAtempoChain(speed);
    const volumeFilter = `volume=${amplifyDb}dB`;
    const allFilters = [...atempoFilters, volumeFilter];
    console.log('ffmpeg filters:', allFilters.join(','));

    ffmpeg(inputPath)
      .audioFilters(allFilters)
      .audioBitrate('128k')
      .audioChannels(2)
      .audioFrequency(44100)
      .toFormat('mp3')
      .on('start', cmd => console.log('ffmpeg cmd:', cmd))
      .on('end', () => { console.log('ffmpeg done'); resolve(); })
      .on('error', (err, stdout, stderr) => {
        console.error('ffmpeg error:', err.message);
        console.error('ffmpeg stderr:', stderr);
        reject(new Error('ffmpeg error: ' + err.message));
      })
      .save(outputPath);
  });
}

function buildAtempoChain(speed) {
  // atempo range: 0.5 to 2.0 per filter, chain for outside range
  const filters = [];
  let rem = speed;
  while (rem > 2.0) { filters.push('atempo=2.0'); rem /= 2.0; }
  while (rem < 0.5) { filters.push('atempo=0.5'); rem *= 2.0; }
  if (Math.abs(rem - 1.0) > 0.001) filters.push(`atempo=${rem.toFixed(6)}`);
  if (filters.length === 0) filters.push('atempo=1.0');
  return filters;
}

async function uploadToRoblox(filePath, apiKey, userId, name, description) {
  const fileBuffer = fs.readFileSync(filePath);

  const requestMeta = JSON.stringify({
    displayName: name,
    description: description || '',
    assetType: 'Audio',
    creationContext: {
      creator: { userId: parseInt(userId, 10) }
    }
  });

  console.log('Sending to Roblox, meta:', requestMeta);

  const form = new FormData();
  form.append('request', requestMeta, { contentType: 'application/json' });
  form.append('fileContent', fileBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });

  let response;
  try {
    response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
      headers: { 'x-api-key': apiKey, ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
      validateStatus: () => true // don't throw on 4xx/5xx
    });
  } catch (e) {
    throw new Error('Network error ke Roblox: ' + e.message);
  }

  console.log('Roblox status:', response.status);
  console.log('Roblox response:', JSON.stringify(response.data));

  if (response.status === 400) {
    const d = response.data;
    const msg = d?.message || d?.errors?.[0]?.message || JSON.stringify(d);
    throw new Error('Roblox 400: ' + msg);
  }
  if (response.status === 401) throw new Error('API Key tidak valid atau sudah expired. Buat API Key baru.');
  if (response.status === 403) throw new Error('API Key tidak punya permission Assets Write. Cek di create.roblox.com/credentials');
  if (response.status >= 400) throw new Error(`Roblox error ${response.status}: ${JSON.stringify(response.data)}`);

  const data = response.data;

  // Poll if operationId
  if (data.operationId) {
    console.log('Got operationId, polling:', data.operationId);
    for (let i = 0; i < 15; i++) {
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
  throw new Error('Roblox response tidak ada assetId: ' + JSON.stringify(data));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
