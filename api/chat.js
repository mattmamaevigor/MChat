export const config = { runtime: "edge" };

export default async function handler(req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  try {
    const { messages, temperature = 0.7, systemOverride } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: { message: "No messages" } }), { status: 400, headers: { "Content-Type": "application/json", ...cors } });
    }

    const systemPrompt = systemOverride || messages.find(m => m.role === "system")?.content || "";
    let history = messages.filter(m => m.role !== "system").slice(-12);

    const geminiMessages = history.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content).slice(0, 4000) }]
    }));

    if (!geminiMessages.length || geminiMessages.at(-1).role !== "user") {
      return new Response(JSON.stringify({ error: { message: "Last message must be from user" } }), { status: 400, headers: { "Content-Type": "application/json", ...cors } });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 8192, temperature: parseFloat(temperature) || 0.7 }
      }),
    });

    if (!geminiRes.ok) {
      const err = await geminiRes.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: { message: err?.error?.message || "Gemini error" } }), {
        status: geminiRes.status, headers: { "Content-Type": "application/json", ...cors }
      });
    }

    // Edge runtime — трансформируем SSE Gemini → SSE клиенту
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const reader = geminiRes.body.getReader();
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
            if (!data || data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) await writer.write(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
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
        ...cors
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message || "Server error" } }), {
      status: 500, headers: { "Content-Type": "application/json", ...cors }
    });
  }
}
