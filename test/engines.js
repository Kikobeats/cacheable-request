/* global test, expect */

const { engines } = require('../package.json')

test('engines is Node 24', () => {
  expect(engines.node).toBe('24')
})
