import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ZodType } from 'zod/v4'
import { version } from '../../package.json'
import { agentTools } from '../shared/agent'
import type { AgentSubmit } from '../shared/agent'
import { writeCliOutput } from './agent'

export async function runMcp(args: string[], submit: AgentSubmit, skills: string): Promise<void> {
  if (args.length === 2 && args[1] === '--help') {
    await writeCliOutput('Usage: sct mcp\nConnect an MCP client through private stdin and stdout pipes. Local approval is required for each operation.\nUse sct agent --schema for the equivalent CLI operations. Skills are available as MCP prompts and resources.')
    return
  }
  if (args.length !== 1 || process.stdin.isTTY || process.stdout.isTTY) {
    throw new Error('Usage: sct mcp. The MCP transport requires private process pipes.')
  }
  const server = new McpServer({ name: 'global.sct', version })
  for (const [operation, tool] of Object.entries(agentTools)) {
    const schema: ZodType<Record<string, unknown>> = tool.schema
    server.registerTool(operation, { description: tool.description, inputSchema: schema,
      annotations: { readOnlyHint: ['list_secrets', 'describe_secret', 'sharing_state', 'relay_status'].includes(operation),
        destructiveHint: operation === 'delete_secret', openWorldHint: ['send_secrets_to', 'pair_device', 'relay_status', 'request_remote_demo'].includes(operation) }
    }, async (input, context) => {
      if (operation === 'run_demo' && typeof input.secretId !== 'string') {
        return { isError: true, content: [{ type: 'text', text: 'run_demo requires a saved secret ID. Plaintext input is available only through the private CLI stdin channel.' }] }
      }
      try {
        const outcome = await submit({ operation, input }, context.mcpReq.signal)
        return { isError: outcome.status !== 'completed', content: [{ type: 'text', text: JSON.stringify(outcome) }] }
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'The local request could not start. Check the project, vault, and storage.' }] }
      }
    })
    const instructions = () => readFile(join(skills, `sct-${operation.replaceAll('_', '-')}`, 'SKILL.md'), 'utf8')
    server.registerResource(operation, `global-sct://skills/${operation}`, { description: tool.description, mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await instructions() }] }))
    server.registerPrompt(operation, { description: tool.description }, async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: await instructions() } }]
    }))
  }
  const closed = new Promise<void>((resolve) => { server.server.onclose = resolve })
  server.server.onerror = () => { console.error('The MCP input or transport is invalid.') }
  await server.connect(new StdioServerTransport())
  await closed
}
