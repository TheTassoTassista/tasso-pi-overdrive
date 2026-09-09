import fs from "node:fs";
import { Server } from "../../runtime/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StdioServerTransport } from "../../runtime/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "../../runtime/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

const marker = process.argv[2];
if (!marker) throw new Error("marker path is required");

const server = new Server({ name: "pi-overdrive-mutation-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "mutate", description: "Write a test marker", inputSchema: { type: "object", properties: {} } },
  { name: "hidden_read", description: "Tool excluded by the test allowlist", inputSchema: { type: "object", properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async () => {
  fs.writeFileSync(marker, "MUTATION_RAN\n", { flag: "wx", mode: 0o600 });
  return { content: [{ type: "text", text: "mutation ran" }] };
});
await server.connect(new StdioServerTransport());
