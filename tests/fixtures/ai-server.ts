import http from "node:http";
import { randomUUID } from "node:crypto";

// Real CLI clients and real native conversation files, with deterministic
// inference over loopback. No account credentials or paid API calls are used.
export async function aiServer() {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET" || req.url?.includes("count_tokens")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          req.method === "GET"
            ? {
                object: "list",
                data: [
                  {
                    id: "fixture",
                    object: "model",
                    created: 0,
                    owned_by: "fixture",
                  },
                ],
              }
            : { input_tokens: 1 },
        ),
      );
      return;
    }
    requests++;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "close",
    });
    const emit = (type: string, value: object) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
      );
    const text = "PASSPORT_NATIVE_REPLY",
      id = "msg_" + randomUUID().replaceAll("-", "");
    if (req.url?.includes("messages")) {
      emit("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      emit("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      emit("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text },
      });
      emit("content_block_stop", { index: 0 });
      emit("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      });
      emit("message_stop", {});
    } else {
      const response = {
        id: "resp_" + randomUUID(),
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: body.model,
        output: [],
      };
      const item = {
        id,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      };
      const part = { type: "output_text", text, annotations: [] };
      const reference = { item_id: id, output_index: 0, content_index: 0 };
      emit("response.created", { response });
      emit("response.output_item.added", { output_index: 0, item });
      emit("response.content_part.added", {
        ...reference,
        part: { ...part, text: "" },
      });
      emit("response.output_text.delta", { ...reference, delta: text });
      emit("response.output_text.done", { ...reference, text });
      emit("response.content_part.done", { ...reference, part });
      const finished = { ...item, status: "completed", content: [part] };
      emit("response.output_item.done", { output_index: 0, item: finished });
      emit("response.completed", {
        response: {
          ...response,
          status: "completed",
          output: [finished],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      });
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
