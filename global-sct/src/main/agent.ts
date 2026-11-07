import { z } from 'zod/v4'
import { agentTools } from '../shared/agent'
import type { AgentSubmit } from '../shared/agent'

export async function runAgent(args: string[], submit: AgentSubmit): Promise<number> {
  if (args.length === 2 && args[1] === '--help') {
    await writeCliOutput(`Usage: sct agent <operation> --stdin\nOr: sct agent --stdin (JSON envelope with operation and input)\nUse sct agent --schema for input schemas. Local approval is required.\nOperations: ${Object.keys(agentTools).join(', ')}\nNever put secret values in arguments. CLI envelopes support stdinValue for run_demo.`)
    return 0
  }
  if (args.length === 2 && args[1] === '--schema') {
    await writeCliOutput(JSON.stringify(Object.fromEntries(Object.entries(agentTools).map(([name, tool]) =>
      [name, { description: tool.description, inputSchema: z.toJSONSchema(tool.schema) }]))))
    return 0
  }
  if (!process.stdin || process.stdin.isTTY || !((args.length === 2 && args[1] === '--stdin') ||
    (args.length === 3 && Object.hasOwn(agentTools, args[1]) && args[2] === '--stdin'))) {
    throw new Error('Usage: sct agent [operation] --stdin. Supply JSON through a private stdin pipe.')
  }
  let input = ''
  try {
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      input += chunk
      if (Buffer.byteLength(input) > 1_048_576) throw new Error('Input limit exceeded.')
    }
    const decoded: unknown = JSON.parse(input)
    input = ''
    const outcome = await submit(args.length === 3 ? { operation: args[1], input: decoded } : decoded)
    await writeCliOutput(JSON.stringify(outcome))
    return outcome.status === 'completed' ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message
      : 'The agent request could not complete. Supply valid JSON within the input limit and check the local approval window.')
    return 1
  }
}

export function writeCliOutput(text: string): Promise<void> {
  // Electron exits when the command completes, so pipe writes must finish first.
  return new Promise((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => { if (error) reject(error); else resolve() })
  })
}
