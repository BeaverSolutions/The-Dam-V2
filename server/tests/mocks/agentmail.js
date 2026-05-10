'use strict';

const { vi } = require('vitest');

let sendCalls = [];
let sendResults = [];

function mockSend(params) {
  sendCalls.push(params);
  const result = sendResults.shift();
  if (result instanceof Error) return Promise.reject(result);
  return Promise.resolve(result || { id: `msg-${Date.now()}`, status: 'sent' });
}

function queueResult(result) {
  sendResults.push(result);
}

function getCalls() {
  return sendCalls;
}

function reset() {
  sendCalls = [];
  sendResults = [];
}

module.exports = {
  send: vi.fn(mockSend),
  queueResult,
  getCalls,
  reset,
};
