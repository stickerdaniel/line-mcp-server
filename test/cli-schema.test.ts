import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listTools, serve } from './mcp-client.ts';

// The generated CLI (scripts/gen-cli.sh) is checked in; this keeps it in step
// with the tool schemas the server advertises.

interface Flag {
	flag: string;
	argument: string;
	type: string;
	required: boolean;
}

/** Each `call-tool` subcommand of the generated CLI with its flags, as cyclopts derives them. */
function cliCommands(): Map<string, Flag[]> {
	const source = readFileSync(
		new URL('../skills/line-mcp/scripts/line_cli.py', import.meta.url),
		'utf-8'
	);
	const commands = new Map<string, Flag[]>();
	const blocks = source.split(/^@call_tool_app\.command\(name='([^']+)'\)\n/m).slice(1);
	for (let index = 0; index < blocks.length; index += 2) {
		const name = blocks[index]!;
		const body = blocks[index + 1]!;
		const flags: Flag[] = [];
		for (const match of body.matchAll(
			/^ {4}(\w+): Annotated\[(.+?), cyclopts\.Parameter\(help=".*"\)\]( = .+)?,$/gm
		)) {
			const [, parameter, type, fallback] = match as unknown as [string, string, string, string?];
			flags.push({
				flag: `--${parameter.replaceAll('_', '-')}`,
				argument: parameter,
				type: type.replace(/ \| None$/, ''),
				required: fallback === undefined
			});
		}
		// The dictionary each subcommand sends must use the schema's property names.
		const sent = /await _call_tool\('([^']+)', \{(.*)\}\)/.exec(body);
		expect(sent?.[1]).toBe(name);
		const keys = [...(sent?.[2] ?? '').matchAll(/'(\w+)': (\w+)/g)].map(([, key, value]) => {
			expect(value).toBe(key);
			return key;
		});
		expect(keys).toEqual(flags.map((flag) => flag.argument));
		commands.set(name, flags);
	}
	return commands;
}

const pythonType: Record<string, string> = { string: 'str', integer: 'int', boolean: 'bool' };

describe('generated CLI', () => {
	it('has one subcommand per tool with the flags and required arguments of its schema', async () => {
		const { server } = await serve();
		const tools = await listTools(server.port);
		const commands = cliCommands();

		expect([...commands.keys()].toSorted()).toEqual(tools.map((tool) => tool.name).toSorted());
		for (const tool of tools) {
			const properties = tool.inputSchema.properties ?? {};
			const required = new Set(tool.inputSchema.required ?? []);
			const expected = Object.entries(properties).map(([property, schema]) => ({
				flag: `--${property.replaceAll('_', '-')}`,
				argument: property,
				type: pythonType[schema.type ?? ''] ?? `unsupported ${JSON.stringify(schema)}`,
				required: required.has(property)
			}));
			expect([tool.name, commands.get(tool.name)]).toEqual([tool.name, expected]);
		}
	});
});
