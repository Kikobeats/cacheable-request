/* global beforeAll, afterAll, test, expect */

const createTestServer = require('create-test-server')
const { setTimeout } = require('timers/promises')
const { request } = require('node:http')
const getStream = require('get-stream')
const sqlite3 = require('sqlite3')
const util = require('node:util')
const url = require('node:url')
const Keyv = require('keyv')
const pify = require('pify')

const CacheableRequest = require('../src')

// Promisify cacheableRequest
const promisify = cacheableRequest => async options =>
  new Promise((resolve, reject) => {
    cacheableRequest(options, async response => {
      const body = await getStream(response)
      response.body = body
      // Give the cache time to update
      await setTimeout(100)
      resolve(response)
    })
      .on('request', request_ => request_.end())
      .once('error', reject)
  })
let s
beforeAll(async () => {
  s = await createTestServer()
  let noStoreIndex = 0
  s.get('/no-store', (request_, response_) => {
    noStoreIndex++
    response_.setHeader('Cache-Control', 'public, no-cache, no-store')
    response_.end(noStoreIndex.toString())
  })
  let cacheIndex = 0
  s.get('/cache', (request_, response_) => {
    cacheIndex++
    response_.setHeader('Cache-Control', 'public, max-age=60')
    response_.end(cacheIndex.toString())
  })
  s.get('/last-modified', (request_, response_) => {
    response_.setHeader('Cache-Control', 'public, max-age=0')
    response_.setHeader('Last-Modified', 'Wed, 21 Oct 2015 07:28:00 GMT')
    let responseBody = 'last-modified'
    if (
      request_.headers['if-modified-since'] === 'Wed, 21 Oct 2015 07:28:00 GMT'
    ) {
      response_.statusCode = 304
      responseBody = null
    }
    response_.end(responseBody)
  })
  let calledFirstError = false
  s.get('/first-error', (request_, response_) => {
    if (calledFirstError) {
      response_.end('ok')
      return
    }
    calledFirstError = true
    response_.statusCode = 502
    response_.end('received 502')
  })
  s.get('/etag', (request_, response_) => {
    response_.setHeader('Cache-Control', 'public, max-age=0')
    response_.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4')
    let responseBody = 'etag'
    if (
      request_.headers['if-none-match'] ===
      '33a64df551425fcc55e4d42a148795d9f25f89d4'
    ) {
      response_.statusCode = 304
      responseBody = null
    }
    response_.end(responseBody)
  })
  s.get('/revalidate-modified', (request_, response_) => {
    response_.setHeader('Cache-Control', 'public, max-age=0')
    response_.setHeader('ETag', '33a64df551425fcc55e4d42a148795d9f25f89d4')
    let responseBody = 'revalidate-modified'
    if (
      request_.headers['if-none-match'] ===
      '33a64df551425fcc55e4d42a148795d9f25f89d4'
    ) {
      response_.setHeader('ETag', '0000000000000000000000000000000000')
      responseBody = 'new-body'
    }
    response_.end(responseBody)
  })
  let cacheThenNoStoreIndex = 0
  s.get('/cache-then-no-store-on-revalidate', (request_, response_) => {
    const cc =
      cacheThenNoStoreIndex === 0
        ? 'public, max-age=0'
        : 'public, no-cache, no-store'
    cacheThenNoStoreIndex++
    response_.setHeader('Cache-Control', cc)
    response_.end('cache-then-no-store-on-revalidate')
  })
  s.get('/echo', (request_, response_) => {
    const { headers, query, path, originalUrl, body } = request_
    response_.json({
      headers,
      query,
      path,
      originalUrl,
      body
    })
  })
})
afterAll(async () => {
  await s.close()
})
test('Non cacheable responses are not cached', async () => {
  const endpoint = '/no-store'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const firstResponseIntBody = await cacheableRequestHelper(s.url + endpoint)
  const firstResponseInt = Number(firstResponseIntBody.body)
  const secondResponseIntBody = await cacheableRequestHelper(s.url + endpoint)
  const secondResponseInt = Number(secondResponseIntBody.body)
  expect(cache.size).toBe(0)
  expect(firstResponseInt < secondResponseInt).toBeTruthy()
})
test('Cacheable responses are cached', async () => {
  const endpoint = '/cache'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const firstResponse = await cacheableRequestHelper(s.url + endpoint)
  const secondResponse = await cacheableRequestHelper(s.url + endpoint)
  expect(cache.size).toBe(1)
  expect(firstResponse.body).toBe(secondResponse.body)
})
test('Cacheable responses have unique cache key', async () => {
  const endpoint = '/cache'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const firstResponse = await cacheableRequestHelper(s.url + endpoint + '?foo')
  const secondResponse = await cacheableRequestHelper(s.url + endpoint + '?bar')
  expect(cache.size).toBe(2)
  expect(firstResponse.body).not.toBe(secondResponse.body)
})
const testCacheKey = async (input, expected) => {
  const expectKey = `cacheable-request:${expected}`
  const okMessage = `OK ${expectKey}`
  const cache = {
    get (key) {
      expect(key).toBe(expectKey)
      throw new Error(okMessage)
    }
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  await expect(cacheableRequestHelper(input)).rejects.toThrow()
}

test('return with GET', async () =>
  testCacheKey('http://www.example.com', 'GET:http://www.example.com'))

test('strips default path', async () =>
  testCacheKey('http://www.example.com/', 'GET:http://www.example.com'))

test('keeps trailing /', async () =>
  testCacheKey(
    'http://www.example.com/test/',
    'GET:http://www.example.com/test/'
  ))

test('return with GET.', async () =>
  testCacheKey(
    new url.URL('http://www.example.com'),
    'GET:http://www.example.com'
  ))

test('no requried properties', async () =>
  testCacheKey({}, 'GET:http://localhost'))

test('return without slash', async () =>
  testCacheKey(
    {
      protocol: 'http:',
      host: 'www.example.com',
      port: 80,
      path: '/'
    },
    'GET:http://www.example.com'
  ))

test('return without port', async () =>
  testCacheKey(
    {
      hostname: 'www.example.com',
      port: 80,
      path: '/'
    },
    'GET:http://www.example.com'
  ))

test('return with url and port', async () =>
  testCacheKey(
    {
      hostname: 'www.example.com',
      port: 8080,
      path: '/'
    },
    'GET:http://www.example.com:8080'
  ))

test('return with protocol', async () =>
  testCacheKey({ host: 'www.example.com' }, 'GET:http://www.example.com'))

test('hostname over host', async () =>
  testCacheKey(
    {
      host: 'www.example.com',
      hostname: 'xyz.example.com'
    },
    'GET:http://xyz.example.com'
  ))

test('hostname defaults to localhost', async () =>
  testCacheKey({ path: '/' }, 'GET:http://localhost'))

test('ignores pathname', async () =>
  testCacheKey(
    {
      path: '/foo',
      pathname: '/bar'
    },
    'GET:http://localhost/foo'
  ))

test('ignores search', async () =>
  testCacheKey(
    {
      path: '/?foo=bar',
      search: '?bar=baz'
    },
    'GET:http://localhost/?foo=bar'
  ))

test('ignores query', async () =>
  testCacheKey(
    {
      path: '/?foo=bar',
      query: { bar: 'baz' }
    },
    'GET:http://localhost/?foo=bar'
  ))

test('auth should be in url', async () =>
  testCacheKey({ auth: 'user:pass' }, 'GET:http://user:pass@localhost'))

test('should return default url', async () =>
  testCacheKey({ method: 'POST' }, 'POST:http://localhost'))
test('request options path query is passed through', async () => {
  const cacheableRequest = CacheableRequest(request)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const argString = `${s.url}/echo?foo=bar`
  const argURL = new url.URL(argString)
  const urlObject = url.parse(argString)
  const argOptions = {
    hostname: urlObject.hostname,
    port: urlObject.port,
    path: urlObject.path
  }
  const inputs = [argString, argURL, argOptions]
  for (const input of inputs) {
    const response = await cacheableRequestHelper(input)
    const body = JSON.parse(response.body)
    expect(body.query.foo).toBe('bar')
  }
})
test('Setting opts.cache to false bypasses cache for a single request', async () => {
  const endpoint = '/cache'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = url.parse(s.url + endpoint)
  const optionsNoCache = Object.assign({ cache: false }, options)
  const firstResponse = await cacheableRequestHelper(options)
  const secondResponse = await cacheableRequestHelper(options)
  const thirdResponse = await cacheableRequestHelper(optionsNoCache)
  const fourthResponse = await cacheableRequestHelper(options)
  expect(firstResponse.fromCache).toBeFalsy()
  expect(secondResponse.fromCache).toBeTruthy()
  expect(thirdResponse.fromCache).toBeFalsy()
  expect(fourthResponse.fromCache).toBeTruthy()
})
test('TTL is passed to cache', async () => {
  expect.assertions(2)
  const endpoint = '/cache'
  const store = new Map()
  const cache = {
    get: store.get.bind(store),
    set (key, value, ttl) {
      expect(typeof ttl).toBe('number')
      expect(ttl > 0).toBeTruthy()
      return store.set(key, value)
    },
    delete: store.delete.bind(store)
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = Object.assign(
    { strictTtl: true },
    url.parse(s.url + endpoint)
  )
  await cacheableRequestHelper(options)
})
test('TTL is not passed to cache if strictTtl is false', async () => {
  expect.assertions(1)
  const endpoint = '/cache'
  const store = new Map()
  const cache = {
    get: store.get.bind(store),
    set (key, value, ttl) {
      expect(typeof ttl === 'undefined').toBeTruthy()
      return store.set(key, value)
    },
    delete: store.delete.bind(store)
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = Object.assign(
    { strictTtl: false },
    url.parse(s.url + endpoint)
  )
  await cacheableRequestHelper(options)
})
test('Setting opts.maxTtl will limit the TTL', async () => {
  expect.assertions(1)
  const endpoint = '/cache'
  const store = new Map()
  const cache = {
    get: store.get.bind(store),
    set (key, value, ttl) {
      expect(ttl).toBe(1000)
      return store.set(key, value)
    },
    delete: store.delete.bind(store)
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = Object.assign(
    Object.assign({}, url.parse(s.url + endpoint)),
    { maxTtl: 1000 }
  )
  await cacheableRequestHelper(options)
})
test("Setting opts.maxTtl when opts.strictTtl is true will use opts.maxTtl if it's smaller", async () => {
  expect.assertions(1)
  const endpoint = '/cache'
  const store = new Map()
  const cache = {
    get: store.get.bind(store),
    set (key, value, ttl) {
      expect(ttl === 1000).toBeTruthy()
      return store.set(key, value)
    },
    delete: store.delete.bind(store)
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = Object.assign(
    Object.assign({}, url.parse(s.url + endpoint)),
    { strictTtl: true, maxTtl: 1000 }
  )
  await cacheableRequestHelper(options)
})
test("Setting opts.maxTtl when opts.strictTtl is true will use remote TTL if it's smaller", async () => {
  expect.assertions(1)
  const endpoint = '/cache'
  const store = new Map()
  const cache = {
    get: store.get.bind(store),
    set (key, value, ttl) {
      expect(ttl < 100000).toBeTruthy()
      return store.set(key, value)
    },
    delete: store.delete.bind(store)
  }
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = Object.assign(
    Object.assign({}, url.parse(s.url + endpoint)),
    { strictTtl: true, maxTtl: 100000 }
  )
  await cacheableRequestHelper(options)
})
test('Stale cache entries with Last-Modified headers are revalidated', async () => {
  const endpoint = '/last-modified'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const firstResponse = await cacheableRequestHelper(s.url + endpoint)
  const secondResponse = await cacheableRequestHelper(s.url + endpoint)
  expect(cache.size).toBe(1)
  expect(firstResponse.statusCode).toBe(200)
  expect(secondResponse.statusCode).toBe(200)
  expect(firstResponse.fromCache).toBeFalsy()
  expect(secondResponse.fromCache).toBeTruthy()
  expect(firstResponse.body).toBe('last-modified')
  expect(firstResponse.body).toBe(secondResponse.body)
})
test('Stale cache entries with ETag headers are revalidated', async () => {
  const endpoint = '/etag'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const firstResponse = await cacheableRequestHelper(s.url + endpoint)
  const secondResponse = await cacheableRequestHelper(s.url + endpoint)
  expect(cache.size).toBe(1)
  expect(firstResponse.statusCode).toBe(200)
  expect(secondResponse.statusCode).toBe(200)
  expect(firstResponse.fromCache).toBeFalsy()
  expect(secondResponse.fromCache).toBeTruthy()
  expect(firstResponse.body).toBe('etag')
  expect(firstResponse.body).toBe(secondResponse.body)
})
test("Stale cache entries that can't be revalidate are deleted from cache", async () => {
  const endpoint = '/cache-then-no-store-on-revalidate'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const firstResponse = await cacheableRequestHelper(s.url + endpoint)
  expect(cache.size).toBe(1)
  const secondResponse = await cacheableRequestHelper(s.url + endpoint)
  expect(cache.size).toBe(0)
  expect(firstResponse.statusCode).toBe(200)
  expect(secondResponse.statusCode).toBe(200)
  expect(firstResponse.body).toBe('cache-then-no-store-on-revalidate')
  expect(firstResponse.body).toBe(secondResponse.body)
})
test('Response objects have fromCache property set correctly', async () => {
  const endpoint = '/cache'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const response = await cacheableRequestHelper(s.url + endpoint)
  const cachedResponse = await cacheableRequestHelper(s.url + endpoint)
  expect(response.fromCache).toBeFalsy()
  expect(cachedResponse.fromCache).toBeTruthy()
})
test('Revalidated responses that are modified are passed through', async () => {
  const endpoint = '/revalidate-modified'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const firstResponse = await cacheableRequestHelper(s.url + endpoint)
  const secondResponse = await cacheableRequestHelper(s.url + endpoint)
  expect(firstResponse.statusCode).toBe(200)
  expect(secondResponse.statusCode).toBe(200)
  expect(firstResponse.body).toBe('revalidate-modified')
  expect(secondResponse.body).toBe('new-body')
})
test('Undefined callback parameter inside cache logic is handled', async () => {
  const endpoint = '/cache'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  await cacheableRequestHelper(s.url + endpoint)
  cacheableRequest(s.url + endpoint, undefined)
  await setTimeout(500)
  expect(true).toBeTruthy()
})
test('Custom Keyv instance adapters used', async () => {
  const cache = new Keyv()
  const endpoint = '/cache'
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const response = await cacheableRequestHelper(s.url + endpoint)
  const cached = await cache.get(`GET:${s.url + endpoint}`)
  expect(response.body).toBe(cached.body.toString())
})
test('Keyv cache adapters load via connection uri', async () => {
  const endpoint = '/cache'
  const cacheableRequest = CacheableRequest(
    request,
    'sqlite://test/testdb.sqlite'
  )
  const cacheableRequestHelper = promisify(cacheableRequest)
  const db = new sqlite3.Database('test/testdb.sqlite')
  const query = await pify(db.all.bind(db))
  const firstResponse = await cacheableRequestHelper(s.url + endpoint)
  await setTimeout(1000)
  const secondResponse = await cacheableRequestHelper(s.url + endpoint)
  const cacheResult = await query(
    `SELECT * FROM keyv WHERE "key" = "cacheable-request:GET:${
      s.url + endpoint
    }"`
  )
  expect(firstResponse.fromCache).toBeFalsy()
  expect(secondResponse.fromCache).toBeTruthy()
  expect(cacheResult.length).toBe(1)
  await query('DELETE FROM keyv')
})
test('ability to force refresh', async () => {
  const endpoint = '/cache'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = url.parse(s.url + endpoint)
  const firstResponse = await cacheableRequestHelper(options)
  const secondResponse = await cacheableRequestHelper(
    Object.assign(Object.assign({}, options), { forceRefresh: true })
  )
  const thirdResponse = await cacheableRequestHelper(options)
  expect(firstResponse.body).not.toBe(secondResponse.body)
  expect(secondResponse.body).toBe(thirdResponse.body)
})
test('checks status codes when comparing cache & response', async () => {
  const endpoint = '/first-error'
  const cache = new Map()
  const cacheableRequest = CacheableRequest(request, cache)
  const cacheableRequestHelper = promisify(cacheableRequest)
  const options = url.parse(s.url + endpoint)
  const firstResponse = await cacheableRequestHelper(options)
  const secondResponse = await cacheableRequestHelper(options)
  expect(firstResponse.body).toBe('received 502')
  expect(secondResponse.body).toBe('ok')
})
