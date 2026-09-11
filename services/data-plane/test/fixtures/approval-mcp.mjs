import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {appendFile} from 'node:fs/promises';
import {z} from 'zod';
const server=new McpServer({name:'approval-fixture',version:'1.0.0'});
server.registerTool('echo',{inputSchema:{message:z.string()}},async({message})=>{
  await appendFile(process.argv[2],message+'\n');
  return {content:[{type:'text',text:message}]};
});
await server.connect(new StdioServerTransport());
