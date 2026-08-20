/**
 * Cloudflare Worker for YouTube AI Translator - Subtitle Cloud Cache
 * 
 * Features:
 *  - Stores 100% translated subtitles in Cloudflare KV
 *  - High-speed global edge retrieval (<50ms)
 *  - Free tier friendly (100k requests/day, 1GB storage, 1k writes/day)
 *  - CORS enabled for Chrome Extension
 * 
 * KV Namespace binding name required: `SUBTITLES_KV`
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Client-Version',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({ status: 'ok', service: 'YouTube AI Translator Cloud Cache', timestamp: new Date().toISOString() }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // GET /subs?videoId=XYZ&lang=fa
    if (request.method === 'GET' && url.pathname === '/subs') {
      const videoId = url.searchParams.get('videoId');
      const lang = url.searchParams.get('lang') || 'fa';

      if (!videoId || videoId.length > 32) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Invalid or missing videoId parameter' }),
          { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const key = `sub:${videoId}:${lang}`;

      try {
        if (!env.SUBTITLES_KV) {
          return new Response(
            JSON.stringify({ ok: false, error: 'SUBTITLES_KV namespace not bound in Worker settings' }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        const data = await env.SUBTITLES_KV.get(key, { type: 'json' });

        if (!data) {
          return new Response(
            JSON.stringify({ ok: false, found: false, message: 'Subtitles not in cloud cache' }),
            { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Standardize models array (support legacy single-cue records)
        let models = [];
        if (Array.isArray(data.models) && data.models.length > 0) {
          models = data.models;
        } else if (Array.isArray(data.cues) && data.cues.length > 0) {
          models = [{
            provider: 'unknown',
            modelId: 'legacy',
            modelName: 'ترجمه ابری',
            createdAt: data.createdAt || new Date().toISOString(),
            cues: data.cues
          }];
        }

        if (models.length === 0) {
          return new Response(
            JSON.stringify({ ok: false, found: false, message: 'No valid subtitle models in cache' }),
            { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Auto-select best model (prefer AI models over google_free)
        let bestIndex = models.findIndex(m => m.provider !== 'google_free');
        if (bestIndex === -1) bestIndex = 0;

        return new Response(
          JSON.stringify({
            ok: true,
            found: true,
            videoId,
            lang,
            title: data.title || '',
            models,
            bestIndex,
            activeModel: models[bestIndex],
            cues: models[bestIndex].cues,
            stats: { modelCount: models.length }
          }),
          {
            status: 200,
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            }
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: 'KV Read error: ' + err.message }),
          { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // POST /subs
    if (request.method === 'POST' && url.pathname === '/subs') {
      try {
        if (!env.SUBTITLES_KV) {
          return new Response(
            JSON.stringify({ ok: false, error: 'SUBTITLES_KV namespace not bound' }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        const body = await request.json();
        const {
          videoId,
          lang = 'fa',
          cues,
          title = '',
          provider = 'google_free',
          modelId = 'google_free',
          modelName = 'Google Translate'
        } = body;

        if (!videoId || !Array.isArray(cues) || cues.length === 0) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Invalid payload: videoId and cues array are required' }),
            { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Validate that subtitles are genuinely translated (at least 80% have Persian text)
        const translatedCount = cues.filter(c => c.fa && c.fa.trim().length > 0).length;
        const completionRate = translatedCount / cues.length;

        if (completionRate < 0.8) {
          return new Response(
            JSON.stringify({ ok: false, error: 'Subtitles are incomplete (< 80% translated)' }),
            { status: 422, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Sanitize cues to save KV storage space
        const compactCues = cues.map(c => ({
          start: Math.round(c.start * 100) / 100,
          end: Math.round(c.end * 100) / 100,
          text: c.text,
          fa: c.fa,
          phrases: Array.isArray(c.phrases) ? c.phrases : [],
        }));

        const key = `sub:${videoId}:${lang}`;

        // Fetch existing record
        const existing = (await env.SUBTITLES_KV.get(key, { type: 'json' })) || {};
        let models = [];
        if (Array.isArray(existing.models)) {
          models = existing.models;
        } else if (Array.isArray(existing.cues)) {
          models = [{
            provider: 'unknown',
            modelId: 'legacy',
            modelName: 'ترجمه ابری',
            createdAt: existing.createdAt || new Date().toISOString(),
            cues: existing.cues
          }];
        }

        // Rule 1: Deduplication for Google Translate
        if (provider === 'google_free' && models.some(m => m.provider === 'google_free' || m.modelId === 'google_free')) {
          return new Response(
            JSON.stringify({
              ok: true,
              message: 'Google Translate subtitles already cached for this video',
              videoId,
              modelCount: models.length
            }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
          );
        }

        // Rule 2: Check if exact same modelId already exists
        const existingModelIdx = models.findIndex(m => m.modelId === modelId);
        if (existingModelIdx !== -1) {
          // Update existing model cues
          models[existingModelIdx].cues = compactCues;
          models[existingModelIdx].createdAt = new Date().toISOString();
        } else {
          // Rule 3: Max 3 distinct models per video (do not add if already 3)
          if (models.length >= 3) {
            return new Response(
              JSON.stringify({
                ok: true,
                message: 'Max limit of 3 cached models reached for this video',
                videoId,
                modelCount: models.length
              }),
              { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
          }

          // Add new model
          models.push({
            provider,
            modelId,
            modelName,
            createdAt: new Date().toISOString(),
            cues: compactCues,
          });
        }

        const record = {
          videoId,
          lang,
          title: String(title || existing.title || '').slice(0, 200),
          updatedAt: new Date().toISOString(),
          models,
        };

        // Save to KV (TTL: 90 days = 7776000 seconds)
        await env.SUBTITLES_KV.put(key, JSON.stringify(record), {
          expirationTtl: 7776000,
        });

        return new Response(
          JSON.stringify({
            ok: true,
            message: `Model "${modelName}" cached successfully`,
            videoId,
            modelName,
            modelCount: models.length,
          }),
          { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: 'KV Write error: ' + err.message }),
          { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({ ok: false, error: 'Not found' }),
      { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  },
};
