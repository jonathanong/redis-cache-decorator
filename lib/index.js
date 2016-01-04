'use strict'

const debug = require('debug')('redis-cache-decorator')
const stringify = require('json-stringify-safe')
const Promise = require('bluebird')
const crypto = require('crypto')
const assert = require('assert')
const _ms = require('ms')

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
  const defaultTTL = isNumberOrString(constructorOptions.ttl)
    ? ms(constructorOptions.ttl)
    : ms('30s')
  // prefix
  const defaultTimeout = isNumberOrString(constructorOptions.timeout)
    ? ms(constructorOptions.timeout)
    : ms('30s')
  // onError
  const defaultOnError = constructorOptions.onError || _onError
  // default poll factor based on the timeout
  const defaultPollFactor = constructorOptions.pollFactor || (1 / 10)
  // default minimum poll interval in ms
  const defaultMinimumTimeoutPollInterval = ms(constructorOptions.minimumPollInterval || 100)
  // function to create a time out error
  const defaultCreateTimeoutError = constructorOptions.createTimeoutError || _createTimeoutError

  // add decorator options
  return decoratorOptions => {
    if (typeof decoratorOptions !== 'object') throw new TypeError('Decorator options are required!')
    if (typeof decoratorOptions.namespace !== 'string') throw new TypeError('A .namespace is required for each decorator.')
    const namespace = [constructorNamespace, decoratorOptions.namespace].join(':')
    const ttl = ms(isNumberOrString(decoratorOptions.ttl)
      ? decoratorOptions.ttl
      : defaultTTL)
    const timeout = ms(isNumberOrString(decoratorOptions.timeout)
      ? decoratorOptions.timeout
      : defaultTimeout)
    assert(timeout > 0, 'The timeout must be > 0')
    const pollFactor = decoratorOptions.pollFactor || defaultPollFactor
    const minimumPollInterval = ms(isNumberOrString(decoratorOptions.minimumPollInterval)
      ? decoratorOptions.minimumPollInterval
      : defaultMinimumTimeoutPollInterval)
    const pollInterval = ms(decoratorOptions.pollInterval || Math.max(timeout * pollFactor, minimumPollInterval))
    const onError = decoratorOptions.onError || defaultOnError
    const createTimeoutError = decoratorOptions.createTimeoutError || defaultCreateTimeoutError

    debug('options: %o', {
      disabled,
      namespace,
      ttl,
      timeout,
      pollFactor,
      minimumPollInterval,
      pollInterval,
    })

    // input the underlying function
    return fn => {
      if (typeof fn !== 'function') throw new TypeError('Decorated input must be a function!')
      // return the decorated version of the function

      return Promise.coroutine(function * () {
        // get the arguments
        const args = []
        for (let i = 0; i < arguments.length; i++) args.push(arguments[i])

        // bypass the cache
        if (disabled) return executeFunction(fn, args)

        // create a hash of the arguments
        const hash = createHash(args)

        // check whether it's running or anything
        let state = yield getCurrentState()

        // return the cached version
        if (state.value) return JSON.parse(state.value)

        // cleanup listeners when listing for events
        let cleanupListeners = noop
        // whether cleanup has already happened
        let cleaned = false
        // whether execution has occured already
        let executed = false
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
          state = yield getCurrentState()
          // the chance of this happening (setting a result when executing SETNX) is very low
          /* istanbul ignore if */
          if (state.value) {
            cleanupListeners()
            resultPromise.catch(onError)  // always handle the promise
            return JSON.parse(state.value)
          }
          // if it's not running, execute again
          // but why would this happen?
          /* istanbul ignore next */
          if (!state.running) {
            resultPromise.catch(onError) // always handle the promise
            return yield execute()
          }
          return yield resultPromise
        }

        return yield execute()

        // executes the result
        function execute () {
          debug('executing')

          {
            // cleanup listeners just in case
            cleanupListeners()
            // if we're executing after a failed set,
            // set it again just in case
            const batch = client.multi()
            batch.setnx(`${hash}:running`, EXEC_ID)
            // set a timeout
            client.pexpire(`${hash}:running`, timeout)
            batch.exec().catch(onError)
          }

          let timeout_id
          const timeout_promise = new Promise((resolve, reject) => {
            timeout_id = pollCurrentState(resolve, reject)
          })

          const execution_promise = executeFunction(fn, args).then(value => {
            cleanupTimeout()
            debug('returned value: %o', value)
            const json = stringify(value) // story it as a string
            const batch = client.multi()
              .del(`${hash}:running`, `${hash}:error`)
              .publish(`${hash}:value`, json) // publish the result to all listeners
            // only cache if a TTL is set
            if (ttl) batch.set(`${hash}:value`, json, 'PX', ttl)
            batch.exec().catch(onError)
            return value
          }).catch(_err => {
            cleanupTimeout()
            // handle errors
            const err = stringifyError(_err)
            client.multi()
              .del(`${hash}:running`, `${hash}:value`)
              // publish the error to all listeners
              .publish(`${hash}:error`, err)
              .exec().catch(onError)
            throw _err
          })

          return Promise.race([
            timeout_promise,
            execution_promise,
          ])

          function cleanupTimeout () {
            debug('execution is done!')
            executed = true
            clearInterval(timeout_id)
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

        function pollCurrentState (resolve, reject) {
          return setInterval(() => {
            debug('polling for state')
            getCurrentState().then(val => {
              debug('polled for state')
              debug('cleaned: %s', cleaned)
              debug('executed: %s', executed)

              state = val
              // we check here incase cleanup happens during `getCurrentState()` is resolving
              // though I guess it really doesn't matter because resolve/reject is smart
              /* istanbul ignore if */
              if (cleaned || executed) return

              // set somehow, i guess if two functions were running concurrently
              /* istanbul ignore if */
              if (state.value) {
                cleanupListeners()
                try {
                  resolve(JSON.parse(state.value))
                } catch (err) {
                  /* istanbul ignore next */
                  reject(err)
                }
                return
              }

              // no longer running
              if (!state.running) {
                cleanupListeners()
                reject(createTimeoutError())
                return
              }
            }).catch(onError)
          }, pollInterval)
        }

        // wait for the result from redis channels
        function waitForResult () {
          debug('waiting for result')
          // subscribe to the channels
          const pattern = `${hash}:*`
          // timeout for polling
          let timeout_id

          return new Promise((resolve, reject) => {
            // expose the cleanup function outside the scope
            cleanupListeners = cleanup

            subscriber.psubscribe(pattern).catch(reject)

            // add a message handler
            subscriber.setMaxListeners(subscriber.getMaxListeners() + 1)
            subscriber.on('pmessage', listener)

            // poll to check the state
            // NOTE: was thinking of using keyevents,
            // but this is better because you need to access the key
            // to trigger an eviction anyways
            timeout_id = pollCurrentState(resolve, reject)

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
                  reject(parseError(message))
                } catch (err) {
                  // when would this happen?
                  /* istanbul ignore next */
                  reject(err)
                }
              }
            }

            function cleanup () {
              debug('cleaning up waiting for the result')
              cleaned = true
              clearInterval(timeout_id)
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

function noop () {}

function ms (value) {
  switch (typeof value) {
    case 'string': return _ms(value)
    case 'number': return Math.round(value)
  }
  /* istanbul ignore next */
  throw new TypeError('Only strings and functions are supported.')
}

function _createTimeoutError () {
  const err = new Error('Timed out!')
  err.code = 'RCDTIMEDOUT'
  return err
}

function executeFunction (fn, args) {
  try {
    return Promise.resolve(fn.apply(null, args))
  } catch (err) {
    return Promise.reject(err)
  }
}

function stringifyError (_err) {
  return JSON.stringify(_err, [
    'message',
    'arguments',
    'type',
    'name',
    'stack'
  ])
}

function parseError (message) {
  const _err = JSON.parse(message)
  const err = new Error(_err.message)
  for (const key of Object.keys(_err)) {
    if (key === 'message') continue // already set
    Object.defineProperty(err, key, {
      value: _err[key],
      configurable: true,
      writable: true,
      enumerable: true,
    })
  }
  return err
}

function isNumberOrString (val) {
  const type = typeof val
  return type === 'string' || type === 'number'
}
