export const config = { runtime: "edge" };

export default async function handler(req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

  try {
    const { messages, temperature = 0.7 } = await req.json();

    if (!messages || !Array.isArray(messages)) return json({ error: { message: "No messages" } }, 400);

    const systemMsg = messages.find(m => m.role === "system")?.content || "";
    const history = messages
      .filter(m => m.role !== "system")
      .slice(-12)
      .map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 4000),
      }));

    if (!history.length || history.at(-1).role !== "user") {
      return json({ error: { message: "Last message must be from user" } }, 400);
    }

    const openRouterMessages = [];
    if (systemMsg) openRouterMessages.push({ role: "system", content: systemMsg });
    openRouterMessages.push(...history);

    const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://mchat.vercel.app",
        "X-Title": "MChat",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-r1:free",
        messages: openRouterMessages,
        stream: true,
        temperature: Math.min(Math.max(parseFloat(temperature) || 0.7, 0), 2),
        max_tokens: 8192,
      }),
    });

    if (!orRes.ok) {
      const err = await orRes.json().catch(() => ({}));
      return json({ error: { message: err?.error?.message || `OpenRouter error ${orRes.status}` } }, orRes.status);
    }

    // Edge streaming — трансформируем OpenAI SSE → наш SSE формат
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const reader = orRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              // DeepSeek R1 иногда возвращает reasoning в отдельном поле
              const text = parsed.choices?.[0]?.delta?.content;
              if (text) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
              }
            } catch {}
          }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        ...cors,
      },
    });

  } catch (err) {
    return json({ error: { message: err.message || "Server error" } }, 500);
  }
}
