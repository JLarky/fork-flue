import { describe, expect, it } from 'vitest';
import { github, githubBody } from './github.ts';

describe('github factory', () => {
	it('has correct secretsMap', () => {
		const factory = github();
		expect(factory.secretsMap).toEqual({ token: 'GITHUB_TOKEN' });
	});

	it('has proxyName', () => {
		const factory = github();
		expect(factory.proxyName).toBe('github');
	});

	it('returns two proxies (api + git)', () => {
		const factory = github();
		const proxies = factory({ token: 'ghp_test123' });
		expect(Array.isArray(proxies)).toBe(true);
		expect(proxies).toHaveLength(2);
	});

	it('creates github-api proxy with correct config', () => {
		const factory = github();
		const proxies = factory({ token: 'ghp_test123' }) as any[];
		const api = proxies.find((p) => p.name === 'github-api');
		expect(api).toBeDefined();
		expect(api.target).toBe('https://api.github.com');
		expect(api.headers.authorization).toBe('token ghp_test123');
		expect(api.socket).toBe(true);
	});

	it('creates github-git proxy with Basic auth', () => {
		const factory = github();
		const proxies = factory({ token: 'ghp_test123' }) as any[];
		const git = proxies.find((p) => p.name === 'github-git');
		expect(git).toBeDefined();
		expect(git.target).toBe('https://github.com');
		const expected = Buffer.from(`x-access-token:ghp_test123`).toString('base64');
		expect(git.headers.authorization).toBe(`Basic ${expected}`);
	});

	it('uses allow-read policy by default', () => {
		const factory = github();
		const proxies = factory({ token: 'test' }) as any[];
		const api = proxies[0];
		expect(api.policy.base).toBe('allow-read');
	});

	it('includes default GraphQL and git allow rules for allow-read', () => {
		const factory = github();
		const proxies = factory({ token: 'test' }) as any[];
		const api = proxies[0];
		const paths = api.policy.allow.map((r: any) => r.path);
		expect(paths).toContain('/graphql');
		expect(paths).toContain('/**/git-upload-pack');
		expect(paths).toContain('/**/info/refs');
	});

	it('respects allow-all policy', () => {
		const factory = github({ policy: 'allow-all' });
		const proxies = factory({ token: 'test' }) as any[];
		expect(proxies[0].policy.base).toBe('allow-all');
	});

	it('respects deny-all policy', () => {
		const factory = github({ policy: 'deny-all' });
		const proxies = factory({ token: 'test' }) as any[];
		expect(proxies[0].policy.base).toBe('deny-all');
	});

	it('merges user allow rules with defaults for allow-read', () => {
		const factory = github({
			policy: {
				base: 'allow-read',
				allow: [{ method: 'POST', path: '/repos/*/issues' }],
			},
		});
		const proxies = factory({ token: 'test' }) as any[];
		const paths = proxies[0].policy.allow.map((r: any) => r.path);
		expect(paths).toContain('/graphql');
		expect(paths).toContain('/repos/*/issues');
	});

	it('includes deny rules from user', () => {
		const factory = github({
			policy: {
				base: 'allow-read',
				deny: [{ method: 'DELETE', path: '/**' }],
			},
		});
		const proxies = factory({ token: 'test' }) as any[];
		expect(proxies[0].policy.deny).toHaveLength(1);
		expect(proxies[0].policy.deny[0].method).toBe('DELETE');
	});

	it('provides denyResponse on both proxies', () => {
		const factory = github();
		const proxies = factory({ token: 'test' }) as any[];
		for (const proxy of proxies) {
			expect(proxy.denyResponse).toBeTypeOf('function');
			const resp = proxy.denyResponse({ method: 'DELETE', path: '/x', reason: 'denied' });
			expect(resp.status).toBe(403);
			expect(JSON.parse(resp.body).message).toContain('Blocked');
		}
	});
});

describe('githubBody.graphql', () => {
	it('allows a query', () => {
		const validator = githubBody.graphql();
		expect(validator({ query: 'query { viewer { login } }' })).toBe(true);
	});

	it('denies a mutation by default', () => {
		const validator = githubBody.graphql();
		expect(validator({ query: 'mutation { createIssue { id } }' })).toBe(false);
	});

	it('denies when query is missing', () => {
		const validator = githubBody.graphql();
		expect(validator({})).toBe(false);
		expect(validator(null)).toBe(false);
	});

	it('denies when query is not a string', () => {
		const validator = githubBody.graphql();
		expect(validator({ query: 123 })).toBe(false);
	});

	it('filters by allowedOperations', () => {
		const validator = githubBody.graphql({ allowedOperations: ['GetIssue'] });
		expect(validator({ query: 'query GetIssue { issue { id } }', operationName: 'GetIssue' })).toBe(true);
		expect(validator({ query: 'query Other { x }', operationName: 'Other' })).toBe(false);
	});

	it('denies when operationName is missing with allowedOperations', () => {
		const validator = githubBody.graphql({ allowedOperations: ['GetIssue'] });
		expect(validator({ query: 'query { viewer }' })).toBe(false);
	});

	it('allows mutations when denyMutations is false', () => {
		const validator = githubBody.graphql({ denyMutations: false });
		expect(validator({ query: 'mutation { createIssue { id } }' })).toBe(true);
	});
});
