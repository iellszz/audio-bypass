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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Process + Upload
app.post('/api/process-upload', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `processed_${Date.now()}.mp3`);
  try {
    const { apiKey, userId, name, description, speed, amplify } = req.body;
    if (!apiKey || !userId || !name) return res.status(400).json({ error: 'apiKey, userId, dan name wajib diisi' });
    if (!req.file) return res.status(400).json({ error: 'File audio tidak ditemukan' });

    const speedVal = Math.max(0.1, Math.min(10, parseFloat(speed) || 2.3));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(amplify) || -4));

    await processAudio(inputPath, outputPath, speedVal, amplifyVal);
    const assetId = await uploadToRoblox(outputPath, apiKey, userId, name, description || '');
    res.json({ success: true, assetId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

// Preview only
app.post('/api/preview', upload.single('audio'), async (req, res) => {
  const inputPath = req.file?.path;
  const outputPath = path.join(os.tmpdir(), `preview_${Date.now()}.mp3`);
  try {
    if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
    const speedVal = Math.max(0.1, Math.min(10, parseFloat(req.body.speed) || 2.3));
    const amplifyVal = Math.max(-30, Math.min(30, parseFloat(req.body.amplify) || -4));
    await processAudio(inputPath, outputPath, speedVal, amplifyVal);
    const audioData = fs.readFileSync(outputPath);
    res.json({ success: true, audio: audioData.toString('base64'), size: audioData.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

function processAudio(inputPath, outputPath, speed, amplifyDb) {
  return new Promise((resolve, reject) => {
    const atempoFilters = buildAtempoChain(speed);
    const volumeFilter = `volume=${amplifyDb}dB`;
    const filterChain = [...atempoFilters, volumeFilter].join(',');
    ffmpeg(inputPath)
      .audioFilters(filterChain)
      .audioBitrate('128k')
      .format('mp3')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

function buildAtempoChain(speed) {
  const filters = [];
  let rem = speed;
  if (rem > 2.0) {
    while (rem > 2.0) { filters.push('atempo=2.0'); rem /= 2.0; }
    if (rem > 0.5) filters.push(`atempo=${rem.toFixed(4)}`);
  } else if (rem < 0.5) {
    while (rem < 0.5) { filters.push('atempo=0.5'); rem /= 0.5; }
    if (rem < 2.0) filters.push(`atempo=${rem.toFixed(4)}`);
  } else {
    filters.push(`atempo=${rem.toFixed(4)}`);
  }
  return filters;
}

async function uploadToRoblox(filePath, apiKey, userId, name, description) {
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('request', JSON.stringify({
    displayName: name,
    description: description || '',
    assetType: 'Audio',
    creationContext: { creator: { userId: String(userId) } }
  }));
  form.append('fileContent', fileBuffer, { filename: `audio_${Date.now()}.mp3`, contentType: 'audio/mpeg' });

  const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: { 'x-api-key': apiKey, ...form.getHeaders() },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  const data = response.data;
  const assetId = data.assetId || data?.response?.assetId;
  if (assetId) return assetId;
  if (data.operationId) return `pending:${data.operationId}`;
  throw new Error(data.message || JSON.stringify(data));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
