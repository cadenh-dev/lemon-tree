import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyPrompt } from '../src/main/process-bridge/classify-prompt.ts'
import type { PromptIntent } from '../src/shared/contracts.ts'

const cases: ReadonlyArray<{ prompt: string; expected: PromptIntent }> = [
  {
    prompt: 'Review the security of the login flow across all modules',
    expected: {
      role: 'review', depth: 4,
      evidence: ['role:review keyword "review"', 'depth:+1 breadth "across"', 'depth:+1 risk "security"']
    }
  },
  { prompt: 'Review and then fix the parser', expected: { role: 'review', depth: 2, evidence: ['role:review keyword "review"'] } },
  {
    prompt: 'Audit the multiple retry paths',
    expected: { role: 'review', depth: 3, evidence: ['role:review keyword "audit"', 'depth:+1 breadth "multiple"'] }
  },
  // A phrase keyword is evidence as one string.
  {
    prompt: 'Look over the schema definition',
    expected: { role: 'review', depth: 3, evidence: ['role:review keyword "look over"', 'depth:+1 risk "schema"'] }
  },
  { prompt: 'Write tests for the parser', expected: { role: 'test', depth: 2, evidence: ['role:test keyword "write tests"'] } },
  {
    prompt: 'Add tests for the migration path',
    expected: { role: 'test', depth: 3, evidence: ['role:test keyword "add tests"', 'depth:+1 risk "migration"'] }
  },
  // 'add a failing test' does not contain the phrase 'add a test'.
  { prompt: 'Add a failing test for the empty input', expected: { role: 'test', depth: 2, evidence: ['role:test keyword "failing test"'] } },
  {
    prompt: 'Reproduce the failing test across all modules',
    expected: { role: 'test', depth: 3, evidence: ['role:test keyword "reproduce"', 'depth:+1 breadth "across"'] }
  },
  {
    prompt: 'Research the protocol options for the relay',
    expected: { role: 'research', depth: 3, evidence: ['role:research keyword "research"', 'depth:+1 risk "protocol"'] }
  },
  { prompt: 'What is the difference between the two daemon modes', expected: { role: 'research', depth: 2, evidence: ['role:research keyword "what is"'] } },
  {
    prompt: 'Compare every harness manifest',
    expected: { role: 'research', depth: 3, evidence: ['role:research keyword "compare"', 'depth:+1 breadth "every"'] }
  },
  { prompt: 'Design the authentication flow', expected: { role: 'design', depth: 2, evidence: ['role:design keyword "design"'] } },
  {
    prompt: 'Weigh the trade-off between the two protocol versions',
    expected: { role: 'design', depth: 3, evidence: ['role:design keyword "trade-off"', 'depth:+1 risk "protocol"'] }
  },
  {
    prompt: 'Plan the migration of the schema',
    expected: { role: 'design', depth: 3, evidence: ['role:design keyword "plan"', 'depth:+1 risk "migration"'] }
  },
  {
    prompt: 'Fix the typo in the README',
    expected: { role: 'implementation', depth: 1, evidence: ['role:implementation keyword "fix"', 'depth:-1 small "typo"'] }
  },
  {
    prompt: 'Update the wording in the dialog',
    expected: { role: 'implementation', depth: 1, evidence: ['role:implementation keyword "update"', 'depth:-1 small "wording"'] }
  },
  {
    prompt: 'Implement the daemon across all platforms',
    expected: { role: 'implementation', depth: 3, evidence: ['role:implementation keyword "implement"', 'depth:+1 breadth "across"'] }
  },
  // Breadth and risk add one each, and the small word subtracts one.
  {
    prompt: 'Migrate the schema to the new format',
    expected: {
      role: 'implementation', depth: 3,
      evidence: ['role:implementation keyword "migrate"', 'depth:+1 breadth "migrate"', 'depth:+1 risk "schema"', 'depth:-1 small "format"']
    }
  },
  {
    prompt: 'Create the config schema for every module',
    expected: {
      role: 'implementation', depth: 4,
      evidence: ['role:implementation keyword "create"', 'depth:+1 breadth "every"', 'depth:+1 risk "schema"']
    }
  },
  {
    prompt: 'Refactor the protocol parser.\n- move the tokenizer\n- split the reader\n- update the docs',
    expected: {
      role: 'implementation', depth: 5,
      evidence: ['role:implementation keyword "refactor"', 'depth:+1 breadth "refactor"', 'depth:+1 risk "protocol"', 'depth:+1 size']
    }
  },
  { prompt: 'Please address the feedback', expected: { role: 'general', depth: 2, evidence: ['role:general no keyword'] } },
  { prompt: 'Ship it on Monday', expected: { role: 'general', depth: 2, evidence: ['role:general no keyword'] } },
  {
    prompt: 'Prepare the release notes.\n- list the fixes\n- list the changes\n- list the credits',
    expected: { role: 'general', depth: 3, evidence: ['role:general no keyword', 'depth:+1 size'] }
  }
]

test('the table gives each prompt its role, depth, and evidence', () => {
  for (const { prompt, expected } of cases) assert.deepEqual(classifyPrompt(prompt), expected, prompt)
})

test('a small fix is implementation at depth 1', () => {
  assert.deepEqual(classifyPrompt('Fix the typo in the README'), {
    role: 'implementation',
    depth: 1,
    evidence: ['role:implementation keyword "fix"', 'depth:-1 small "typo"']
  })
})

test('breadth and risk words raise the depth of a review', () => {
  const intent = classifyPrompt('Review the security of the login flow across all modules')
  assert.equal(intent.role, 'review')
  assert.equal(intent.depth, 4)
  assert.deepEqual(intent.evidence, ['role:review keyword "review"', 'depth:+1 breadth "across"', 'depth:+1 risk "security"'])
})

test('a keyword inside a longer word does not match', () => {
  assert.deepEqual(classifyPrompt('Please address the feedback'), {
    role: 'general',
    depth: 2,
    evidence: ['role:general no keyword']
  })
})

test('the first role rule with a match decides the role', () => {
  assert.equal(classifyPrompt('Review and then fix the parser').role, 'review')
})

test('the depth stays inside 1 to 5', () => {
  assert.equal(classifyPrompt('Refactor the protocol parser.\n- move the tokenizer\n- split the reader\n- update the docs').depth, 5)
  assert.equal(classifyPrompt('Fix the typo').depth, 1)
})

test('an empty or whitespace prompt is general at depth 1', () => {
  for (const prompt of ['', ' ', '\n\t  \n']) {
    assert.deepEqual(classifyPrompt(prompt), { role: 'general', depth: 1, evidence: ['empty prompt'] }, JSON.stringify(prompt))
  }
})

test('the size rule needs three list lines and accepts each marker', () => {
  assert.deepEqual(classifyPrompt('Prepare the notes.\n- first\n- second'), {
    role: 'general', depth: 2, evidence: ['role:general no keyword']
  })
  assert.deepEqual(classifyPrompt('Prepare the notes.\n- first\n* second\n1. third'), {
    role: 'general', depth: 3, evidence: ['role:general no keyword', 'depth:+1 size']
  })
})

test('a prompt longer than 600 characters adds the size step', () => {
  assert.deepEqual(classifyPrompt('Update the parser. '.repeat(40).trim()), {
    role: 'implementation', depth: 3, evidence: ['role:implementation keyword "update"', 'depth:+1 size']
  })
})
