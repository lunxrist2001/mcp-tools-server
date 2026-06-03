const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const http = require("node:http"), https = require("node:https"), z = require("zod");

const log = (m) => console.error(`[TOOLS] ${m}`);

function fetchUrl(url, maxLen = 1e5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, { timeout: 15e3, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c.toString(); if (d.length > maxLen) { res.destroy(); resolve(d.slice(0, maxLen) + "\n[...truncated]"); } });
      res.on("end", () => resolve(d.length > maxLen ? d.slice(0, maxLen) + "\n[...truncated]" : d));
    }).on("error", reject);
  });
}

function getTime(tz) {
  const n = new Date();
  try { return `Time in ${tz||"UTC"}: ${n.toLocaleString("ru-RU", { timeZone: tz||"UTC", hour12: false })}\nUTC: ${n.toISOString()}\nUnix: ${Math.floor(n.getTime()/1000)}`; }
  catch { return `UTC: ${n.toISOString()}\nUnix: ${Math.floor(n.getTime()/1000)}\n(Invalid tz: ${tz})`; }
}

const mem = new Map();

const server = new Server({ name: "mcp-tools", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "fetch", description: "Fetch web page content", inputSchema: { type: "object", properties: { url: { type: "string" }, maxLength: { type: "number", default: 1e5 } }, required: ["url"] } },
    { name: "get_time", description: "Get current time in a timezone (e.g. Europe/Moscow, America/New_York)", inputSchema: { type: "object", properties: { timezone: { type: "string", default: "UTC" } } } },
    { name: "memory_save", description: "Save value to memory (key-value store)", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key","value"] } },
    { name: "memory_get", description: "Get value from memory. *all* = list all, *clear* = clear", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    { name: "memory_delete", description: "Delete key from memory", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const ok = (t) => ({ content: [{ type: "text", text: t }] });
  const err = (t) => ({ content: [{ type: "text", text: t }], isError: true });
  try {
    switch (name) {
      case "fetch": { const p = z.object({ url: z.string(), maxLength: z.number().optional().default(1e5) }).parse(args); return ok(await fetchUrl(p.url, p.maxLength)); }
      case "get_time": { const p = z.object({ timezone: z.string().optional() }).parse(args); return ok(getTime(p.timezone)); }
      case "memory_save": { const p = z.object({ key: z.string(), value: z.string() }).parse(args); mem.set(p.key, p.value); return ok(`OK: ${p.key}=${p.value.slice(0,100)}`); }
      case "memory_get": { const p = z.object({ key: z.string() }).parse(args); if (p.key === "*all*") return ok(mem.size ? [...mem].map(([k,v])=>`${k}: ${v}`).join("\n") : "Empty"); if (p.key === "*clear*") { mem.clear(); return ok("Cleared"); } return ok(mem.has(p.key) ? `${p.key}: ${mem.get(p.key)}` : `Not found: ${p.key}`); }
      case "memory_delete": { const p = z.object({ key: z.string() }).parse(args); return ok(mem.delete(p.key) ? `Deleted: ${p.key}` : `Not found: ${p.key}`); }
      default: return err(`Unknown: ${name}`);
    }
  } catch (e) { return err(e instanceof z.ZodError ? e.errors.map(x=>x.path.join(".")+": "+x.message).join("; ") : e.message); }
});

async function main() {
  const port = parseInt(process.env.PORT || "3001", 10);
  const transports = {};

  http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok" })); return;
      }
      if (req.method === "GET" && req.url === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport._sessionId;
        transports[sessionId] = transport;
        res.on("close", () => { delete transports[sessionId]; });
        await server.connect(transport);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages")) {
        const url = new URL(req.url, "http://localhost");
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? transports[sessionId] : null;
        if (!transport) { res.writeHead(404).end("Session not found"); return; }
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        await transport.handlePostMessage(req, res, body);
        return;
      }
      res.writeHead(404).end("Not found");
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    }
  }).listen(port, "0.0.0.0", () => log(`Server on http://0.0.0.0:${port}/sse`));
}
main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
