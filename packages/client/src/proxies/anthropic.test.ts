import { describe, expect, it } from 'vitest';
import { anthropic } from './anthropic.ts';

describe('anthropic factory', () => {
	it('has correct secretsMap', () => {
		const factory = anthropic();
		expect(factory.secretsMap).toEqual({ apiKey: 'ANTHROPIC_API_KEY' });
	});

	it('has proxyName', () => {
		const factory = anthropic();
		expect(factory.proxyName).toBe('anthropic');
	});

	it('returns a single proxy service', () => {
		const factory = anthropic();
		const proxy = factory({ apiKey: 'sk-test-key' });
		expect(Array.isArray(proxy)).toBe(false);
	});

	it('targets api.anthropic.com', () => {
		const factory = anthropic();
		const proxy = factory({ apiKey: 'sk-test-key' }) as any;
		expect(proxy.target).toBe('https://api.anthropic.com');
	});

	it('injects x-api-key header', () => {
		const factory = anthropic();
		const proxy = factory({ apiKey: 'sk-test-key' }) as any;
		expect(proxy.headers['x-api-key']).toBe('sk-test-key');
	});

	it('is marked as model provider', () => {
		const factory = anthropic();
		const proxy = factory({ apiKey: 'sk-test-key' }) as any;
		expect(proxy.isModelProvider).toBe(true);
	});

	it('has anthropic provider config', () => {
		const factory = anthropic();
		const proxy = factory({ apiKey: 'sk-test-key' }) as any;
		expect(proxy.providerConfig.providerKey).toBe('anthropic');
		expect(proxy.providerConfig.options.apiKey).toContain('dummy');
	});

	it('defaults to allow-all policy', () => {
		const factory = anthropic();
		const proxy = factory({ apiKey: 'sk-test-key' }) as any;
		expect(proxy.policy).toBe('allow-all');
	});

	it('accepts custom policy', () => {
		const factory = anthropic({ policy: 'deny-all' });
		const proxy = factory({ apiKey: 'sk-test-key' }) as any;
		expect(proxy.policy).toBe('deny-all');
	});

	describe('header transform', () => {
		it('filters to allowlisted headers only', () => {
			const factory = anthropic();
			const proxy = factory({ apiKey: 'sk-test-key' }) as any;
			const result = proxy.transform({
				method: 'POST',
				url: '/v1/messages',
				headers: {
					'content-type': 'application/json',
					'content-length': '100',
					accept: 'application/json',
					'anthropic-version': '2024-01-01',
					'anthropic-beta': 'messages-2024',
					'user-agent': 'flue/1.0',
					'x-custom-header': 'should-be-stripped',
					cookie: 'should-be-stripped',
					authorization: 'should-be-stripped',
				},
			});

			expect(result.headers['content-type']).toBe('application/json');
			expect(result.headers['content-length']).toBe('100');
			expect(result.headers['accept']).toBe('application/json');
			expect(result.headers['anthropic-version']).toBe('2024-01-01');
			expect(result.headers['anthropic-beta']).toBe('messages-2024');
			expect(result.headers['user-agent']).toBe('flue/1.0');
			expect(result.headers['x-custom-header']).toBeUndefined();
			expect(result.headers['cookie']).toBeUndefined();
			expect(result.headers['authorization']).toBeUndefined();
		});

		it('always injects x-api-key', () => {
			const factory = anthropic();
			const proxy = factory({ apiKey: 'sk-real-key' }) as any;
			const result = proxy.transform({
				method: 'POST',
				url: '/v1/messages',
				headers: {},
			});
			expect(result.headers['x-api-key']).toBe('sk-real-key');
		});
	});
});
