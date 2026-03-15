import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { SkillOutputError } from './errors.ts';
import { extractResult } from './result.ts';

function textPart(text: string) {
	return { type: 'text' as const, text };
}

describe('extractResult', () => {
	describe('extractLastResultBlock (via extractResult)', () => {
		it('extracts a simple string result', () => {
			const parts = [
				textPart('Here is the answer:\n---RESULT_START---\nhello world\n---RESULT_END---'),
			];
			const result = extractResult(parts, v.string(), 'sess-1');
			expect(result).toBe('hello world');
		});

		it('extracts the last block when multiple exist', () => {
			const parts = [
				textPart(
					'---RESULT_START---\nfirst\n---RESULT_END---\n' +
						'---RESULT_START---\nsecond\n---RESULT_END---',
				),
			];
			const result = extractResult(parts, v.string(), 'sess-1');
			expect(result).toBe('second');
		});

		it('combines text from multiple parts', () => {
			const parts = [
				textPart('Some preamble\n---RESULT_START---\n'),
				textPart('combined result\n---RESULT_END---'),
			];
			const result = extractResult(parts, v.string(), 'sess-1');
			expect(result).toBe('combined result');
		});

		it('throws SkillOutputError when no result block found', () => {
			const parts = [textPart('No result here')];
			expect(() => extractResult(parts, v.string(), 'sess-1')).toThrow(SkillOutputError);
		});

		it('throws SkillOutputError for empty parts', () => {
			expect(() => extractResult([], v.string(), 'sess-1')).toThrow(SkillOutputError);
		});

		it('trims whitespace from the extracted block', () => {
			const parts = [
				textPart('---RESULT_START---\n  trimmed  \n---RESULT_END---'),
			];
			const result = extractResult(parts, v.string(), 'sess-1');
			expect(result).toBe('trimmed');
		});
	});

	describe('JSON schema validation', () => {
		it('parses and validates an object result', () => {
			const schema = v.object({ name: v.string(), count: v.number() });
			const parts = [
				textPart(
					'---RESULT_START---\n{"name": "test", "count": 42}\n---RESULT_END---',
				),
			];
			const result = extractResult(parts, schema, 'sess-1');
			expect(result).toEqual({ name: 'test', count: 42 });
		});

		it('parses and validates an array result', () => {
			const schema = v.array(v.string());
			const parts = [
				textPart('---RESULT_START---\n["a", "b", "c"]\n---RESULT_END---'),
			];
			const result = extractResult(parts, schema, 'sess-1');
			expect(result).toEqual(['a', 'b', 'c']);
		});

		it('throws SkillOutputError for invalid JSON in object schema', () => {
			const schema = v.object({ name: v.string() });
			const parts = [textPart('---RESULT_START---\nnot json\n---RESULT_END---')];
			expect(() => extractResult(parts, schema, 'sess-1')).toThrow(SkillOutputError);
		});

		it('throws SkillOutputError when schema validation fails', () => {
			const schema = v.object({ name: v.string(), count: v.number() });
			const parts = [
				textPart(
					'---RESULT_START---\n{"name": "test", "count": "not a number"}\n---RESULT_END---',
				),
			];
			expect(() => extractResult(parts, schema, 'sess-1')).toThrow(SkillOutputError);
		});

		it('validates string schema without JSON parsing', () => {
			const parts = [
				textPart('---RESULT_START---\nplain text result\n---RESULT_END---'),
			];
			const result = extractResult(parts, v.string(), 'sess-1');
			expect(result).toBe('plain text result');
		});
	});

	describe('error details', () => {
		it('includes sessionId in error', () => {
			try {
				extractResult([], v.string(), 'sess-42');
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(SkillOutputError);
				expect((e as SkillOutputError).sessionId).toBe('sess-42');
			}
		});

		it('includes rawOutput in error for schema validation failure', () => {
			const schema = v.object({ x: v.number() });
			const parts = [
				textPart('---RESULT_START---\n{"x": "wrong"}\n---RESULT_END---'),
			];
			try {
				extractResult(parts, schema, 'sess-1');
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(SkillOutputError);
				expect((e as SkillOutputError).rawOutput).toBeDefined();
			}
		});
	});
});
