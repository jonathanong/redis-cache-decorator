'use strict'

/* eslint camelcase: 0 */

const debug = require('debug')('redis-cache-decorator')
const toArray = require('stream-to-array')
const Promise = require('bluebird')
const destroy = require('destroy')
const Stream = require('stream')
const assert = require('assert')

const ENCODINGS = require('./encodings')
const utils = require('./utils')

// create a base
module.exports = constOptions => {
  assert(constOptions, 'Constructor options are required!')
  const client = constOptions.client
  const subscriber = constOptions.subscriber
  assert(client, 'A redis client as `.client` is required!')
  assert(subscriber, 'A redis subscription client as `.subscriber` is required!')

  // easy way to disabled
  const disabled = constOptions.disabled || constOptions.disable || false
  // prefix
  const constNamespace = constOptions.namespace || ''
  const defaultEncoding = constOptions.encoding || 'json'
  assert(ENCODINGS.has(defaultEncoding), `Encoding is not supported: ${defaultEncoding}`)
  // 30 seconds
  const defaultTTL = utils.isNumberOrString(constOptions.ttl)
    ? utils.ms(constOptions.ttl)
    : utils.ms('30s')
  // prefix
  const defaultTimeout = utils.isNumberOrString(constOptions.timeout)
    ? utils.ms(constOptions.timeout)
    : utils.ms('30s')
  // onError
  const defaultOnError = constOptions.onError || utils._onError
  // default poll factor based on the timeout
  const defaultPollFactor = constOptions.pollFactor || (1 / 10)
  // default minimum poll interval in ms
  const defaultMinimumTimeoutPollInterval = utils.ms(constOptions.minimumPollInterval || 100)
  // function to create a time out error
  const defaultCreateTimeoutError = constOptions.createTimeoutError || utils._createTimeoutError

  // add decorator options
  return decoratorOptions => {
    if (typeof decoratorOptions !== 'object') throw new TypeError('Decorator options are required!')
    if (typeof decoratorOptions.namespace !== 'string') throw new TypeError('A .namespace is required for each decorator.')
    const namespace = [constNamespace, decoratorOptions.namespace].join(':')
    const encoding = decoratorOptions.encoding || defaultEncoding
    const encoder = ENCODINGS.get(encoding)
    assert(encoder, `Encoding is not supported: ${encoding}`)
    const ttl = utils.ms(utils.isNumberOrString(decoratorOptions.ttl)
      ? decoratorOptions.ttl
      : defaultTTL)
    const timeout = utils.ms(utils.isNumberOrString(decoratorOptions.timeout)
      ? decoratorOptions.timeout
      : defaultTimeout)
    assert(timeout > 0, 'The timeout must be > 0')
    const pollFactor = decoratorOptions.pollFactor || defaultPollFactor
    const minimumPollInterval = utils.ms(utils.isNumberOrString(decoratorOptions.minimumPollInterval)
      ? decoratorOptions.minimumPollInterval
      : defaultMinimumTimeoutPollInterval)
    const pollInterval = utils.ms(decoratorOptions.pollInterval || Math.max(timeout * pollFactor, minimumPollInterval))
    const onError = decoratorOptions.onError || defaultOnError
    const createTimeoutError = decoratorOptions.createTimeoutError || defaultCreateTimeoutError

    debug('options: %o', {
      disabled,
      namespace,
      ttl,
      timeout,
      pollFactor,
      minimumPollInterval,
      pollInterval
    })

    // input the underlying function
    return fn => {
      if (typeof fn !== 'function') throw new TypeError('Decorated input must be a function!')

      // main logic
      const exec = Promise.coroutine(function * (args, hash) {
        // check whether it's running or anything
        let state = yield getCurrentState()

        // return the cached version
        if (state.value != null) return encoder.decode(state.value)

        // cleanup listeners when listing for events
        let cleanupListeners = utils.noop
        // whether cleanup has already happened
        let cleaned = false
        // whether execution has occured already
        let executed = false
        // whether the result is as a stream
        let stream = null
        // if it's currently running, wait for the value
        if (state.running) return yield waitForResult()

        // execute - might need something like this for the redlock algorithm?
        const EXEC_ID = Date.now() + Math.random().toString(36)
        // note in redis that it's running
        // don't wait for a response - might avoid some race conditions
        const isSet = yield client.setnx(`${hash}:running`, EXEC_ID)
        if (isSet) return yield execute() // we set it, so we execute

        /* someone else is setting it... */

        // start listening for the result
        const resultPromise = waitForResult()
        // check whether the result has been saved in the mean time
        state = yield getCurrentState()

        // the chance of this happening (setting a result when executing SETNX) is very low
        if (state.value != null) {
          cleanupListeners()
          resultPromise.catch(onError)  // always handle the promise
          return encoder.decode(state.value)
        }

        // if it's not running, execute again
        // but why would this happen?
        if (!state.running) {
          resultPromise.catch(onError) // always handle the promise
          return yield execute()
        }

        return yield resultPromise

        // if the current query is a stream, try to destroy it if we're returning data
        // TODO: tests
        function destroyCurrentStream () {
          if (stream) destroy(stream)
        }

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

          // promise that polls whether the function has timed out
          let timeout_id
          const timeout_promise = new Promise((resolve, reject) => {
            timeout_id = pollCurrentState(resolve, reject)
          })

          // promise that actuall executes the function
          // NOTE: execution still completes and saves even if timed out
          const execution_promise = utils.executeFunction(fn, args)
          .then(streamToValue)
          .then(value => {
            cleanupTimeout()
            return setValue(hash, value).catch(onError)
          }).catch(_err => {
            cleanupTimeout()
            // handle errors
            const err = utils.stringifyError(_err)
            client.multi()
              .del(`${hash}:running`, `${hash}:value`)
              // publish the error to all listeners
              .publish(`${hash}:error`, err)
              .exec().catch(onError)
            throw _err
          })

          return Promise.race([
            timeout_promise,
            execution_promise
          ])

          function cleanupTimeout () {
            debug('execution is done!')
            executed = true
            clearInterval(timeout_id)
          }
        }

        // converts a stream response into a value that can be saved in redis
        function streamToValue (value) {
          // handle streams
          if (value && typeof value.pipe === 'function' && value._readableState) {
            // expose the stream
            stream = value

            switch (encoding) {
              case 'json': {
                assert(value._readableState.objectMode, 'I do not know how to handle streams that are not in `objectMode` when saving in with encoding = `json`. Please change your `encoding=` option to `string` or `buffer`')
                // just convert it to an array
                return toArray(value)
              }
              case 'string': {
                value.setEncoding('utf8')
                return toArray(value).then(arr => arr.join(''))
              }
              case 'buffer': {
                return toArray(value).then(arr => Buffer.concat(arr))
              }
            }
          }

          /* istanbul ignore if */
          if (value instanceof Stream) {
            throw new Error('I do not know how to handle this type of stream. It does not have a `.pipe()` function or it does not have a `._readableState.`')
          }

          return value
        }

        // get whether there's a cached value and/or if a query is currently running
        function getCurrentState () {
          const formatResults = results => {
            const state = {
              value: results[0],
              running: results[1]
            }
            debug('state: %o', state)
            return state
          }

          if (encoding === 'buffer') {
            // TODO: should really be using `.multi()` here, but `getBuffer()` is broken in it
            return Promise.all([
              client.getBuffer(`${hash}:value`),
              client.get(`${hash}:running`)
            ]).then(formatResults)
          }

          return client.mget([
            `${hash}:value`,
            `${hash}:running`
          ]).then(formatResults)
        }

        // poll for updates to the state
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
              if (cleaned || executed) return

              // set somehow, i guess if two functions were running concurrently
              if (state.value != null) {
                cleanupListeners()
                destroyCurrentStream()
                try {
                  resolve(encoder.decode(state.value))
                } catch (err) {
                  /* istanbul ignore next */
                  reject(err)
                }
                return
              }

              // no longer running
              if (!state.running) {
                cleanupListeners()
                destroyCurrentStream()
                reject(createTimeoutError())
                return
              }
            }).catch(onError)
          }, pollInterval)
        }

        // wait for the result from redis channels and polling
        function waitForResult () {
          debug('waiting for result')
          // subscribe to the channels
          const pattern = `${hash}:*`

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
            // timeout for polling
            const timeout_id = pollCurrentState(resolve, reject)

            function listener (pattern, channel, message) {
              if (channel === `${hash}:value`) {
                cleanup()
                debug('message: %s', message)

                // i don't know how to transfer buffer's as a message
                if (encoding === 'buffer') {
                  return getCurrentState().then(_val => {
                    state = _val
                    return encoder.decode(state.value)
                  }).then(resolve, reject)
                }

                try {
                  resolve(encoder.decode(message))
                } catch (err) {
                  // when would this happen?
                  /* istanbul ignore next */
                  reject(err)
                }
              } else if (channel === `${hash}:error`) {
                cleanup()
                try {
                  reject(utils.parseError(message))
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
              subscriber.removeListener('pmessage', listener)
              subscriber.setMaxListeners(subscriber.getMaxListeners() - 1)
            }
          })
        }
      })

      // set a value directly
      wrappedFunction.set = setValue

      // expose a function to create a hash based on the args
      wrappedFunction.createHash = function createHash () {
        // get the arguments
        const args = []
        for (let i = 0; i < arguments.length; i++) args.push(arguments[i])
        return utils.createHash(namespace, args)
      }

      // return the decorated version of the function
      return wrappedFunction

      function wrappedFunction () {
        // get the arguments
        const args = []
        for (let i = 0; i < arguments.length; i++) args.push(arguments[i])

        // bypass the cache
        if (disabled) return utils.executeFunction(fn, args)

        // create a hash of the arguments
        const hash = utils.createHash(namespace, args)

        // create a promise for the execution
        const promise = exec(args, hash)

        // attach the has to the promise
        Object.assign(promise, {
          hash
        })

        // return the promise
        return promise
      }

      // set the value of the response
      function setValue (hash, value) {
        debug('returned value: %o', value)
        const encodedValue = encoder.encode(value) // story it as a string
        debug('encoded value: %o', encodedValue)
        const batch = client.multi()
          .del(`${hash}:running`, `${hash}:error`)
          // NOTE: don't know how buffers transmit over pubsub
          .publish(`${hash}:value`, encoding === 'buffer' ? '1' : encodedValue) // publish the result to all listeners
        // only cache if a TTL is set
        if (ttl) {
          if (encoding === 'buffer') {
            client.set(`${hash}:value`, encodedValue, 'PX', ttl).catch(onError)
          } else {
            batch.set(`${hash}:value`, encodedValue, 'PX', ttl)
          }
        }

        return batch.exec()
          .then(() => value)
      }
    }
  }
}
