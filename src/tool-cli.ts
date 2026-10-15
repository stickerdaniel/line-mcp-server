// The MCP tools as `line-mcp` commands. Commands and flags are derived at
// runtime from the zod schemas the server registers, so the CLI cannot drift
// from the tools. A tool command calls the running daemon over MCP.
import { resolve } from 'node:path';
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { Client } from '@prefecthq/fastmcp-ts/client';
import { z } from 'zod';
import type { ErrorCode } from './errors.ts';
import { mcpPath, mcpPort, mutatingTools, readTools } from './mcp/server.ts';

/**
 * The CLI's own deadline for one call, in seconds; the client's default of 60
 * would cut a large attachment download short.
 */
const timeoutSeconds = 300;

/** A flag of a tool command, from one field of the tool's input schema. */
interface Flag {
	/** The input field, `chat_id`. */
	field: string;
	/** The flag without dashes, `chat-id`. */
	name: string;
	type: 'string' | 'boolean';
	/** The values an enum field allows. */
	choices?: readonly string[];
	required: boolean;
	description: string;
}

export interface ToolCommand {
	name: string;
	tool: string;
	description: string;
	input: z.ZodObject;
	flags: Flag[];
}

const kebab = (name: string) => name.replaceAll('_', '-');

const descriptionOf = (type: unknown) => (type instanceof z.ZodType ? type.description : undefined);

/**
 * Maps one input field to a flag. A schema type without a flag shape throws,
 * which fails every CLI test rather than a user's call.
 */
function flagOf(field: string, schema: unknown): Flag {
	const optional = schema instanceof z.ZodOptional;
	const inner: unknown = optional ? schema.unwrap() : schema;
	const flag = {
		field,
		name: kebab(field),
		required: !optional,
		// `.describe()` may sit on the optional wrapper or on the type inside it.
		description: descriptionOf(schema) ?? descriptionOf(inner) ?? ''
	};
	// A string format such as `z.iso.datetime()` is a string, though not a `ZodString`.
	if (inner instanceof z.ZodString || inner instanceof z.ZodStringFormat) {
		return { ...flag, type: 'string' };
	}
	if (inner instanceof z.ZodEnum) {
		return { ...flag, type: 'string', choices: inner.options.map(String) };
	}
	if (inner instanceof z.ZodBoolean) return { ...flag, type: 'boolean' };
	throw new Error(`The CLI has no flag type for the input field ${field}`);
}

/** Every tool, kebab-cased; `line-mcp status` reads the local setup, so the tool is `sync-status`. */
export const toolCommands: ReadonlyMap<string, ToolCommand> = new Map(
	[...readTools, ...mutatingTools].map((tool) => {
		const name = tool.name === 'status' ? 'sync-status' : kebab(tool.name);
		const flags = Object.entries(tool.input.shape).map(([field, schema]) => flagOf(field, schema));
		return [
			name,
			{ name, tool: tool.name, description: tool.description, input: tool.input, flags }
		];
	})
);

/** One line per tool command for `line-mcp help`: its name and first sentence. */
export function toolUsage(): string {
	const commands = [...toolCommands.values()];
	const width = Math.max(...commands.map((command) => command.name.length));
	return commands
		.map((command) => {
			const summary = command.description.split('. ')[0]!.replace(/\.$/, '');
			return `  ${command.name.padEnd(width)}  ${summary}`;
		})
		.join('\n');
}

/** `line-mcp <command> --help`: the tool description and one line per flag. */
function helpText(command: ToolCommand): string {
	const rows = command.flags.map((flag) => {
		const value = flag.choices
			? ` <${flag.choices.join('|')}>`
			: flag.type === 'boolean'
				? ''
				: ` <${flag.type}>`;
		return {
			flag: `--${flag.name}${value}`,
			text: flag.description + (flag.required ? ' (required)' : '')
		};
	});
	if (rows.length === 0) return `Usage: line-mcp ${command.name}\n\n${command.description}`;
	const width = Math.max(...rows.map((row) => row.flag.length));
	return [
		`Usage: line-mcp ${command.name} [flags]`,
		'',
		command.description,
		'',
		'Flags:',
		...rows.map((row) => `  ${row.flag.padEnd(width)}  ${row.text}`)
	].join('\n');
}

class UsageError extends Error {}

/** A flag value as the tool takes it: `file_path` absolute. */
function convert(flag: Flag, raw: string | boolean): unknown {
	if (typeof raw === 'boolean') return raw;
	// The tool wants an absolute path; a shell user gives one relative to here.
	if (flag.field === 'file_path') return raw && resolve(raw);
	return raw;
}

/** The tool arguments the command line gives, checked against the schema; `help` for `--help`. */
function parse(command: ToolCommand, argv: string[]): Record<string, unknown> | 'help' {
	const options: ParseArgsOptionsConfig = { help: { type: 'boolean', short: 'h' } };
	for (const flag of command.flags) {
		options[flag.name] = { type: flag.type === 'boolean' ? 'boolean' : 'string' };
	}
	let values: ReturnType<typeof parseArgs>['values'];
	try {
		({ values } = parseArgs({ args: argv, options, strict: true }));
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		throw new UsageError(error.message);
	}
	if (values.help === true) return 'help';
	const args: Record<string, unknown> = {};
	for (const flag of command.flags) {
		const raw = values[flag.name];
		if (raw === undefined) {
			if (flag.required) throw new UsageError(`--${flag.name} is required`);
		} else if (!Array.isArray(raw)) {
			args[flag.field] = convert(flag, raw);
		}
	}
	const checked = command.input.safeParse(args);
	if (!checked.success) {
		const [issue] = checked.error.issues;
		const field = issue?.path[0];
		throw new UsageError(
			`${typeof field === 'string' ? `--${kebab(field)}: ` : ''}${issue?.message ?? 'invalid arguments'}`
		);
	}
	return args;
}

function fail(code: ErrorCode, operation: string, message: string): void {
	console.error(JSON.stringify({ error: { code, operation, message } }));
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Runs a tool command and returns the exit code. The result goes to stdout as
 * JSON, indented on a terminal; a failure goes to stderr as JSON. Exit codes:
 * 0 success, 1 a tool error or no daemon, 2 a usage error before any request,
 * 130 Ctrl-C, which closes the request so the daemon cancels the call.
 */
export async function runToolCommand(command: ToolCommand, argv: string[]): Promise<number> {
	let args: Record<string, unknown>;
	try {
		const parsed = parse(command, argv);
		if (parsed === 'help') {
			console.log(helpText(command));
			return 0;
		}
		args = parsed;
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		fail(
			'invalid_argument',
			command.tool,
			`${error.message}; line-mcp ${command.name} --help lists the flags`
		);
		return 2;
	}

	const port = mcpPort();
	const client = new Client(`http://127.0.0.1:${port}${mcpPath}`, {
		defaultOptions: { timeout: timeoutSeconds },
		handlers: { log: () => {}, progress: () => {} }
	});
	const interrupt = Promise.withResolvers<'interrupted'>();
	const onInterrupt = () => interrupt.resolve('interrupted');
	process.once('SIGINT', onInterrupt);
	try {
		const connected = await Promise.race([
			client.connect().then(
				() => 'connected' as const,
				() => 'unreachable' as const
			),
			interrupt.promise
		]);
		if (connected === 'interrupted') return 130;
		if (connected === 'unreachable') {
			fail(
				'daemon_unreachable',
				command.tool,
				`No line-mcp daemon answers on 127.0.0.1:${port}; line-mcp doctor checks the setup, line-mcp install starts the daemon`
			);
			return 1;
		}
		const result = await Promise.race([client.callToolRaw(command.tool, args), interrupt.promise]);
		if (result === 'interrupted') return 130;
		const text = result.content
			.flatMap((block) => (block.type === 'text' ? [block.text] : []))
			.join('');
		const data = result.structuredContent ?? parseJson(text);
		if (result.isError) {
			// The whole error object: a mutating tool's outbox state is part of it.
			if (data === undefined) fail('request_failed', command.tool, text);
			else console.error(JSON.stringify(data));
			return 1;
		}
		console.log(JSON.stringify(data ?? text, null, process.stdout.isTTY ? 2 : undefined));
		return 0;
	} catch (error) {
		fail('request_failed', command.tool, error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		process.off('SIGINT', onInterrupt);
		await client.close();
	}
}
