/* global test, expect */

const { engines } = require('../package.json')

const compare = (left, right) => {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

const satisfies = (version, range) => range.split('||').some(clause =>
  clause.trim().split(/\s+/).every(comparator => {
    const match = comparator.match(/^(>=|<=|>|<)(\d+(?:\.\d+){0,2})$/)
    if (!match) throw new Error(comparator)
    const order = compare(version, match[2])
    if (match[1] === '>=') return order >= 0
    if (match[1] === '<=') return order <= 0
    if (match[1] === '>') return order > 0
    return order < 0
  })
)

// require(esm) is unflagged from 20.19.0, 22.12.0, and 23.0.0.
const allowed = ['20.19.0', '22.12.0', '23.0.0', '24.11.0']
const rejected = ['18.20.8', '20.18.1', '21.7.3', '22.11.0']

test('engines allow only nodes where require(esm) is unflagged', () => {
  for (const version of allowed) {
    expect(satisfies(version, engines.node)).toBe(true)
  }
  for (const version of rejected) {
    expect(satisfies(version, engines.node)).toBe(false)
  }
})
