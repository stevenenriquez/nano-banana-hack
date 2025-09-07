# Gemini Nano Banana Tiles

Generate a grid of "nano banana" tiles using Gemini. Click an adjacent cell to extend the selected tile and grow the scene.

## Quickstart

1. Duplicate `.env.example` to `.env` and set GEMINI_API_KEY.
2. Install deps.
3. Start the dev server.

```sh
cp .env.example .env
# edit .env and add GEMINI_API_KEY
npm install
npm run dev
```

Open http://localhost:5174 in your browser. (You can set PORT in .env if needed.)

## How it works

- A tiny Express server proxies requests to Gemini (`/api/generate`).
- The front-end shows a 7x7 grid. Seed the center tile, then click an empty adjacent cell to extend the scene.
- We send the source tile image as inline_data and ask the model to generate a seamless extension in the chosen direction.

## Notes

- Model: `gemini-2.0-flash`. If image generation requires a vision-capable model variant, adjust `model` in `web/main.js` and `server/server.js`.
- This is a minimal demo. Real tiling often benefits from masks and overlap context. You could enhance by sending an additional cropped strip as context, or by using controllable generation features if available.
- Keep your API key only in `.env`. The browser never sees it.

## Troubleshooting

- 400 INVALID_ARGUMENT with response_mime_type
  - We no longer send response_mime_type to avoid this error. If you still get 400s, switch to a model that supports multimodal/image outputs, or inspect the server logs for the returned detail.
- No image in response
  - The chosen model may not support image generation. Try switching to `imagen-3.0` or another image generation model available to your account.

## Updates for Nano Banana Model

Switched to using the official `@google/genai` SDK for the `gemini-2.5-flash-image-preview` model, which supports native image generation. This replaces the REST API approach.

- Installed `@google/genai` package.
- Updated server to use `GoogleGenAI` for generating content.
- Client now expects `{ imageData: base64 }` from the server.
- Default model is `gemini-2.5-flash-image-preview`.

If you encounter issues, ensure your API key has access to this model.
