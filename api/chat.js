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
    let history = messages
      .filter(m => m.role !== "system")
      .slice(-12)
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: String(m.content).slice(0, 3000) }]
      }));

    if (!history.length || history[history.length - 1].role !== "user") {
      return res.status(400).json({ error: { message: "Last message must be from user" } });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: history,
        generationConfig: {
          maxOutputTokens: 8192,
          temperature: 0.7,
        }
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({
        error: { message: data?.error?.message || "Gemini error" }
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return res.status(200).json({
        choices: [{ message: { role: "assistant", content: "Нет ответа от модели." } }]
      });
    }

    return res.status(200).json({
      choices: [{ message: { role: "assistant", content: text } }]
    });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message || "Server error" } });
  }
}
