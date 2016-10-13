
# redis-cache-decorator

[![NPM version][npm-image]][npm-url]
[![Build status][travis-image]][travis-url]
[![Test coverage][codecov-image]][codecov-url]
[![Dependency Status][david-image]][david-url]
[![License][license-image]][license-url]
[![Downloads][downloads-image]][downloads-url]

A decorator to cache your functions.
Features:

- Uses Redis caching, expiration, and pub/sub.
- Concurrency locking - if the function is being run elsewhere with the same arguments, it will wait for the result of that function instead of executing again.
- Caching - caches results for as long as you want. If you set `ttl=0`, then you're just this library for concurrency locking, which is completely fine.
- Timeouts - throws when executing or waiting for a function call takes too long
- Only tested with [ioredis](https://github.com/luin/ioredis)

Use Cases:

- Race conditions
- API calls with rate limits
- Expensive database calls
- Expensive function calls

## Example

Here's a function that caches all your queries.

```js
const assert = require('assert')
const Redis = require('ioredis')
const pg = require('pg-then')

const pool = pg.Pool(process.env.POSTGRES_URI)

const CreateCacheDecorator = require('redis-cache-decorator')({
  client: Redis.createClient(),
  subscriber: Redis.createClient()
})

const fn = CreateCacheDecorator({
  namespace: 'crazy-database-call',
})((query, values) => {
  return db.query(query).then(result => result.rows)
})

fn(`
  SELECT *
  FROM users
  WHERE id = $1
`, [
  1
]).then(users => {
  assert(Array.isArray(users))
})
```

## API

### const CreateCacheDecorator = require('redis-cache-decorator')(options)

Creates a constructor with the following options:

- `client <required>` - a redis client for GET/SET/PUBLISH, etc.
- `subscriber <required>` - a redis client for `PSUBSCIRBE`
- `namespace = ''` - a prefix for all the events
- `encoding = 'json'` - how data is encoded between redis and node.js.
  Supported values are:
  - `json` - the default
  - `string`
  - `buffer`
- `ttl = '30s'` - the TTL expiration in seconds.
- `timeout = '30s'` - how long to wait for the function to execute.
- `pollFactor = 1 / 10` - the fraction of the timeout to poll.
  For example, a `30s` timeout with a `1 / 10` factor means that redis is polled for new changes every 3 seconds.
- `minimumPollInterval = '100ms'` - the minimum frequency of polling so you don't end up spamming redis
- `createTimeoutError = () => <Error>{ message: 'Timed out!', code: 'RCDTIMEDOUT' }` - the function called to create a timeout error.
  By default, you can check for timeout errors by checking `if (err.code === 'RCDTIMEDOUT')`.
- `onError = err => console.error(err.stack)` - an error handler for redis network errors.
- `disabled = false` - disable this decorator, specifically useful for testing.

### const decorate = CreateCacheDecorator(options)

Create a decorator with a set of options.

- `namespace <required>` - a namespace for this decorator
- `pollInterval` - by default, calculated from `timeout`, `pollFactor`, and `minimumPollInterval`, but you can set this yourself.
- `ttl`
- `timeout`
- `pollFactor`
- `minimumPollInterval`
- `createTimeoutError`
- `onError`

### const decoratedFunction = decorate(fn)

Decorates the function.
The decorated function will have the same API as the original function.

- The function should return a value or a `Promise` that can be `JSON.stringify()`d.
- The function can be synchronous or asynchronous.
- `this` is not supported.
  Do not access `this` within the function.
  The primary reason is that it's difficult to decide how to cache.

### const job = decoratedFunction(...args)

Execute the decorated function. Will always return a `Promise` that resolves to the value.
In addition, the promise will have the following properties:

- `.hash` - hash of the arguments for this job.

### job.then(value => {}, err => {})

Resolve the promise to retrieve the results of the job.

### const hash = decoratedFunction.createHash(...args)

Create the hash string for the specified arguments.

### decoratedFunction.set(hash, value).then(value => {})

Manually set the value of a hash.

#### Streams

If a stream is returned, the values will automatically be buffered.

- `encoding='json'` - the stream will be concatenated as an object stream -> array.
  If the stream is not an object stream, it will throw.
- `encoding='string'` - the stream will be buffered into a string.
- `encoding='buffer'` - the stream will be buffered into a `Buffer()` instance.

[npm-image]: https://img.shields.io/npm/v/redis-cache-decorator.svg?style=flat-square
[npm-url]: https://npmjs.org/package/redis-cache-decorator
[travis-image]: https://img.shields.io/travis/jonathanong/redis-cache-decorator.svg?style=flat-square
[travis-url]: https://travis-ci.org/jonathanong/redis-cache-decorator
[codecov-image]: https://img.shields.io/codecov/c/github/jonathanong/redis-cache-decorator/master.svg?style=flat-square
[codecov-url]: https://codecov.io/github/jonathanong/redis-cache-decorator
[david-image]: http://img.shields.io/david/jonathanong/redis-cache-decorator.svg?style=flat-square
[david-url]: https://david-dm.org/jonathanong/redis-cache-decorator
[license-image]: http://img.shields.io/npm/l/redis-cache-decorator.svg?style=flat-square
[license-url]: LICENSE
[downloads-image]: http://img.shields.io/npm/dm/redis-cache-decorator.svg?style=flat-square
[downloads-url]: https://npmjs.org/package/redis-cache-decorator
