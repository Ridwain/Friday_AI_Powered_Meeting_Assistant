// enhanced-ai-helper.js
// NOTE: Consider moving GEMINI_KEY server-side and proxying calls to avoid exposing keys in the extension.
const GEMINI_KEY = typeof window !== 'undefined' && window.GEMINI_KEY
  ? window.GEMINI_KEY
  : '';

const CANDIDATE_MODELS = [
  // Prefer fast & broadly available first
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-1.5-flash',

];

function toGeminiContents(messages) {
  const contents = [];
  let systemText = '';

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Prefer using systemInstruction when available; collect and send below.
      systemText += (systemText ? '\n\n' : '') + String(msg.content || '');
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({
      role,
      parts: [{ text: String(msg.content || '') }]
    });
  }

  return { contents, systemText };
}

async function tryGenerateContent({ model, body, version }) {
  const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Gemini ${version} ${model} failed: ${resp.status} ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function callGeminiWithFallback(promptBody) {
  // We try v1beta, then v1, across candidate models.
  const versions = ['v1beta', 'v1'];
  let lastErr;

  for (const model of CANDIDATE_MODELS) {
    for (const version of versions) {
      try {
        const json = await tryGenerateContent({ model, body: promptBody, version });
        return { json, model, version };
      } catch (e) {
        // 404 → model not found for this endpoint/key; try next candidate
        console.warn(`[Gemini] ${model} on ${version} failed:`, e.message);
        lastErr = e;
        if (e.status && e.status !== 404) break; // break to next model
      }
    }
  }
  throw lastErr || new Error('No Gemini model worked. Check API key, project access, or switch to a supported model.');
}

async function tryStreamGenerateContent({ model, body, version, onToken }) {
  // Gemini streaming endpoint (Server-Sent Events style)
  const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Gemini STREAM ${version} ${model} failed: ${resp.status} ${text}`);
    err.status = resp.status;
    throw err;
  }

  if (!resp.body || !resp.body.getReader) {
    throw new Error('Streaming not supported by fetch response.');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';

  const feed = (chunk) => {
    if (!chunk) return;
    fullText += chunk;
    if (typeof onToken === 'function') {
      try { onToken(chunk); } catch {}
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // The stream is SSE: lines like "data: {json}\n\n"
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line || line.startsWith(':')) continue; // comment/heartbeat
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const evt = JSON.parse(payload);
        // Each event can contain partial text in different shapes; be defensive:
        const parts = evt?.candidates?.[0]?.content?.parts || [];
        const delta =
          (Array.isArray(parts) ? parts.map(p => p?.text || '').join('') : '') ||
          evt?.candidates?.[0]?.content?.parts?.[0]?.text ||
          evt?.candidates?.[0]?.delta?.text || // some SDKs emit delta
          '';
        if (delta) feed(delta);
      } catch (e) {
        // ignore malformed lines
      }
    }
  }

  return { text: fullText, model, version };
}

// Try stream over your candidate list; fall back through versions
async function callGeminiStreamWithFallback(body, onToken) {
  const versions = ['v1beta', 'v1'];
  let lastErr = null;

  for (const version of versions) {
    for (const model of CANDIDATE_MODELS) {
      try {
        return await tryStreamGenerateContent({ model, body, version, onToken });
      } catch (err) {
        lastErr = err;
        // try the next model
      }
    }
  }
  throw lastErr || new Error('No Gemini streaming model worked. Check API key, project access, or switch to a supported model.');
}

export async function getAIResponse(messages, { onToken } = {}) {
  if (!GEMINI_KEY || GEMINI_KEY.startsWith('<PUT_')) {
    throw new Error('GEMINI_KEY not set. Provide it or proxy this call via your server.');
  }

  const { contents, systemText } = toGeminiContents(messages);

  const body = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048
    }
  };

  // If we had any system messages, attach them as systemInstruction (supported on Gemini API).
  if (systemText.trim()) {
    body.systemInstruction = {
      role: 'system',
      parts: [{ text: systemText }]
    };
  }

  // If caller passed onToken, try streaming first for snappy UX
  if (typeof onToken === 'function') {
    try {
      const streamed = await callGeminiStreamWithFallback(body, onToken);
      if (streamed?.text) {
        console.log(`[Gemini] Used model=${streamed.model} on ${streamed.version} (stream)`);
        return streamed.text;
      }
    } catch (e) {
      console.warn('[Gemini] Streaming failed, falling back to non-streaming:', e);
      // fall through to non-streaming
    }
  }

  // Non-streaming fallback (your current path)
  const { json, model, version } = await callGeminiWithFallback(body);

  const candidate = json?.candidates?.[0];
  if (!candidate) {
    console.error('[Gemini] No candidates in response:', json);
    return 'The AI could not generate a response. Please try rephrasing your question.';
  }

  // Check finish reason
  const finishReason = candidate.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.warn('[Gemini] Non-standard finish reason:', finishReason);
    
    if (finishReason === 'SAFETY') {
      return 'The AI response was blocked by safety filters. Please try rephrasing your question.';
    }
    if (finishReason === 'MAX_TOKENS') {
      console.warn('[Gemini] Response truncated due to token limit');
    }
    if (finishReason === 'RECITATION') {
      return 'The AI detected potential copyright content. Please rephrase your question.';
    }
  }

  // Extract text from response
  const text =
    candidate.content?.parts?.[0]?.text?.trim() ||
    candidate.content?.parts?.map(p => p.text).filter(Boolean).join('\n') ||
    '';

  if (!text) {
    console.error('[Gemini] No text in response. Full payload:', JSON.stringify(json, null, 2));
    return 'The AI returned an empty response. Please try again with a different question.';
  }

  console.log(`[Gemini] Used model=${model} on ${version}`);
  return text;
}