import { describe, expect, it } from 'vitest';
import { transformEvent } from './events.ts';

describe('transformEvent', () => {
	it('returns null for null/undefined input', () => {
		expect(transformEvent(null)).toBeNull();
		expect(transformEvent(undefined)).toBeNull();
	});

	it('returns null for events without a type', () => {
		expect(transformEvent({})).toBeNull();
		expect(transformEvent({ properties: {} })).toBeNull();
	});

	it('returns null for unrecognized event types', () => {
		expect(transformEvent({ type: 'unknown.event' })).toBeNull();
	});

	describe('tool events (message.part.updated)', () => {
		const baseTool = {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'tool',
					sessionID: 'sess-1',
					tool: 'bash',
					state: {},
				},
			},
		};

		it('transforms pending tool', () => {
			const raw = {
				...baseTool,
				properties: {
					part: {
						...baseTool.properties.part,
						state: { status: 'pending', input: { command: 'ls -la' } },
					},
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				sessionId: 'sess-1',
				type: 'tool.pending',
				tool: 'bash',
				input: 'ls -la',
			});
		});

		it('transforms running tool', () => {
			const raw = {
				...baseTool,
				properties: {
					part: {
						...baseTool.properties.part,
						state: { status: 'running', input: { filePath: '/src/index.ts' } },
					},
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'tool.running',
				tool: 'bash',
				input: '/src/index.ts',
			});
		});

		it('transforms completed tool with duration', () => {
			const raw = {
				...baseTool,
				properties: {
					part: {
						...baseTool.properties.part,
						state: {
							status: 'completed',
							input: { command: 'echo hi' },
							output: 'hi',
							time: { start: 1000, end: 2500 },
						},
					},
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'tool.complete',
				tool: 'bash',
				input: 'echo hi',
				output: 'hi',
				duration: 1500,
			});
		});

		it('transforms error tool', () => {
			const raw = {
				...baseTool,
				properties: {
					part: {
						...baseTool.properties.part,
						state: {
							status: 'error',
							input: { command: 'bad-cmd' },
							error: 'command not found',
							time: { start: 100, end: 200 },
						},
					},
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'tool.error',
				tool: 'bash',
				error: 'command not found',
				duration: 100,
			});
		});

		it('defaults duration to 0 when time is missing', () => {
			const raw = {
				...baseTool,
				properties: {
					part: {
						...baseTool.properties.part,
						state: { status: 'completed', input: {}, output: 'ok' },
					},
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'tool.complete', duration: 0 });
		});

		it('returns null when part has no state', () => {
			const raw = {
				type: 'message.part.updated',
				properties: {
					part: { type: 'tool', sessionID: 'sess-1', tool: 'bash' },
				},
			};
			expect(transformEvent(raw)).toBeNull();
		});

		it('returns null for unknown tool status', () => {
			const raw = {
				...baseTool,
				properties: {
					part: {
						...baseTool.properties.part,
						state: { status: 'unknown-status', input: {} },
					},
				},
			};
			expect(transformEvent(raw)).toBeNull();
		});
	});

	describe('tool input summarization', () => {
		function makeToolEvent(input: Record<string, unknown>) {
			return {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'tool',
						sessionID: 's',
						tool: 'mytool',
						state: { status: 'pending', input },
					},
				},
			};
		}

		it('summarizes command input', () => {
			const event = transformEvent(makeToolEvent({ command: 'npm install' }));
			expect(event?.type === 'tool.pending' && event.input).toBe('npm install');
		});

		it('summarizes filePath input', () => {
			const event = transformEvent(makeToolEvent({ filePath: '/src/main.ts' }));
			expect(event?.type === 'tool.pending' && event.input).toBe('/src/main.ts');
		});

		it('summarizes pattern input', () => {
			const event = transformEvent(makeToolEvent({ pattern: '**/*.ts' }));
			expect(event?.type === 'tool.pending' && event.input).toBe('**/*.ts');
		});

		it('summarizes url input', () => {
			const event = transformEvent(makeToolEvent({ url: 'https://example.com' }));
			expect(event?.type === 'tool.pending' && event.input).toBe('https://example.com');
		});

		it('summarizes name input', () => {
			const event = transformEvent(makeToolEvent({ name: 'my-skill' }));
			expect(event?.type === 'tool.pending' && event.input).toBe('my-skill');
		});

		it('falls back to tool name for unknown input shape', () => {
			const event = transformEvent(makeToolEvent({ foo: 'bar' }));
			expect(event?.type === 'tool.pending' && event.input).toBe('mytool');
		});

		it('truncates long command input to 500 chars', () => {
			const longCmd = 'x'.repeat(600);
			const event = transformEvent(makeToolEvent({ command: longCmd }));
			expect(event?.type === 'tool.pending' && event.input.length).toBe(500);
		});
	});

	describe('text events', () => {
		it('transforms text delta', () => {
			const raw = {
				type: 'message.part.updated',
				properties: {
					part: { type: 'text', sessionID: 'sess-1', text: 'full text' },
					delta: 'delta text',
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'text',
				text: 'delta text',
				sessionId: 'sess-1',
			});
		});

		it('falls back to part.text when no delta', () => {
			const raw = {
				type: 'message.part.updated',
				properties: {
					part: { type: 'text', sessionID: 'sess-1', text: 'full text' },
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'text', text: 'full text' });
		});

		it('returns null for empty text', () => {
			const raw = {
				type: 'message.part.updated',
				properties: {
					part: { type: 'text', sessionID: 'sess-1', text: '' },
				},
			};
			expect(transformEvent(raw)).toBeNull();
		});
	});

	describe('step events', () => {
		it('transforms step-start', () => {
			const raw = {
				type: 'message.part.updated',
				properties: {
					part: { type: 'step-start', sessionID: 'sess-1' },
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'step.start', sessionId: 'sess-1' });
		});

		it('transforms step-finish with tokens and cost', () => {
			const raw = {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'step-finish',
						sessionID: 'sess-1',
						reason: 'end_turn',
						tokens: { input: 1000, output: 500 },
						cost: 0.05,
					},
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'step.finish',
				reason: 'end_turn',
				tokens: { input: 1000, output: 500 },
				cost: 0.05,
			});
		});

		it('defaults step-finish fields', () => {
			const raw = {
				type: 'message.part.updated',
				properties: {
					part: { type: 'step-finish', sessionID: 'sess-1' },
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'step.finish',
				reason: '',
				tokens: { input: 0, output: 0 },
				cost: 0,
			});
		});
	});

	describe('session status events', () => {
		it('transforms session.status busy', () => {
			const raw = {
				type: 'session.status',
				properties: { sessionID: 'sess-1', status: { type: 'busy' } },
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'status', status: 'busy' });
		});

		it('transforms session.status idle', () => {
			const raw = {
				type: 'session.status',
				properties: { sessionID: 'sess-1', status: { type: 'idle' } },
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'status', status: 'idle' });
		});

		it('transforms session.status retry with message', () => {
			const raw = {
				type: 'session.status',
				properties: {
					sessionID: 'sess-1',
					status: { type: 'retry', message: 'rate limited' },
				},
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'status',
				status: 'retry',
				message: 'rate limited',
			});
		});

		it('returns null for unknown session status', () => {
			const raw = {
				type: 'session.status',
				properties: { sessionID: 'sess-1', status: { type: 'unknown' } },
			};
			expect(transformEvent(raw)).toBeNull();
		});
	});

	describe('standalone session events', () => {
		it('transforms session.idle', () => {
			const raw = {
				type: 'session.idle',
				properties: { sessionID: 'sess-1' },
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'status', status: 'idle' });
		});

		it('transforms session.compacted', () => {
			const raw = {
				type: 'session.compacted',
				properties: { sessionID: 'sess-1' },
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'status', status: 'compacted' });
		});
	});

	describe('error events', () => {
		it('transforms session.error with string error', () => {
			const raw = {
				type: 'session.error',
				properties: { sessionID: 'sess-1', error: 'something broke' },
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({
				type: 'error',
				message: 'something broke',
			});
		});

		it('transforms session.error with object error', () => {
			const raw = {
				type: 'session.error',
				properties: { sessionID: 'sess-1', error: { code: 500, msg: 'fail' } },
			};
			const event = transformEvent(raw);
			expect(event?.type === 'error' && event.message).toContain('500');
		});

		it('defaults to "unknown error" when error is missing', () => {
			const raw = {
				type: 'session.error',
				properties: { sessionID: 'sess-1' },
			};
			const event = transformEvent(raw);
			expect(event).toMatchObject({ type: 'error', message: 'unknown error' });
		});
	});

	describe('timestamp', () => {
		it('includes a numeric timestamp on all events', () => {
			const raw = {
				type: 'session.idle',
				properties: { sessionID: 'sess-1' },
			};
			const event = transformEvent(raw);
			expect(event?.timestamp).toBeTypeOf('number');
			expect(event!.timestamp).toBeGreaterThan(0);
		});
	});
});
