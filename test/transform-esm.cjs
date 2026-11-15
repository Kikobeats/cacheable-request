'use strict'

const crypto = require('node:crypto')
const esbuild = require('esbuild')

module.exports = {
  process (source) {
    return {
      code: esbuild.transformSync(source, { loader: 'js', format: 'cjs' }).code
    }
  },
  getCacheKey (source) {
    return crypto.createHash('sha1').update(source).digest('hex')
  }
}
