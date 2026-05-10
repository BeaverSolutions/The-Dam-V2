'use strict';

const { vi } = require('vitest');

let queryResults = [];
let queryCalls = [];

function mockQuery(sql, params) {
  queryCalls.push({ sql, params });
  const result = queryResults.shift();
  if (result instanceof Error) return Promise.reject(result);
  return Promise.resolve(result || { rows: [], rowCount: 0 });
}

function setNextResult(result) {
  queryResults.push(result);
}

function setNextResults(results) {
  queryResults.push(...results);
}

function getQueryCalls() {
  return queryCalls;
}

function getLastQuery() {
  return queryCalls[queryCalls.length - 1] || null;
}

function reset() {
  queryResults = [];
  queryCalls = [];
}

const pool = {
  query: vi.fn(mockQuery),
};

module.exports = {
  pool,
  setNextResult,
  setNextResults,
  getQueryCalls,
  getLastQuery,
  reset,
};
