import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
	HEADLESS_PREAMBLE,
	buildProxyInstructions,
	buildResultExtractionPrompt,
	buildResultInstructions,
	buildSkillPrompt,
} from './prompt.ts';

describe('buildProxyInstructions', () => {
	it('returns empty string for empty array', () => {
		expect(buildProxyInstructions([])).toBe('');
	});

	it('joins instructions with newlines and double-newline prefix', () => {
		const result = buildProxyInstructions(['Use gh api.', 'Prefer curl.']);
		expect(result).toBe('\n\nUse gh api.\nPrefer curl.');
	});
});

describe('buildResultInstructions', () => {
	it('contains RESULT_START and RESULT_END delimiters', () => {
		const result = buildResultInstructions(v.string());
		expect(result).toContain('---RESULT_START---');
		expect(result).toContain('---RESULT_END---');
	});

	it('includes the JSON schema for an object', () => {
		const schema = v.object({ name: v.string() });
		const result = buildResultInstructions(schema);
		expect(result).toContain('"type"');
		expect(result).toContain('"object"');
		expect(result).toContain('"name"');
	});

	it('wraps schema in a json code fence', () => {
		const result = buildResultInstructions(v.string());
		expect(result).toContain('```json');
		expect(result).toContain('```');
	});

	it('does not include $schema meta-property', () => {
		const result = buildResultInstructions(v.string());
		expect(result).not.toContain('$schema');
	});
});

describe('buildResultExtractionPrompt', () => {
	it('includes schema instructions', () => {
		const result = buildResultExtractionPrompt(v.string());
		expect(result).toContain('---RESULT_START---');
		expect(result).toContain('Your task is complete');
	});
});

describe('buildSkillPrompt', () => {
	it('includes headless preamble', () => {
		const result = buildSkillPrompt('my-skill');
		expect(result).toContain(HEADLESS_PREAMBLE);
	});

	it('instructs to use named skill for simple name', () => {
		const result = buildSkillPrompt('triage');
		expect(result).toContain('Use the triage skill.');
	});

	it('instructs to read file for path-like skill name', () => {
		const result = buildSkillPrompt('triage/main.md');
		expect(result).toContain('.agents/skills/triage/main.md');
		expect(result).toContain('Read the file');
	});

	it('detects .md extension as file path', () => {
		const result = buildSkillPrompt('triage.md');
		expect(result).toContain('Read the file');
	});

	it('includes arguments when provided', () => {
		const result = buildSkillPrompt('triage', { issueNumber: 42 });
		expect(result).toContain('Arguments:');
		expect(result).toContain('"issueNumber": 42');
	});

	it('omits arguments section when args is empty', () => {
		const result = buildSkillPrompt('triage', {});
		expect(result).not.toContain('Arguments:');
	});

	it('omits arguments section when args is undefined', () => {
		const result = buildSkillPrompt('triage');
		expect(result).not.toContain('Arguments:');
	});

	it('includes schema instructions when schema provided', () => {
		const schema = v.object({ label: v.string() });
		const result = buildSkillPrompt('triage', undefined, schema);
		expect(result).toContain('---RESULT_START---');
		expect(result).toContain('---RESULT_END---');
		expect(result).toContain('MUST output your result');
	});

	it('includes proxy instructions when provided', () => {
		const result = buildSkillPrompt('triage', undefined, undefined, [
			'Use gh api for GitHub.',
		]);
		expect(result).toContain('Use gh api for GitHub.');
	});

	it('builds a complete prompt with all options', () => {
		const schema = v.object({ summary: v.string() });
		const result = buildSkillPrompt(
			'triage',
			{ issue: 1 },
			schema,
			['Use gh api.'],
		);
		expect(result).toContain(HEADLESS_PREAMBLE);
		expect(result).toContain('Use the triage skill.');
		expect(result).toContain('"issue": 1');
		expect(result).toContain('Use gh api.');
		expect(result).toContain('---RESULT_START---');
	});
});
