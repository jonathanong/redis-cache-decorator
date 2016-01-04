'use strict'

const Promise = require('bluebird')
const _ms = require('ms')

// these errors would only happen on network errors
/* istanbul ignore next */
exports._onError = function _onError (err) {
  /* eslint no-console: 0 */
  if (err) console.error(err.stack)
}

exports.noop = function noop () {}

exports.ms = function ms (value) {
  switch (typeof value) {
    case 'string': return _ms(value)
    case 'number': return Math.round(value)
  }
  /* istanbul ignore next */
  throw new TypeError('Only strings and functions are supported.')
}

exports._createTimeoutError = function _createTimeoutError () {
  const err = new Error('Timed out!')
  err.code = 'RCDTIMEDOUT'
  return err
}

exports.executeFunction = function executeFunction (fn, args) {
  try {
    return Promise.resolve(fn.apply(null, args))
  } catch (err) {
    return Promise.reject(err)
  }
}

exports.stringifyError = function stringifyError (_err) {
  return JSON.stringify(_err, [
    'message',
    'arguments',
    'type',
    'name',
    'stack'
  ])
}

exports.parseError = function parseError (message) {
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

exports.isNumberOrString = function isNumberOrString (val) {
  const type = typeof val
  return type === 'string' || type === 'number'
}
