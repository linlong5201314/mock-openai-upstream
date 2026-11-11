// mock-openai-upstream: deterministic OpenAI-compatible upstream for gateway stress testing.
// Endpoints: GET /v1/models, POST /v1/chat/completions (echo/tools/vision/stream/usage),
//            POST /v1/embeddings, and error-injection triggers.
const http = require('http');
const PORT = process.env.PORT || 8080;

const MODELS = [
  { id: 'mock-chat', object: 'model', owned_by: 'mock' },
  { id: 'mock-vision', object: 'model', owned_by: 'mock' },
  { id: 'mock-embed', object: 'model', owned_by: 'mock' },
];

function lastUserContent(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return msgs[i].content;
  return '';
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p.type === 'text' ? p.text : `[${p.type}:${(p.image_url?.url || '').length}chars]`)).join('|');
  }
  return JSON.stringify(content);
}

function chatCompletion(body) {
  const model = body.model || 'mock-chat';
  const raw = lastUserContent(body.messages || []);
  const text = textOf(raw);
  const isVision = Array.isArray(raw) && raw.some((p) => p.type === 'image_url');
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // error injection triggers (deterministic)
  if (text.startsWith('TRIGGER_429')) return { err: 429, body: { error: { message: 'mock rate limited', type: 'mock_rate_limit_error', code: 'rate_limit_exceeded' } } };
  if (text.startsWith('TRIGGER_500')) return { err: 500, body: { error: { message: 'mock upstream exploded', type: 'mock_internal_error' } } };
  if (text.startsWith('TRIGGER_401')) return { err: 401, body: { error: { message: 'mock invalid key', type: 'mock_auth_error', code: 'invalid_api_key' } } };

  let message, finish_reason = 'stop';
  if (hasTools && !text.startsWith('NOTOOL')) {
    // deterministic tool call: first declared tool, args echo the user text
    const t = body.tools[0];
    const fn = t.function || t;
    message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: fn.name, arguments: JSON.stringify({ echo: text }) } }] };
    finish_reason = 'tool_calls';
  } else if (text.startsWith('COUNT:')) {
    const n = parseInt(text.slice(6).trim(), 10) || 3;
    message = { role: 'assistant', content: `pong:${text}` };
  } else if (isVision) {
    message = { role: 'assistant', content: `vision-ok:${text}` };
  } else {
    message = { role: 'assistant', content: `pong:${text}` };
  }
  return { id: 'chatcmpl-mock1', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 17, completion_tokens: 11, total_tokens: 28 } };
}

function sseWrap(chunk) { return `data: ${JSON.stringify(chunk)}\n\n`; }

const server = http.createServer((req, res) => {
  let bufs = [];
  req.on('data', (c) => bufs.push(c));
  req.on('end', () => {
    const body = bufs.length ? JSON.parse(Buffer.concat(bufs).toString() || '{}') : {};
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: MODELS });
    if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true });

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const r = chatCompletion(body);
      if (r.err) return json(r.err, r.body);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(sseWrap({ id: r.id, object: 'chat.completion.chunk', model: r.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
        const content = r.choices[0].message.content;
        if (content) for (const piece of content.match(/.{1,8}/g) || []) res.write(sseWrap({ id: r.id, object: 'chat.completion.chunk', model: r.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
        if (r.choices[0].message.tool_calls) {
          const tc = r.choices[0].message.tool_calls[0];
          res.write(sseWrap({ id: r.id, object: 'chat.completion.chunk', model: r.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
        }
        res.write(sseWrap({ id: r.id, object: 'chat.completion.chunk', model: r.model, choices: [{ index: 0, delta: {}, finish_reason: r.choices[0].finish_reason }] }));
        res.write(sseWrap({ id: r.id, object: 'chat.completion.chunk', model: r.model, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: r.usage }));
        return res.end('data: [DONE]\n\n');
      }
      return json(200, r);
    }

    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      const inp = Array.isArray(body.input) ? body.input : [body.input];
      return json(200, { object: 'list', model: body.model || 'mock-embed', data: inp.map((t, i) => ({ object: 'embedding', index: i, embedding: [0.1, 0.2, 0.3, 0.4] })), usage: { prompt_tokens: 5, total_tokens: 5 } });
    }

    return json(404, { error: { message: 'not found: ' + req.url } });
  });
});
server.listen(PORT, () => console.log('mock-openai-upstream on ' + PORT));
