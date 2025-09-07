import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.warn('Warning: GEMINI_API_KEY not set. Set it in .env for API calls to work.');
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// Serve static files from client
app.use(express.static(path.join(__dirname, '..', 'web')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// Proxy to Gemini for image generation/extension
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, imageParts, mimeType = 'image/png', model = 'gemini-2.5-flash-image-preview' } = req.body || {};
    console.log(`[generate] model=${model}, promptLen=${prompt?.length || 0}, parts=${imageParts?.length || 0}`);

    if (!API_KEY) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });

    const contents = [
      {
        parts: [
          ...(imageParts && imageParts.length
            ? imageParts.map((b64) => ({ inlineData: { data: b64, mimeType: mimeType } }))
            : []),
          ...(prompt ? [{ text: prompt }] : [])
        ]
      }
    ];

    async function callOnce(body) {
      return ai.models.generateContent(body);
    }

    let response = await callOnce({
      model,
      contents,
      generationConfig: {
        temperature: 0.01,
        candidateCount: 1,
      }
    });

    const candidate = response.candidates?.[0];
    if (!candidate) {
      return res.status(500).json({ error: 'No candidates in response' });
    }

    const parts = candidate.content?.parts || [];
    const inputSet = new Set((imageParts || []).filter(Boolean));
    // Prefer the last inlineData that is not exactly one of the inputs
    let inlinePart = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      const d = p?.inlineData?.data;
      if (d && !inputSet.has(d)) { inlinePart = p; break; }
    }
    if (!inlinePart) {
      // Fallback: pick the last inlineData if none differ from inputs
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p?.inlineData?.data) { inlinePart = p; break; }
      }
    }
    if (!inlinePart) {
      const textPart = parts.find(p => p.text);
      if (textPart) {
        // Retry once with stronger instruction to return image
        const retryContents = [
          {
            parts: [
              ...((imageParts || []).map((b64) => ({ inlineData: { data: b64, mimeType } }))),
              { text: 'Return only an image (PNG). Do not include any text in the response. ' + (prompt || '') }
            ]
          }
        ];
        const retry = await callOnce({ model, contents: retryContents, generationConfig: { temperature: 0.01, candidateCount: 1 } });
        const rCand = retry.candidates?.[0];
        const rParts = rCand?.content?.parts || [];
        const inputSet2 = new Set((imageParts || []).filter(Boolean));
        let rInline = null;
        for (let i = rParts.length - 1; i >= 0; i--) {
          const p = rParts[i];
          const d = p?.inlineData?.data;
          if (d && !inputSet2.has(d)) { rInline = p; break; }
        }
        if (!rInline) {
          for (let i = rParts.length - 1; i >= 0; i--) {
            const p = rParts[i];
            if (p?.inlineData?.data) { rInline = p; break; }
          }
        }
        if (!rInline) {
          return res.status(400).json({ error: 'Model returned text instead of image', text: textPart.text });
        }
        return res.json({ imageData: rInline.inlineData.data, retry: true });
      }
      return res.status(500).json({ error: 'No image or text in response' });
    }

    res.json({ imageData: inlinePart.inlineData.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error', details: err.message });
  }
});

const PORT = process.env.PORT || 5174;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
