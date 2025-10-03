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
  // If you KNOW a specific pro model is enabled for your key, you can add it:
  // 'gemini-1.5-pro',
  // 'gemini-1.5-pro-001',
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
        // Other status codes: bubble up after trying next version/model once.
        console.warn(`[Gemini] ${model} on ${version} failed:`, e.message);
        lastErr = e;
        if (e.status && e.status !== 404) break; // break to next model
      }
    }
  }
  throw lastErr || new Error('No Gemini model worked. Check API key, project access, or switch to a supported model.');
}

export async function getAIResponse(messages) {
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

  const { json, model, version } = await callGeminiWithFallback(body);

  // Check for safety blocks or finish reasons
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
