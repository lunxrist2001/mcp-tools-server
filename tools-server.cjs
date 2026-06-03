const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const http = require("node:http"), https = require("node:https"), z = require("zod"), crypto = require("node:crypto");

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
const sess = new Map();

const tools = [
  { name: "fetch", description: "Fetch web page content", inputSchema: { type: "object", properties: { url: { type: "string" }, maxLength: { type: "number" } }, required: ["url"] } },
  { name: "get_time", description: "Get current time in a timezone (e.g. Europe/Moscow, America/New_York)", inputSchema: { type: "object", properties: { timezone: { type: "string", default: "UTC" } } } },
  { name: "memory_save", description: "Save value to key-value memory", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key","value"] } },
  { name: "memory_get", description: "Get value from memory. *all* = list all, *clear* = clear", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "memory_delete", description: "Delete key from memory", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }
];

async function handleCall(name, args) {
  const ok = (t) => ({ content: [{ type: "text", text: t }] });
  const errMsg = (t) => ({ content: [{ type: "text", text: t }], isError: true });
  try {
    switch (name) {
      case "fetch": { const p = z.object({ url: z.string(), maxLength: z.number().optional() }).parse(args); return ok(await fetchUrl(p.url, p.maxLength || 1e5)); }
      case "get_time": { const p = z.object({ timezone: z.string().optional() }).parse(args); return ok(getTime(p.timezone)); }
      case "memory_save":
        { const p = z.object({ key: z.string(), value: z.string() }).parse(args); mem.set(p.key, p.value); return ok(`OK: ${p.key}=${p.value.slice(0,100)}`); }
      case "memory_get":
        { const p = z.object({ key: z.string() }).parse(args);
          if (p.key === "*all*") return ok(mem.size ? [...mem].map(([k,v])=>`${k}: ${v}`).join("\n") : "Empty");
          if (p.key === "*clear*") { mem.clear(); return ok("Cleared"); }
          return ok(mem.has(p.key) ? `${p.key}: ${mem.get(p.key)}` : `Not found: ${p.key}`); }
      case "memory_delete":
        { const p = z.object({ key: z.string() }).parse(args); return ok(mem.delete(p.key) ? `Deleted: ${p.key}` : `Not found: ${p.key}`); }
      default: return errMsg(`Unknown tool: ${name}`);
    }
  } catch (e) { return errMsg(e instanceof z.ZodError ? e.errors.map(x=>x.path.join(".")+": "+x.message).join("; ") : e.message); }
}

function json(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonErr(id, code, msg) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: msg } });
}

async function main() {
  const port = parseInt(process.env.PORT || "3001", 10);
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      
      // SSE endpoint
      if (req.method === "GET" && url.pathname === "/sse") {
        const sid = crypto.randomUUID();
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "mcp-session-id": sid
        });
        res.write(`event: endpoint\ndata: /sse?sessionId=${sid}\n\n`);
        sess.set(sid, { res });
        req.on("close", () => sess.delete(sid));
        return;
      }
      
      if (req.method !== "POST") {
        res.writeHead(405).end("Method not allowed");
        return;
      }
      
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      if (!raw.includes("jsonrpc")) { res.writeHead(400).end("Not JSON-RPC"); return; }
      const body = JSON.parse(raw);
      const messages = Array.isArray(body) ? body : [body];
      
      let responses = [];
      for (const msg of messages) {
        const id = msg.id ?? null;
        
        if (msg.method === "initialize") {
          const sid = crypto.randomUUID();
          responses.push(json(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mcp-tools", version: "1.0.0" } }));
          res.setHeader("mcp-session-id", sid);
          continue;
        }
        
        if (msg.method === "tools/list") {
          responses.push(json(id, { tools }));
          continue;
        }
        
        if (msg.method === "tools/call") {
          const result = await handleCall(msg.params.name, msg.params.arguments);
          responses.push(json(id, result));
          continue;
        }
        
        if (msg.method?.startsWith("notifications/") || msg.method?.startsWith("$/")) {
          // Notifications - no response needed
          continue;
        }
        
        responses.push(jsonErr(id, -32601, `Method not found: ${msg.method}`));
      }
      
      if (responses.length === 0) {
        res.writeHead(202).end();
      } else if (responses.length === 1) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(responses[0]);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(`[${responses.join(",")}]`);
      }
    } catch (e) {
      log(`Error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
  }).listen(port, "0.0.0.0", () => log(`Server on http://0.0.0.0:${port}`));
}
main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });