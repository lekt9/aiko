import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema,ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server=new Server({name:"aiko-stdio-fixture",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:"echo",description:"Echo a fixture",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>({content:[{type:"text",text:String(request.params.arguments?.text)}],structuredContent:{allowed:process.env.MCP_FIXTURE_ALLOWED??null,inheritedPrivate:!!process.env.AIKO_MCP_TEST_PRIVATE_PARENT}}));
await server.connect(new StdioServerTransport());
