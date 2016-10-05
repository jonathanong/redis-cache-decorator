'use strict'

/* eslint-env mocha */
/* eslint max-nested-callbacks: 0 */

const Readable = require('stream').Readable
const assert = require('assert')
const Redis = require('ioredis')

require('bluebird').config({
  // warnings: false
})

const client = Redis.createClient()
const subscriber = Redis.createClient()

const decorator = require('..')({
  client,
  subscriber
})

before(() => {
  return client.flushall()
})

describe('Redis Cache Decorator', () => {
  describe('Concurrency', () => {
    describe('encoding=`json`', () => {
      it('should not allow concurrent execution of an asynchronous function', () => {
        let called = 0
        const fn = decorator({
          namespace: createNamespace()
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
          namespace: createNamespace()
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
    })

    describe('encoding=`buffer`', () => {
      it('should not allow concurreny execution of an asynchronous function', () => {
        let called = 0
        const fn = decorator({
          namespace: createNamespace(),
          encoding: 'buffer',
          minimumPollInterval: Infinity
        })(val => {
          called++
          return wait(100).then(() => {
            return new Buffer(val, 'hex')
          })
        })

        const hex = '00ff44'

        return Promise.all([
          fn(hex),
          fn(hex)
        ]).then(results => {
          for (const result of results) {
            assert.equal(result.toString('hex'), hex)
          }
          assert.equal(called, 1)
        })
      })
    })
  })

  describe('Caching', () => {
    describe('encoding=`json`', () => {
      it('should cache results', () => {
        let called = 0

        const fn = decorator({
          namespace: createNamespace()
        })(val => {
          return wait(10).then(() => {
            called++
            return val + 1
          })
        })

        const promise = fn(1)
        assert.equal('string', typeof promise.hash)

        return promise.then(val => {
          assert.equal(val, 2)
          return fn(1).then(val => {
            assert.equal(val, 2)
            assert.equal(called, 1)
          })
        })
      })
    })

    describe('encoding=`buffer`', () => {
      it('should cache results', () => {
        let called = 0
        const fn = decorator({
          namespace: createNamespace(),
          encoding: 'buffer'
        })(val => {
          called++
          return new Buffer(val, 'hex')
        })

        const hex = '00ff44'

        return fn(hex).then(val => {
          assert(Buffer.isBuffer(val))
          assert.equal(val.toString('hex'), hex)
          return fn(hex)
        }).then(val => {
          assert(Buffer.isBuffer(val))
          assert.equal(val.toString('hex'), hex)
          assert.equal(called, 1)
        })
      })
    })

    describe('encoding=`string`', () => {
      it('should cache results', () => {
        let called = 0
        const fn = decorator({
          namespace: createNamespace(),
          encoding: 'string'
        })(val => {
          called++
          return String(val) + String(val)
        })

        const string = 'asdf'

        return fn(string).then(val => {
          assert.equal(val, string + string)
          return fn(string)
        }).then(val => {
          assert.equal(val, string + string)
          assert.equal(called, 1)
        })
      })
    })

    describe('ttl=0', () => {
      it('should not cache w/ ttl=0', () => {
        let called = 0
        const fn = decorator({
          namespace: createNamespace(),
          ttl: 0
        })(val => {
          called++
          return val
        })

        return fn(1).then(val => {
          assert.equal(val, 1)
          return fn(1)
        }).then(val => {
          assert.equal(val, 1)
          assert.equal(called, 2)
        })
      })
    })
  })

  describe('Streams', () => {
    describe('encoding=`json`', () => {
      it('should support object mode streams', () => {
        let called = 0

        const fn = decorator({
          namespace: createNamespace()
        })(val => {
          called++
          return wait(10).then(() => {
            const stream = new Readable({
              objectMode: true
            })
            stream.push(val)
            stream.push(val + 1)
            stream.push(null)
            return stream
          })
        })

        return fn(1).then(val => {
          assert.deepEqual(val, [1, 2])
          return fn(1).then(val => {
            assert.deepEqual(val, [1, 2])
            assert.equal(called, 1)
          })
        })
      })
    })

    describe('encoding=`string`', () => {
      it('should support string streams', () => {
        let called = 0

        const fn = decorator({
          namespace: createNamespace(),
          encoding: 'string'
        })(string => {
          called++
          return wait(10).then(() => {
            const stream = new Readable()
            stream.push(string)
            stream.push(':')
            stream.push(string)
            stream.push(null)
            return stream
          })
        })

        const string = 'asdf'

        return fn(string).then(val => {
          assert.deepEqual(val, [string, string].join(':'))
          return fn(string).then(val => {
            assert.deepEqual(val, [string, string].join(':'))
            assert.equal(called, 1)
          })
        })
      })
    })

    describe('encoding=`buffer`', () => {
      it('should support binary streams', () => {
        let called = 0

        const fn = decorator({
          namespace: createNamespace(),
          encoding: 'buffer'
        })(string => {
          called++
          return wait(10).then(() => {
            const stream = new Readable()
            stream.push(string)
            stream.push(':')
            stream.push(string)
            stream.push(null)
            return stream
          })
        })

        const string = 'asdf'

        return fn(string).then(val => {
          assert(Buffer.isBuffer(val))
          assert.deepEqual(val.toString(), [string, string].join(':'))
          return fn(string).then(val => {
            assert(Buffer.isBuffer(val))
            assert.deepEqual(val.toString(), [string, string].join(':'))
            assert.equal(called, 1)
          })
        })
      })
    })
  })

  describe('Error Handling', () => {
    it('should return the same error w/ asynchronous functions', () => {
      let called = 0

      const fn = decorator({
        namespace: createNamespace()
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
        namespace: createNamespace()
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

  describe('Timeouts', () => {
    it('should support timeouts from the listener', () => {
      let called = 0
      const fn = decorator({
        namespace: createNamespace(),
        timeout: 200
      })(val => {
        called++
        return wait(1000).then(() => val)
      })

      // call it
      fn(true).catch(noop)

      // wait for itt o SETNX
      return wait(100).then(() => {
        // call it again
        return fn(true)
      }).then(() => {
        throw new Error('boom')
      }).catch(err => {
        assert.equal(called, 1)
        assert.equal(err.code, 'RCDTIMEDOUT')
      })
    })

    it('should support timeouts from the function', () => {
      const fn = decorator({
        namespace: createNamespace(),
        timeout: 1
      })(val => {
        return wait(1000).then(() => val)
      })

      return fn(true).then(() => {
        throw new Error('boom')
      }).catch(err => {
        assert.equal(err.code, 'RCDTIMEDOUT')
      })
    })
  })

  describe('Disabling', () => {
    it('should work w/ disabled=true', () => {
      let called = 0
      const fn = require('..')({
        client,
        subscriber,
        disabled: true,
        ttl: '1hr',
        timeout: '1hr'
      })({
        namespace: createNamespace()
      })(val => {
        called++
        return wait(1).then(() => val + 1)
      })

      return Promise.all([
        fn(1),
        fn(1),
        fn(1)
      ]).then(results => {
        for (const result of results) {
          assert.equal(result, 2)
        }
        assert.equal(called, 3)
      })
    })
  })

  describe('Validations', () => {
    describe('constructor options', () => {
      it('should only support ttl=string|number', () => {
        assert.throws(require('..')({
          client,
          subscriber,
          ttl: true
        }))
      })
    })

    describe('decorator options', () => {
      it('should throw when the namespace is not set', () => {
        assert.throws(() => {
          decorator()
        })

        assert.throws(() => {
          decorator({})
        })
      })
    })

    describe('decorator', () => {
      it('should throw if the input value is not a string', () => {
        assert.throws(() => {
          decorator({
            namespace: createNamespace()
          })()
        })
      })
    })
  })

  describe('A lot of requests at once', () => {
    it('should not throw warnings', () => {
      const fn = require('..')({
        client,
        subscriber,
        ttl: '1hr',
        timeout: '1hr'
      })({
        namespace: createNamespace()
      })(val => wait(Math.random() * 100).then(() => val))

      const promises = []
      for (let i = 0; i < 10000; i++) {
        promises.push(wait(Math.random() * 100).then(fn(Math.random())))
      }

      return Promise.all(promises)
    })
  })
})

function wait (ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function noop () {}

function createNamespace () {
  return Math.random().toString()
}
