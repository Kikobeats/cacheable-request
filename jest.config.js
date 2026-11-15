'use strict'

const [major, minor] = process.versions.node.split('.').map(Number)
// Jest's own loader can require() an ESM dependency from Node 24.9.
// Older nodes still run the suite, with that dependency compiled to CJS.
const jestLoadsEsm = major > 24 || (major === 24 && minor >= 9)

const config = {
  moduleFileExtensions: ['js'],
  testMatch: ['**/test/**/*.js'],
  testEnvironment: 'node'
}

if (!jestLoadsEsm) {
  config.transform = {
    'normalize-url/.+\\.js$': '<rootDir>/test/transform-esm.cjs'
  }
  config.transformIgnorePatterns = ['/node_modules/(?!.*normalize-url/)']
}

module.exports = config
