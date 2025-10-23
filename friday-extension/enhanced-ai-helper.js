// enhanced-ai-helper.js - Secure version (no API keys)
const API_BASE = "http://localhost:3000";

function toGeminiContents(messages) {
  const contents = [];
  let systemText = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemText += (systemText ? "\n\n" : "") + String(msg.content || "");
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    contents.push({
      role,
      parts: [{ text: String(msg.content || "") }],
    });
  }

  return { contents, systemText };
}

export async function getAIResponse(messages, { onToken } = {}) {
  // If streaming is requested, use the streaming endpoint
  if (typeof onToken === "function") {
    try {
      return await streamFromServer(messages, onToken);
    } catch (error) {
      console.warn(
        "[AI] Streaming failed, falling back to non-streaming:",
        error
      );
      // Fall through to non-streaming
    }
  }

  // Non-streaming fallback
  return await getNonStreamingResponse(messages);
}

async function streamFromServer(messages, onToken) {
  const response = await fetch(`${API_BASE}/ai/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    throw new Error(`Server streaming failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE format: "data: {json}\n\n"
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const evt = JSON.parse(payload);

        // Handle error events
        if (evt.error) {
          console.error("[AI Stream] Error event:", evt.error);
          continue;
        }

        // Extract text from Gemini response
        const parts = evt?.candidates?.[0]?.content?.parts || [];
        const delta = parts.map((p) => p?.text || "").join("");

        if (delta) {
          fullText += delta;
          onToken(delta);
        }
      } catch (e) {
        // Ignore malformed JSON
      }
    }
  }

  return fullText;
}

async function getNonStreamingResponse(messages) {
  // For non-streaming, we'll make a regular call
  // Note: You might want to add a non-streaming endpoint or modify this
  const response = await fetch(`${API_BASE}/ai/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    throw new Error(`Server request failed: ${response.status}`);
  }

  // Read the entire stream
  let fullText = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const evt = JSON.parse(payload);
        if (evt.error) continue;

        const parts = evt?.candidates?.[0]?.content?.parts || [];
        const delta = parts.map((p) => p?.text || "").join("");
        if (delta) fullText += delta;
      } catch (e) {}
    }
  }

  if (!fullText) {
    return "The AI returned an empty response. Please try again.";
  }

  return fullText;
}
