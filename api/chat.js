export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: "No messages" } });
    }

    const systemPrompt = messages.find(m => m.role === "system")?.content || "";
    let history = messages.filter(m => m.role !== "system");
    if (history.length > 12) history = history.slice(-12);

    const geminiMessages = history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content).slice(0, 4000) }]
    }));

    if (!geminiMessages.length || geminiMessages[geminiMessages.length - 1].role !== "user") {
      return res.status(400).json({ error: { message: "Last message must be from user" } });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: geminiMessages,
        generationConfig: {
          maxOutputTokens: 8192,
          temperature: 0.7,
        }
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.json().catch(() => ({}));
      return res.status(geminiRes.status).json({
        error: { message: err?.error?.message || "Gemini Pro error" }
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch {}
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();

  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || "Server error" } });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
}
