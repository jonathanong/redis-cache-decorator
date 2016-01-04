'use strict'

const debug = require('debug')('redis-cache-decorator')
const stringify = require('json-stringify-safe')
const Bluebird = require('bluebird')
const crypto = require('crypto')
const assert = require('assert')

// create a base
module.exports = constructorOptions => {
  assert(constructorOptions, 'Constructor options are required!')
  const client = constructorOptions.client
  const subscriber = constructorOptions.subscriber
  assert(client, 'A redis client as `.client` is required!')
  assert(subscriber, 'A redis subscription client as `.subscriber` is required!')

  // easy way to disabled
  const disabled = constructorOptions.disabled || constructorOptions.disable
  // prefix
  const constructorNamespace = constructorOptions.namespace || ''
  // 30 seconds
  const defaultTTL = constructorOptions.ttl || 30
  // prefix
  const defaultTimeout = constructorOptions.timeout || 30
  // onError
  const defaultOnError = constructorOptions.onError || _onError

  // add decorator options
  return decoratorOptions => {
    if (!decoratorOptions) decoratorOptions = {}

    if (typeof decoratorOptions.namespace !== 'string') throw new TypeError('A .namespace is required for each decorator.')
    const namespace = [constructorNamespace, decoratorOptions.namespace].join(':')
    const ttl = typeof decoratorOptions.ttl === 'number'
      ? decoratorOptions.ttl
      : defaultTTL
    const timeout = typeof decoratorOptions.timeout === 'number'
      ? decoratorOptions.timeout
      : defaultTimeout
    const onError = decoratorOptions.onError || defaultOnError

    // input the underlying function
    return fn => {
      if (typeof fn !== 'function') throw new TypeError('Decorated input must be a function!')
      // return the decorated version of the function

      return Bluebird.coroutine(function * () {
        // bypass the cache
        if (disabled) return yield Promise.resolve(fn.apply(null, arguments))

        let cleanupListeners = noop

        // create a hash of the arguments
        const args = []
        for (let i = 0; i < arguments.length; i++) args.push(arguments[i])
        const hash = createHash(args)

        // check whether it's running or anything
        const state = yield getCurrentState()

        // return the cached version
        if (state.value) return JSON.parse(state.value)
        // if it's currently running, wait for the value
        if (state.running) return yield waitForResult()

        // execute
        const EXEC_ID = Date.now() + Math.random().toString(36)
        // note in redis that it's running
        // don't wait for a response - might avoid some race conditions
        const isSet = yield client.setnx(`${hash}:running`, EXEC_ID)
        // someone else is setting it
        if (!isSet) {
          // start listening for the result
          const resultPromise = waitForResult()
          // check whether the result has been saved in the mean time
          const state = yield getCurrentState()
          // the chance of this happening (setting a result when executing SETNX) is very low
          if (state.value) {
            cleanupListeners()
            return JSON.parse(state.value)
          }
          // if it's not running, execute again
          if (!state.running) {
            cleanupListeners()
            return yield* execute()
          }
          return yield resultPromise
        }

        return yield* execute()

        // executes the result
        function * execute () {
          {
            // if we're executing after a failed set,
            // set it again just in case
            const batch = client.multi()
            batch.setnx(`${hash}:running`, EXEC_ID)
            // set a timeout
            if (timeout) client.expire(`${hash}:running`, timeout)
            batch.exec().catch(onError)
          }

          try {
            // try to execute the value
            const value = yield Promise.resolve(fn.apply(null, args))
            debug('returned value: %o', value)
            const json = stringify(value) // story it as a string
            const batch = client.multi()
              .del(`${hash}:running`, `${hash}:error`)
              .publish(`${hash}:value`, json) // publish the result to all listeners
            // only cache if a TTL is set
            if (ttl) batch.set(`${hash}:value`, json, 'EX', ttl)
            batch.exec().catch(onError)
            return value
          } catch (_err) {
            // handle errors
            const err = JSON.stringify(_err, [
              'message',
              'arguments',
              'type',
              'name',
              'stack'
            ])
            client.multi()
              .del(`${hash}:running`, `${hash}:value`)
              // publish the error to all listeners
              .publish(`${hash}:error`, err)
              .exec().catch(onError)
            throw _err
          }
        }

        function getCurrentState () {
          return client.mget([
            `${hash}:value`, // cached value
            `${hash}:running`, // whether it's running
          ]).then(results => {
            return {
              value: results[0],
              running: results[1],
            }
          })
        }

        // wait for the result from redis channels
        function waitForResult () {
          // subscribe to the channels
          const pattern = `${hash}:*`

          return new Promise((resolve, reject) => {
            // expose the cleanup function outside the scope
            cleanupListeners = cleanup

            subscriber.psubscribe(pattern).catch(reject)

            // add a message handler
            subscriber.setMaxListeners(subscriber.getMaxListeners() + 1)
            subscriber.on('pmessage', listener)

            function listener (pattern, channel, message) {
              if (channel === `${hash}:value`) {
                cleanup()
                debug('message: %s', message)
                try {
                  resolve(JSON.parse(message))
                } catch (err) {
                  // when would this happen?
                  /* istanbul ignore next */
                  reject(err)
                }
              } else if (channel === `${hash}:error`) {
                cleanup()
                try {
                  reject(JSON.parse(message))
                } catch (err) {
                  // when would this happen?
                  /* istanbul ignore next */
                  reject(err)
                }
              }
            }

            function cleanup () {
              subscriber.punsubscribe(pattern).catch(reject)
              subscriber.removeListener('message', listener)
              subscriber.setMaxListeners(subscriber.getMaxListeners() - 1)
            }
          })
        }
      })
    }

    function createHash (args) {
      debug(args)
      return [
        namespace,
        crypto.createHash('sha256')
          .update(stringify(args))
          .digest('hex'),
      ].join(':')
    }
  }
}

// these errors would only happen on network errors
/* istanbul ignore next */
function _onError (err) {
  /* eslint no-console: 0 */
  if (err) console.error(err.stack)
}

/* istanbul ignore next */
function noop () {}
