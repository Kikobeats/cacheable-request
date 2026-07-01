/* global beforeAll, afterAll, test, expect */

const EventEmitter = require('node:events')
const { request } = require('node:http')
const stream = require('node:stream')
const url = require('node:url')
const createTestServer = require('create-test-server')
const getStream = require('get-stream')
const Keyv = require('keyv')
const CacheableRequest = require('../src')
const { PassThrough } = stream

let s
beforeAll(async () => {
  s = await createTestServer()
  s.get('/', (request_, response_) => {
    response_.setHeader('cache-control', 'max-age=60')
    response_.end('hi')
  })
  s.post('/', (request_, response_) => response_.status(201).end('hello'))
})
afterAll(async () => {
  await s.close()
})
test('cacheableRequest is a function', () => {
  const cacheableRequest = CacheableRequest(request)
  expect(typeof cacheableRequest).toBe('function')
})
test('cacheableRequest returns an event emitter', () => {
  const cacheableRequest = CacheableRequest(request)
  const returnValue = cacheableRequest(url.parse(s.url), () => true).on(
    'request',
    request_ => request_.end()
  )
  expect(returnValue instanceof EventEmitter).toBeTruthy()
})
test('cacheableRequest passes requests through if no cache option is set', () => {
  const cacheableRequest = CacheableRequest(request)
  cacheableRequest(url.parse(s.url), async response => {
    const body = await getStream(response)
    expect(body).toBe('hi')
  }).on('request', request_ => request_.end())
})
test('cacheableRequest accepts url as string', () => {
  const cacheableRequest = CacheableRequest(request)
  cacheableRequest(s.url, async response => {
    const body = await getStream(response)
    expect(body).toBe('hi')
  }).on('request', request_ => request_.end())
})
test('cacheableRequest accepts url as URL', () => {
  const cacheableRequest = CacheableRequest(request)
  cacheableRequest(new url.URL(s.url), async response => {
    const body = await getStream(response)
    expect(body).toBe('hi')
  }).on('request', request_ => request_.end())
})
test('cacheableRequest handles no callback parameter', () => {
  const cacheableRequest = CacheableRequest(request)
  cacheableRequest(url.parse(s.url)).on('request', request_ => {
    request_.end()
    request_.on('response', response => {
      expect(response.statusCode).toBe(200)
    })
  })
})
test('cacheableRequest emits response event for network responses', () => {
  const cacheableRequest = CacheableRequest(request)
  cacheableRequest(url.parse(s.url))
    .on('request', request_ => request_.end())
    .on('response', response => {
      expect(response.fromCache).toBeFalsy()
    })
})
test('cacheableRequest emits response event for cached responses', () => {
  const cacheableRequest = CacheableRequest(request)
  const cache = new Map()
  const options = Object.assign(url.parse(s.url), { cache })
  cacheableRequest(options, () => {
    // This needs to happen in next tick so cache entry has time to be stored
    setImmediate(() => {
      cacheableRequest(options)
        .on('request', request_ => request_.end())
        .on('response', response => {
          expect(response.fromCache).toBeTruthy()
        })
    })
  }).on('request', request_ => request_.end())
})
test('cacheableRequest does not hang for a Keyv-compatible store without EventEmitter (e.g. @keyvhq/core)', done => {
  // @keyvhq/core passes `instanceof Keyv` but does not extend EventEmitter, so
  // `cache.on` is undefined. Calling it threw an unhandled rejection that never
  // rejected the returned emitter, hanging the request until timeout.
  const cache = new Keyv()
  cache.on = undefined
  const cacheableRequest = CacheableRequest(request, cache)
  cacheableRequest(url.parse(s.url), response_ => {
    expect(response_.statusCode).toBe(200)
    done()
  })
    .on('error', done)
    .on('request', request_ => request_.end())
})
test('cacheableRequest emits CacheError if cache adapter connection errors', done => {
  const errorMessage = 'Connection error'
  const cache = {
    get: () => Promise.reject(new Error(errorMessage)),
    set () {},
    delete () {}
  }
  const cacheableRequest = CacheableRequest(request, cache)
  cacheableRequest(url.parse(s.url))
    .on('error', error => {
      expect(error instanceof CacheableRequest.CacheError).toBeTruthy()
      expect(error.message).toBe(errorMessage)
      done()
    })
    .on('request', request_ => request_.end())
})
test('cacheableRequest emits CacheError if cache.get errors', async () => {
  const errorMessage = 'Fail'
  const store = new Map()
  const cache = {
    get () {
      throw new Error(errorMessage)
    },
    set: store.set.bind(store),
    delete: store.delete.bind(store)
  }
  const cacheableRequest = CacheableRequest(request, cache)
  cacheableRequest(url.parse(s.url))
    .on('error', error => {
      expect(error instanceof CacheableRequest.CacheError).toBeTruthy()
      expect(error.message).toBe(errorMessage)
    })
    .on('request', request_ => request_.end())
})
test('cacheableRequest emits CacheError if cache.set errors', () => {
  const errorMessage = 'Fail'
  const store = new Map()
  const cache = {
    get: store.get.bind(store),
    set () {
      throw new Error(errorMessage)
    },
    delete: store.delete.bind(store)
  }
  const cacheableRequest = CacheableRequest(request, cache)
  cacheableRequest(url.parse(s.url))
    .on('error', error => {
      expect(error instanceof CacheableRequest.CacheError).toBeTruthy()
      expect(error.message).toBe(errorMessage)
    })
    .on('request', request_ => request_.end())
})
test('cacheableRequest emits CacheError if cache.delete errors', done => {
  const errorMessage = 'Fail'
  const store = new Map()
  const cache = {
    get: store.get.bind(store),
    set: store.set.bind(store),
    delete () {
      throw new Error(errorMessage)
    }
  }
  const cacheableRequest = CacheableRequest(request, cache)
  ;(async () => {
    let i = 0
    const s = await createTestServer()
    s.get('/', (request_, response_) => {
      const cc = i === 0 ? 'public, max-age=0' : 'public, no-cache, no-store'
      i++
      response_.setHeader('Cache-Control', cc)
      response_.end('hi')
    })
    cacheableRequest(s.url, () => {
      // This needs to happen in next tick so cache entry has time to be stored
      setImmediate(() => {
        cacheableRequest(s.url)
          .on('error', async error => {
            expect(error instanceof CacheableRequest.CacheError).toBeTruthy()
            expect(error.message).toBe(errorMessage)
            await s.close()
            done()
          })
          .on('request', request_ => request_.end())
      })
    }).on('request', request_ => request_.end())
  })()
})
test('cacheableRequest emits RequestError if request function throws', done => {
  const cacheableRequest = CacheableRequest(request)
  const options = url.parse(s.url)
  options.headers = { invalid: '💣' }
  cacheableRequest(options)
    .on('error', error => {
      expect(error instanceof CacheableRequest.RequestError).toBeTruthy()
      done()
    })
    .on('request', request_ => request_.end())
})
test('cacheableRequest does not cache response if request is aborted before receiving first byte of response', done => {
  createTestServer().then(s => {
    s.get('/delay-start', (request_, response_) => {
      setTimeout(() => {
        response_.setHeader('cache-control', 'max-age=60')
        response_.end('hi')
      }, 100)
    })
    const cacheableRequest = CacheableRequest(request)
    const options = url.parse(s.url)
    options.path = '/delay-start'
    cacheableRequest(options).on('request', request_ => {
      request_.end()
      setTimeout(() => {}, 20)
      setTimeout(() => {
        cacheableRequest(options, async response => {
          request_.abort()
          expect(response.fromCache).toBe(false)
          const body = await getStream(response)
          expect(body).toBe('hi')
          await s.close()
          done()
        }).on('request', request_ => request_.end())
      }, 100)
    })
  })
})
test('cacheableRequest does not cache response if request is aborted after receiving part of the response', done => {
  createTestServer().then(s => {
    s.get('/delay-partial', (request_, response_) => {
      response_.setHeader('cache-control', 'max-age=60')
      response_.write('h')
      setTimeout(() => {
        response_.end('i')
      }, 50)
    })
    const cacheableRequest = CacheableRequest(request)
    const options = url.parse(s.url)
    options.path = '/delay-partial'
    cacheableRequest(options).on('request', request_ => {
      setTimeout(() => {
        request_.abort()
      }, 20)
      setTimeout(() => {
        cacheableRequest(options, async response => {
          expect(response.fromCache).toBeFalsy()
          const body = await getStream(response)
          expect(body).toBe('hi')
          await s.close()
          done()
        }).on('request', request_ => request_.end())
      }, 100)
    })
  })
})
test('cacheableRequest makes request even if initial DB connection fails (when opts.automaticFailover is enabled)', async () => {
  const cache = {
    get: () => Promise.reject(new Error('Connection error')),
    set () {},
    delete () {}
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const options = url.parse(s.url)
  options.automaticFailover = true
  cacheableRequest(options, response_ => {
    expect(response_.statusCode).toBe(200)
  })
    .on('error', () => {})
    .on('request', request_ => request_.end())
})
test('cacheableRequest makes request even if current DB connection fails (when opts.automaticFailover is enabled)', async () => {
  const cache = {
    get () {
      throw new Error()
    },
    set () {
      throw new Error()
    },
    delete () {
      throw new Error()
    }
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const options = url.parse(s.url)
  options.automaticFailover = true
  cacheableRequest(options, response_ => {
    expect(response_.statusCode).toBe(200)
  })
    .on('error', () => {})
    .on('request', request_ => request_.end())
})
test('cacheableRequest hashes request body as cache key', async () => {
  const cache = {
    get (k) {
      expect(k.split(':').pop()).toBe('5d41402abc4b2a76b9719d911017c592')
    },
    set () {},
    delete () {}
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const options = url.parse(s.url)
  options.body = 'hello'
  options.method = 'POST'
  cacheableRequest(options, response_ => {
    expect(response_.statusCode).toBe(201)
  })
    .on('error', () => {})
    .on('request', request_ => request_.end())
})
test('cacheableRequest skips cache for streamed body', done => {
  const cache = {
    get () {
      fail(new CacheableRequest.CacheError(new Error('Cache error')))
    },
    set () {},
    delete () {}
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const options = url.parse(s.url)
  options.body = new PassThrough()
  options.method = 'POST'
  cacheableRequest(options, response_ => {
    expect(response_.statusCode).toBe(201)
    done()
  })
    .on('error', () => {})
    .on('request', request_ => request_.end())
  options.body.end('hello')
})
