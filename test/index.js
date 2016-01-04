'use strict'

const assert = require('assert')
const Redis = require('ioredis')

require('bluebird').config({
  warnings: false
})

const client = Redis.createClient()

const decorator = require('..')({
  client,
  subscriber: Redis.createClient(),
})

before(() => {
  return client.flushall()
})

describe('Redis Cache Decorator', () => {
  it('should not allow concurrent execution of an asynchronous function', () => {
    let called = 0
    const fn = decorator({
      namespace: Math.random().toString()
    })(val => {
      return wait(10).then(() => {
        called++
        return val + 1
      })
    })

    return Promise.all([
      fn(1),
      fn(1)
    ]).then(results => {
      // equal results
      assert.deepEqual(results, [2, 2])
      // only called once
      assert.equal(called, 1)
    })
  })

  it('should not allow concurrent execution of a synchronous function', () => {
    let called = 0
    const rand = Math.random()
    const fn = decorator({
      namespace: Math.random().toString()
    })(val => {
      called++
      return val + rand
    })

    return Promise.all([
      fn(1),
      fn(1)
    ]).then(results => {
      // equal results
      assert.deepEqual(results, [1 + rand, 1 + rand])
      // only called once
      assert.equal(called, 1)
    })
  })

  it('should cache results', () => {
    let called = 0

    const fn = decorator({
      namespace: Math.random().toString()
    })(val => {
      return wait(10).then(() => {
        called++
        return val + 1
      })
    })

    return fn(1).then(val => {
      assert.equal(val, 2)
      return fn(1).then(val => {
        assert.equal(val, 2)
        assert.equal(called, 1)
      })
    })
  })

  it('should return the same error w/ asynchronous functions', () => {
    let called = 0

    const fn = decorator({
      namespace: Math.random().toString()
    })(val => {
      return wait(100).then(() => {
        called++
        throw new Error('boom')
      })
    })

    return Promise.all([
      fn(1).then(() => {
        throw new Error('nope')
      }).catch(err => {
        assert.equal(err.message, 'boom')
      }),
      fn(1).then(() => {
        throw new Error('nope')
      }).catch(err => {
        assert.equal(err.message, 'boom')
      })
    ]).then(() => {
      assert.equal(called, 1)
    })
  })

  it('should return the same error w/ synchronous functions', () => {
    // difference is that we don't care if the function is called multiple times
    // when the function does not take a lot of time
    const fn = decorator({
      namespace: Math.random().toString()
    })(val => {
      throw new Error('boom')
    })

    return Promise.all([
      fn(1).then(() => {
        throw new Error('nope')
      }).catch(err => {
        assert.equal(err.message, 'boom')
      }),
      fn(1).then(() => {
        throw new Error('nope')
      }).catch(err => {
        assert.equal(err.message, 'boom')
      })
    ])
  })
})

function wait (ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}
