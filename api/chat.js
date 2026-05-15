export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    let { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: "No messages" } });
    }

    // Оставляем только последние 6 сообщений + системный промпт
    if (messages.length > 7) {
      messages = [messages[0], ...messages.slice(-6)];
    }

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: "compound-beta",
        max_tokens: 1024,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: { message: data?.error?.message || "Groq error" }
      });
    }

    // Отправляем ТОЛЬКО текст ответа — не весь огромный ответ Groq
    const text = data.choices?.[0]?.message?.content || "";
    return res.status(200).json({
      choices: [{ message: { content: text } }]
    });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
