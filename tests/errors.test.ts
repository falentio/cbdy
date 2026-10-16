import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CodeBuddyRequestError, codeBuddyErrorFrom, requestErrorFrom } from '../src/errors.ts';

test('reads the gateway envelope', () => {
  const body =
    '{"code":11128,"msg":"first message is not system prompt","actions":["EDIT_INPUT"]}';
  const envelope = codeBuddyErrorFrom(body);
  assert.equal(envelope?.code, 11128);
  assert.equal(envelope?.msg, 'first message is not system prompt');
});

test('reads the upstream model adapter envelope', () => {
  const body = '{"error":{"code":"invalid_api_key","type":"Authentication","message":"bad key"}}';
  assert.equal(codeBuddyErrorFrom(body), null);

  const error = requestErrorFrom(401, body);
  assert.ok(!(error instanceof CodeBuddyRequestError), 'not a gateway envelope');
  assert.match(error.message, /CodeBuddy returned 401 with Authentication: invalid_api_key bad key/);
});

test('carries status and envelope on a gateway error', () => {
  const error = requestErrorFrom(400, '{"code":11101,"msg":"Non-stream chat request is currently not supported"}');
  assert.ok(error instanceof CodeBuddyRequestError);
  assert.equal(error.status, 400);
  assert.equal(error.code, 11101);
  assert.equal(error.envelope.msg, 'Non-stream chat request is currently not supported');
});

test('falls back to the raw body when neither envelope fits', () => {
  const error = requestErrorFrom(502, '<html>nginx</html>');
  assert.match(error.message, /CodeBuddy returned 502/);
  assert.match(error.message, /nginx/);
});

test('an empty body does not throw', () => {
  assert.equal(codeBuddyErrorFrom(''), null);
  assert.ok(requestErrorFrom(500, '') instanceof Error);
});
