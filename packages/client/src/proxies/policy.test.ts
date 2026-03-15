import { describe, expect, it } from 'vitest';
import { evaluatePolicy, matchMethod, matchPath } from './policy.ts';
import type { ProxyPolicy } from './types.ts';

// -- matchPath ---------------------------------------------------------------

describe('matchPath', () => {
	it('matches exact literal paths', () => {
		expect(matchPath('/repos/owner/repo', '/repos/owner/repo')).toBe(true);
	});

	it('rejects non-matching literals', () => {
		expect(matchPath('/repos/owner/repo', '/repos/owner/other')).toBe(false);
	});

	it('matches single * wildcard for one segment', () => {
		expect(matchPath('/repos/*/issues', '/repos/myrepo/issues')).toBe(true);
	});

	it('single * does not match multiple segments', () => {
		expect(matchPath('/repos/*/issues', '/repos/owner/repo/issues')).toBe(false);
	});

	it('matches multiple * wildcards', () => {
		expect(matchPath('/repos/*/issues/*/comments', '/repos/myrepo/issues/42/comments')).toBe(
			true,
		);
	});

	it('rejects when path has extra trailing segments', () => {
		expect(matchPath('/repos/*/issues', '/repos/myrepo/issues/42')).toBe(false);
	});

	it('rejects when path is shorter than pattern', () => {
		expect(matchPath('/repos/*/issues/*/comments', '/repos/myrepo/issues')).toBe(false);
	});

	it('** matches zero segments', () => {
		expect(matchPath('/**/info/refs', '/info/refs')).toBe(true);
	});

	it('** matches one segment', () => {
		expect(matchPath('/**/info/refs', '/owner/info/refs')).toBe(true);
	});

	it('** matches multiple segments', () => {
		expect(matchPath('/**/git-upload-pack', '/owner/repo/git-upload-pack')).toBe(true);
	});

	it('** at the end matches remaining segments', () => {
		expect(matchPath('/repos/**', '/repos/owner/repo/issues')).toBe(true);
	});

	it('** at the end matches zero remaining segments', () => {
		expect(matchPath('/repos/**', '/repos')).toBe(true);
	});

	it('handles mixed * and **', () => {
		expect(matchPath('/repos/**/issues/*/comments', '/repos/owner/repo/issues/42/comments')).toBe(
			true,
		);
	});

	it('handles leading slashes consistently', () => {
		expect(matchPath('repos/*/issues', 'repos/myrepo/issues')).toBe(true);
	});

	it('handles trailing slashes consistently', () => {
		expect(matchPath('/repos/', '/repos/')).toBe(true);
	});

	it('** does not match when following literal fails', () => {
		expect(matchPath('/**/secret', '/a/b/c/public')).toBe(false);
	});
});

// -- matchMethod -------------------------------------------------------------

describe('matchMethod', () => {
	it('matches exact method (same case)', () => {
		expect(matchMethod('GET', 'GET')).toBe(true);
	});

	it('matches method case-insensitively', () => {
		expect(matchMethod('POST', 'post')).toBe(true);
		expect(matchMethod('get', 'GET')).toBe(true);
	});

	it('rejects non-matching method', () => {
		expect(matchMethod('GET', 'POST')).toBe(false);
	});

	it('wildcard * matches any method', () => {
		expect(matchMethod('*', 'GET')).toBe(true);
		expect(matchMethod('*', 'DELETE')).toBe(true);
	});

	it('matches array of methods', () => {
		expect(matchMethod(['GET', 'HEAD'], 'GET')).toBe(true);
		expect(matchMethod(['GET', 'HEAD'], 'HEAD')).toBe(true);
	});

	it('rejects method not in array', () => {
		expect(matchMethod(['GET', 'HEAD'], 'POST')).toBe(false);
	});

	it('array matching is case-insensitive', () => {
		expect(matchMethod(['get', 'head'], 'GET')).toBe(true);
	});
});

// -- evaluatePolicy ----------------------------------------------------------

describe('evaluatePolicy', () => {
	describe('null policy (default allow-read)', () => {
		it('allows GET', () => {
			expect(evaluatePolicy('GET', '/anything', null, null)).toEqual({
				allowed: true,
				reason: '',
			});
		});

		it('allows HEAD', () => {
			expect(evaluatePolicy('HEAD', '/anything', null, null)).toEqual({
				allowed: true,
				reason: '',
			});
		});

		it('allows OPTIONS', () => {
			expect(evaluatePolicy('OPTIONS', '/anything', null, null)).toEqual({
				allowed: true,
				reason: '',
			});
		});

		it('denies POST', () => {
			const result = evaluatePolicy('POST', '/anything', null, null);
			expect(result.allowed).toBe(false);
		});

		it('denies DELETE', () => {
			const result = evaluatePolicy('DELETE', '/anything', null, null);
			expect(result.allowed).toBe(false);
		});
	});

	describe('base: allow-all', () => {
		const policy: ProxyPolicy = { base: 'allow-all' };

		it('allows any method', () => {
			expect(evaluatePolicy('POST', '/anything', null, policy).allowed).toBe(true);
			expect(evaluatePolicy('DELETE', '/anything', null, policy).allowed).toBe(true);
		});
	});

	describe('base: deny-all', () => {
		const policy: ProxyPolicy = { base: 'deny-all' };

		it('denies GET', () => {
			expect(evaluatePolicy('GET', '/anything', null, policy).allowed).toBe(false);
		});

		it('denies POST', () => {
			expect(evaluatePolicy('POST', '/anything', null, policy).allowed).toBe(false);
		});
	});

	describe('base: allow-read (explicit)', () => {
		const policy: ProxyPolicy = { base: 'allow-read' };

		it('allows GET', () => {
			expect(evaluatePolicy('GET', '/repos', null, policy).allowed).toBe(true);
		});

		it('denies POST', () => {
			expect(evaluatePolicy('POST', '/repos', null, policy).allowed).toBe(false);
		});
	});

	describe('deny rules take priority', () => {
		const policy: ProxyPolicy = {
			base: 'allow-all',
			deny: [{ method: 'DELETE', path: '/**' }],
		};

		it('denies matching deny rule even with allow-all base', () => {
			expect(evaluatePolicy('DELETE', '/repos/foo', null, policy).allowed).toBe(false);
		});

		it('still allows non-matching methods', () => {
			expect(evaluatePolicy('GET', '/repos/foo', null, policy).allowed).toBe(true);
		});
	});

	describe('allow rules', () => {
		const policy: ProxyPolicy = {
			base: 'deny-all',
			allow: [{ method: 'POST', path: '/repos/*/issues/*/comments' }],
		};

		it('allows matching allow rule', () => {
			expect(
				evaluatePolicy('POST', '/repos/myrepo/issues/42/comments', null, policy).allowed,
			).toBe(true);
		});

		it('denies non-matching path', () => {
			expect(evaluatePolicy('POST', '/repos/myrepo/pulls', null, policy).allowed).toBe(false);
		});

		it('denies non-matching method', () => {
			expect(
				evaluatePolicy('GET', '/repos/myrepo/issues/42/comments', null, policy).allowed,
			).toBe(false);
		});
	});

	describe('body validators', () => {
		const policy: ProxyPolicy = {
			base: 'deny-all',
			allow: [
				{
					method: 'POST',
					path: '/graphql',
					body: (b: unknown) => {
						const body = b as { query?: string };
						return typeof body?.query === 'string' && !body.query.startsWith('mutation');
					},
				},
			],
		};

		it('allows when body validator returns true', () => {
			expect(evaluatePolicy('POST', '/graphql', { query: 'query { viewer }' }, policy).allowed).toBe(true);
		});

		it('falls through when body validator returns false', () => {
			expect(
				evaluatePolicy('POST', '/graphql', { query: 'mutation { delete }' }, policy).allowed,
			).toBe(false);
		});
	});

	describe('deny rules with body validators', () => {
		const policy: ProxyPolicy = {
			base: 'allow-all',
			deny: [
				{
					method: 'POST',
					path: '/graphql',
					body: (b: unknown) => {
						const body = b as { query?: string };
						return typeof body?.query === 'string' && body.query.startsWith('mutation');
					},
				},
			],
		};

		it('denies when deny body validator returns true', () => {
			expect(
				evaluatePolicy('POST', '/graphql', { query: 'mutation { x }' }, policy).allowed,
			).toBe(false);
		});

		it('allows when deny body validator returns false', () => {
			expect(
				evaluatePolicy('POST', '/graphql', { query: 'query { viewer }' }, policy).allowed,
			).toBe(true);
		});
	});

	describe('rate limits', () => {
		it('allows requests within the limit', () => {
			const policy: ProxyPolicy = {
				base: 'deny-all',
				allow: [{ method: 'POST', path: '/comments', limit: 3 }],
			};
			const counts = new Map<string, number>();

			expect(evaluatePolicy('POST', '/comments', null, policy, counts).allowed).toBe(true);
			expect(evaluatePolicy('POST', '/comments', null, policy, counts).allowed).toBe(true);
			expect(evaluatePolicy('POST', '/comments', null, policy, counts).allowed).toBe(true);
		});

		it('denies requests exceeding the limit', () => {
			const policy: ProxyPolicy = {
				base: 'deny-all',
				allow: [{ method: 'POST', path: '/comments', limit: 2 }],
			};
			const counts = new Map<string, number>();

			evaluatePolicy('POST', '/comments', null, policy, counts);
			evaluatePolicy('POST', '/comments', null, policy, counts);
			const result = evaluatePolicy('POST', '/comments', null, policy, counts);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('limit reached');
		});

		it('does not enforce limits when ruleCounts is omitted', () => {
			const policy: ProxyPolicy = {
				base: 'deny-all',
				allow: [{ method: 'POST', path: '/comments', limit: 1 }],
			};

			expect(evaluatePolicy('POST', '/comments', null, policy).allowed).toBe(true);
			expect(evaluatePolicy('POST', '/comments', null, policy).allowed).toBe(true);
		});
	});

	describe('deny > allow > base evaluation order', () => {
		const policy: ProxyPolicy = {
			base: 'allow-read',
			allow: [{ method: 'POST', path: '/allowed' }],
			deny: [{ method: 'POST', path: '/allowed' }],
		};

		it('deny wins over allow for the same path', () => {
			expect(evaluatePolicy('POST', '/allowed', null, policy).allowed).toBe(false);
		});
	});
});
