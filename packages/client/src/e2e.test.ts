/**
 * End-to-end tests for FlueClient with fixture-based LLM responses.
 *
 * These tests exercise the full pipeline: FlueClient → prompt building →
 * OpenCode SDK → polling → result extraction, using a mock HTTP server
 * that returns canned responses matching the OpenCode API.
 */
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { FlueClient } from './flue.ts';
import { HEADLESS_PREAMBLE } from './prompt.ts';

// ---------------------------------------------------------------------------
// Mock OpenCode HTTP server
// ---------------------------------------------------------------------------

interface MockRoute {
	method: string;
	pattern: RegExp;
	handler: (req: http.IncomingMessage, match: RegExpMatchArray, body: string) => unknown;
}

interface SessionState {
	/** Queued status: first call returns 'busy', subsequent return 'idle'. */
	statusCalls: number;
	/** The prompt text sent by FlueClient. */
	promptText: string | null;
	/** Messages to return (fixture data). */
	messages: unknown[];
}

function createMockServer(sessions: Map<string, SessionState>, routes?: MockRoute[]) {
	let nextSessionId = 1;

	const defaultRoutes: MockRoute[] = [
		// POST /session — create session
		{
			method: 'POST',
			pattern: /^\/session(\?|$)/,
			handler: () => {
				const id = `test-sess-${nextSessionId++}`;
				sessions.set(id, { statusCalls: 0, promptText: null, messages: [] });
				return { id, title: '' };
			},
		},
		// POST /session/:id/prompt_async — send prompt
		{
			method: 'POST',
			pattern: /^\/session\/([^/]+)\/prompt_async/,
			handler: (_req, match, body) => {
				const id = match[1]!;
				const state = sessions.get(id);
				if (state) {
					const parsed = JSON.parse(body);
					state.promptText = parsed.parts?.[0]?.text ?? null;
				}
				return {};
			},
		},
		// GET /session/status — session status
		{
			method: 'GET',
			pattern: /^\/session\/status/,
			handler: () => {
				const result: Record<string, { type: string }> = {};
				for (const [id, state] of sessions) {
					state.statusCalls++;
					// First status call returns busy (for confirmSessionStarted),
					// subsequent calls return idle (for pollUntilIdle).
					result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
				}
				return result;
			},
		},
		// GET /session/:id/message — list messages
		{
			method: 'GET',
			pattern: /^\/session\/([^/]+)\/message(\?|$)/,
			handler: (_req, match) => {
				const id = match[1]!;
				const state = sessions.get(id);
				return state?.messages ?? [];
			},
		},
		// DELETE /session/:id — delete session
		{
			method: 'DELETE',
			pattern: /^\/session\/([^/]+)(\?|$)/,
			handler: (_req, match) => {
				sessions.delete(match[1]!);
				return {};
			},
		},
	];

	const allRoutes = [...(routes ?? []), ...defaultRoutes];

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://localhost`);
		const method = req.method ?? 'GET';

		let body = '';
		req.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on('end', () => {
			for (const route of allRoutes) {
				if (route.method !== method) continue;
				const match = url.pathname.match(route.pattern);
				if (!match) continue;

				try {
					const result = route.handler(req, match, body);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(result));
				} catch (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: String(err) }));
				}
				return;
			}

			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: `No mock route for ${method} ${url.pathname}` }));
		});
	});

	return server;
}

function listenOnRandomPort(server: http.Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address() as { port: number };
			resolve(addr.port);
		});
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a mock assistant message containing text with a RESULT block. */
function assistantMessage(text: string) {
	return {
		info: { role: 'assistant' },
		parts: [{ type: 'text', text }],
	};
}

/** Build a mock user message. */
function userMessage(text: string) {
	return {
		info: { role: 'user' },
		parts: [{ type: 'text', text }],
	};
}

/** Wrap a value in ---RESULT_START--- / ---RESULT_END--- delimiters. */
function resultBlock(content: string): string {
	return `Here is the result:\n---RESULT_START---\n${content}\n---RESULT_END---`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FlueClient e2e', () => {
	let server: http.Server;
	let port: number;
	let sessions: Map<string, SessionState>;

	beforeAll(async () => {
		sessions = new Map();
		server = createMockServer(sessions);
		port = await listenOnRandomPort(server);
	});

	afterAll(async () => {
		await closeServer(server);
	});

	beforeEach(() => {
		vi.useFakeTimers();
		sessions.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createClient(opts?: { proxies?: FlueClient extends { constructor: infer C } ? never : never }) {
		return new FlueClient({
			opencodeUrl: `http://127.0.0.1:${port}`,
			workdir: '/tmp/test-workdir',
			fetch: (req: Request) => fetch(req),
			shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			...opts,
		});
	}

	/** Run a FlueClient method while advancing fake timers so polling completes. */
	async function runWithTimers<T>(fn: () => Promise<T>): Promise<T> {
		const promise = fn();
		// Advance timers repeatedly to push through all sleep() calls.
		// Each iteration advances 20s which covers the 15s poll interval and 1s confirm interval.
		for (let i = 0; i < 30; i++) {
			await vi.advanceTimersByTimeAsync(20_000);
		}
		return promise;
	}

	// -- skill() with structured result ------------------------------------

	describe('skill() with structured result', () => {
		it('extracts a JSON object result from LLM output', async () => {
			const schema = v.object({
				label: v.string(),
				priority: v.picklist(['low', 'medium', 'high']),
			});

			// Pre-populate the session fixture: after session is created,
			// set up the messages the mock server will return.
			const originalCreate = server.listeners('request');

			// We need to set up the fixture after the session is created.
			// Use a status handler that also sets up messages on first call.
			let fixtureSet = false;
			const setupFixture = () => {
				if (fixtureSet) return;
				fixtureSet = true;
				for (const [, state] of sessions) {
					state.messages = [
						userMessage('...prompt...'),
						assistantMessage(
							resultBlock(JSON.stringify({ label: 'bug', priority: 'high' })),
						),
					];
				}
			};

			// Override status route to also set up fixtures
			const customServer = createMockServer(sessions, [
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						setupFixture();
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							state.statusCalls++;
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test-workdir',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			const result = await runWithTimers(() =>
				flue.skill('triage', {
					args: { issueNumber: 42 },
					result: schema,
				}),
			);

			expect(result).toEqual({ label: 'bug', priority: 'high' });
		});

		it('extracts a string result from LLM output', async () => {
			sessions.clear();
			const customServer = createMockServer(sessions, [
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						// Set up fixture messages
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									assistantMessage(resultBlock('The issue is a duplicate of #12.')),
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test-workdir',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			const result = await runWithTimers(() =>
				flue.skill('summarize', {
					args: { issueNumber: 42 },
					result: v.string(),
				}),
			);

			expect(result).toBe('The issue is a duplicate of #12.');
		});
	});

	// -- prompt() with structured result -----------------------------------

	describe('prompt() with structured result', () => {
		it('sends correct prompt and extracts result', async () => {
			sessions.clear();
			let capturedPrompt: string | null = null;

			const customServer = createMockServer(sessions, [
				{
					method: 'POST',
					pattern: /^\/session\/([^/]+)\/prompt_async/,
					handler: (_req, match, body) => {
						const id = match[1]!;
						const state = sessions.get(id);
						if (state) {
							const parsed = JSON.parse(body);
							state.promptText = parsed.parts?.[0]?.text ?? null;
							capturedPrompt = state.promptText;
						}
						return {};
					},
				},
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									assistantMessage(
										resultBlock(JSON.stringify({ answer: 42, confidence: 0.95 })),
									),
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test-workdir',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			const schema = v.object({ answer: v.number(), confidence: v.number() });
			const result = await runWithTimers(() =>
				flue.prompt('What is the meaning of life?', { result: schema }),
			);

			// Verify result extraction
			expect(result).toEqual({ answer: 42, confidence: 0.95 });

			// Verify prompt construction
			expect(capturedPrompt).toContain(HEADLESS_PREAMBLE);
			expect(capturedPrompt).toContain('What is the meaning of life?');
			expect(capturedPrompt).toContain('---RESULT_START---');
			expect(capturedPrompt).toContain('---RESULT_END---');
		});
	});

	// -- prompt() without result schema (fire-and-forget) ------------------

	describe('prompt() without result', () => {
		it('completes without returning a value', async () => {
			sessions.clear();

			const customServer = createMockServer(sessions, [
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									assistantMessage('I have completed the task.'),
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test-workdir',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			const result = await runWithTimers(() =>
				flue.prompt('Please fix the typo in README.md'),
			);

			expect(result).toBeUndefined();
		});
	});

	// -- skill() prompt construction ---------------------------------------

	describe('skill() prompt construction', () => {
		it('includes skill name and args in the prompt sent to OpenCode', async () => {
			sessions.clear();
			let capturedPrompt: string | null = null;

			const customServer = createMockServer(sessions, [
				{
					method: 'POST',
					pattern: /^\/session\/([^/]+)\/prompt_async/,
					handler: (_req, match, body) => {
						const id = match[1]!;
						const state = sessions.get(id);
						if (state) {
							const parsed = JSON.parse(body);
							state.promptText = parsed.parts?.[0]?.text ?? null;
							capturedPrompt = state.promptText;
						}
						return {};
					},
				},
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									assistantMessage('Done.'),
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test-workdir',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			await runWithTimers(() =>
				flue.skill('code-review', {
					args: { pr: 123, repo: 'acme/widgets' },
				}),
			);

			expect(capturedPrompt).toContain(HEADLESS_PREAMBLE);
			expect(capturedPrompt).toContain('Use the code-review skill.');
			expect(capturedPrompt).toContain('"pr": 123');
			expect(capturedPrompt).toContain('"repo": "acme/widgets"');
		});

		it('uses file path instruction for path-like skill names', async () => {
			sessions.clear();
			let capturedPrompt: string | null = null;

			const customServer = createMockServer(sessions, [
				{
					method: 'POST',
					pattern: /^\/session\/([^/]+)\/prompt_async/,
					handler: (_req, match, body) => {
						const id = match[1]!;
						const state = sessions.get(id);
						if (state) {
							const parsed = JSON.parse(body);
							state.promptText = parsed.parts?.[0]?.text ?? null;
							capturedPrompt = state.promptText;
						}
						return {};
					},
				},
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									assistantMessage('Done.'),
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test-workdir',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			await runWithTimers(() => flue.skill('review/detailed.md'));

			expect(capturedPrompt).toContain('.agents/skills/review/detailed.md');
			expect(capturedPrompt).toContain('Read the file');
			expect(capturedPrompt).not.toContain('Use the review/detailed.md skill.');
		});
	});

	// -- proxy instructions ------------------------------------------------

	describe('proxy instructions', () => {
		it('includes proxy instructions in the prompt', async () => {
			sessions.clear();
			let capturedPrompt: string | null = null;

			const customServer = createMockServer(sessions, [
				{
					method: 'POST',
					pattern: /^\/session\/([^/]+)\/prompt_async/,
					handler: (_req, match, body) => {
						const id = match[1]!;
						const state = sessions.get(id);
						if (state) {
							const parsed = JSON.parse(body);
							state.promptText = parsed.parts?.[0]?.text ?? null;
							capturedPrompt = state.promptText;
						}
						return {};
					},
				},
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [userMessage('...'), assistantMessage('Done.')];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test-workdir',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
				proxies: [
					{
						name: 'github-api',
						target: 'https://api.github.com',
						instructions: 'Use `gh api` for GitHub API calls.',
					},
				],
			});

			await runWithTimers(() => flue.prompt('List open issues'));

			expect(capturedPrompt).toContain('Use `gh api` for GitHub API calls.');
		});
	});

	// -- shell() -----------------------------------------------------------

	describe('shell()', () => {
		it('delegates to the shell function with workdir default', async () => {
			const shellCalls: Array<{ cmd: string; opts: unknown }> = [];

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/my/repo',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd, opts) => {
					shellCalls.push({ cmd, opts });
					return { stdout: 'output', stderr: '', exitCode: 0 };
				},
			});

			const result = await flue.shell('git status');

			expect(shellCalls).toHaveLength(1);
			expect(shellCalls[0]!.cmd).toBe('git status');
			expect((shellCalls[0]!.opts as { cwd: string }).cwd).toBe('/my/repo');
			expect(result).toEqual({ stdout: 'output', stderr: '', exitCode: 0 });
		});

		it('passes custom cwd when provided', async () => {
			const shellCalls: Array<{ cmd: string; opts: unknown }> = [];

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/my/repo',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd, opts) => {
					shellCalls.push({ cmd, opts });
					return { stdout: '', stderr: '', exitCode: 0 };
				},
			});

			await flue.shell('ls', { cwd: '/other/dir' });

			expect((shellCalls[0]!.opts as { cwd: string }).cwd).toBe('/other/dir');
		});

		it('passes env and stdin options through', async () => {
			const shellCalls: Array<{ cmd: string; opts: unknown }> = [];

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/my/repo',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd, opts) => {
					shellCalls.push({ cmd, opts });
					return { stdout: '', stderr: '', exitCode: 0 };
				},
			});

			await flue.shell('gh issue comment 1 --body-file -', {
				stdin: 'Hello from flue',
				env: { GH_TOKEN: 'test' },
			});

			const opts = shellCalls[0]!.opts as { stdin: string; env: Record<string, string> };
			expect(opts.stdin).toBe('Hello from flue');
			expect(opts.env.GH_TOKEN).toBe('test');
		});
	});

	// -- session cleanup ---------------------------------------------------

	describe('session cleanup', () => {
		it('deletes the session after skill completes', async () => {
			sessions.clear();
			const deletedSessions: string[] = [];

			const customServer = createMockServer(sessions, [
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									assistantMessage(resultBlock('"done"')),
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
				{
					method: 'DELETE',
					pattern: /^\/session\/([^/]+)/,
					handler: (_req, match) => {
						deletedSessions.push(match[1]!);
						sessions.delete(match[1]!);
						return {};
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			await runWithTimers(() =>
				flue.skill('test', { result: v.string() }),
			);

			expect(deletedSessions).toHaveLength(1);
			expect(deletedSessions[0]).toMatch(/^test-sess-/);
		});
	});

	// -- LLM output with multiple assistant messages -----------------------

	describe('multi-message LLM output', () => {
		it('extracts result from the last assistant message across multiple turns', async () => {
			sessions.clear();

			const customServer = createMockServer(sessions, [
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									assistantMessage('Let me analyze this...'),
									assistantMessage(
										'After investigation:\n' +
											resultBlock(JSON.stringify({ status: 'resolved', fixes: 3 })),
									),
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const schema = v.object({ status: v.string(), fixes: v.number() });
			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			const result = await runWithTimers(() =>
				flue.skill('fix-bugs', { result: schema }),
			);

			expect(result).toEqual({ status: 'resolved', fixes: 3 });
		});
	});

	// -- LLM output with tool calls mixed in -------------------------------

	describe('LLM output with tool parts', () => {
		it('ignores tool parts and extracts text result', async () => {
			sessions.clear();

			const customServer = createMockServer(sessions, [
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [
									userMessage('...'),
									{
										info: { role: 'assistant' },
										parts: [
											{ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt' } },
											{ type: 'text', text: resultBlock(JSON.stringify({ files: ['file.txt'] })) },
										],
									},
								];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const schema = v.object({ files: v.array(v.string()) });
			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
			});

			const result = await runWithTimers(() =>
				flue.skill('list-files', { result: schema }),
			);

			expect(result).toEqual({ files: ['file.txt'] });
		});
	});

	// -- model override ----------------------------------------------------

	describe('model override', () => {
		it('passes model in the prompt body', async () => {
			sessions.clear();
			let capturedBody: Record<string, unknown> | null = null;

			const customServer = createMockServer(sessions, [
				{
					method: 'POST',
					pattern: /^\/session\/([^/]+)\/prompt_async/,
					handler: (_req, match, body) => {
						const id = match[1]!;
						const state = sessions.get(id);
						if (state) {
							capturedBody = JSON.parse(body);
							state.promptText = (capturedBody as any).parts?.[0]?.text ?? null;
						}
						return {};
					},
				},
				{
					method: 'GET',
					pattern: /^\/session\/status/,
					handler: () => {
						for (const [, state] of sessions) {
							if (state.messages.length === 0) {
								state.messages = [userMessage('...'), assistantMessage('Done.')];
							}
							state.statusCalls++;
						}
						const result: Record<string, { type: string }> = {};
						for (const [id, state] of sessions) {
							result[id] = { type: state.statusCalls <= 1 ? 'busy' : 'idle' };
						}
						return result;
					},
				},
			]);

			await closeServer(server);
			server = customServer;
			port = await listenOnRandomPort(server);

			const flue = new FlueClient({
				opencodeUrl: `http://127.0.0.1:${port}`,
				workdir: '/tmp/test',
				fetch: (req: Request) => fetch(req),
				shell: async (cmd) => ({ stdout: cmd, stderr: '', exitCode: 0 }),
				model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
			});

			await runWithTimers(() => flue.prompt('Hello'));

			expect(capturedBody).toMatchObject({
				model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
			});
		});
	});
});
