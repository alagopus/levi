var test = require('tape')
var ginga = require('ginga')
var transaction = require('level-transactions')

var levi = require('../')
var H = require('highland')

var lv
test('clean up', function (t) {
  levi.destroy('./test/db', function (err) {
    t.notOk(err, 'destroy')

    lv = levi('./test/db')
    .use(levi.tokenizer())
    .use(levi.stemmer())
    .use(levi.stopword())
    .use(ginga().use('pipeline', function (ctx, next) {
      setTimeout(next, 1) // make pipeline async
    }))

    t.end()
  })
})

test('pipeline', function (t) {
  t.plan(7)

  lv.pipeline('including a foo !a!b!c! of instanceof constructor.', function (err, tokens) {
    t.notOk(err)
    t.deepEqual(tokens, [
      'includ', 'foo', 'abc', 'instanceof', 'constructor'
    ], 'stemmer, stopwords, js reserved words')
    lv.pipeline(tokens, function (err, tokens2) {
      t.notOk(err)
      t.deepEqual(tokens, tokens2, 'idempotent')
    })
  })

  lv.pipeline({
    a: 'foo bar is a placeholder name',
    b: ['foo', 'bar'],
    c: 167,
    d: null,
    e: { ghjk: ['printing'] }
  }).then(function (tokens) {
    t.deepEqual(tokens, [
      'foo', 'bar', 'placehold', 'name', 'foo', 'bar', 'print'
    ], 'text extraction from object')
  }).catch(function (err) {
    t.error(err)
  })

  var cyclic = { a: 'foo', b: { asdf: 'bar' } }
  cyclic.b.boom = cyclic

  lv.pipeline(cyclic, function (err) {
    t.equal(err.message, 'Cycle detected')
  })

  lv.put('boom', cyclic).then(function () {
    t.error(true)
  }).catch(function (err) {
    t.equal(err.message, 'Cycle detected')
  })
})

test('CRUD', function (t) {
  var aObj = {
    a: 'hello world'
  }

  H('put', lv).pluck('key').take(10).toArray(function (keys) {
    t.deepEqual(keys, [
      'a', 'b',
      'ar', 'c',
      'ar', 'c',
      'ar', 'c',
      'd', 'd'
    ], 'put emitter')
    // must not include error operations
  })

  H('del', lv).pluck('key').take(2).toArray(function (keys) {
    t.deepEqual(keys, ['ar', 'c'], 'del emitter')
    // must not include error operations
  })

  lv.put('a', aObj, function () {
    lv.get('a', function (err, value) {
      t.notOk(err)
      t.deepEqual(value, aObj, 'put object')
    })
  })

  var bText = 'Lorem Ipsum is simply dummy text of the printing and typesetting industry.'
  lv.put('b', new Buffer(bText), function () {
    lv.get('b', function (err, value) {
      t.notOk(err)
      t.equal(value, bText, 'put buffer')
      t.equal(typeof value, 'string', 'buffer converted to string')
    })
  })

  for (var i = 0; i < 10; i++) {
    lv.batch([
      {type: 'put', key: 'on99' + i, value: 'on99'},
      {type: 'put', key: 'abc'}, // error
      {type: 'del', key: '167'}
    ], function (err) {
      t.ok(err, 'batch error')
    })
  }

  var ar = ['hello', 'printing', 'a']
  var cText = 'Aldus PageMaker including versions of Lorem Ipsum.'

  lv.batch([
    {type: 'put', key: 'ar', value: ar},
    {type: 'put', key: 'c', value: cText},
    {type: 'del', key: 'ar'},
    {type: 'del', key: 'c'},
    {type: 'put', key: 'ar', value: ar}, // repeated put
    {type: 'put', key: 'c', value: cText},
    {type: 'put', key: 'ar', value: ar},
    {type: 'put', key: 'c', value: cText}
  ], function (err) {
    t.notOk(err, 'batch put')
    lv.get('ar', function (err, value) {
      t.notOk(err)
      t.deepEqual(value, ar, 'put array')
    })
    lv.get('c', function (err, value) {
      t.notOk(err)
      t.equal(value, cText, 'put string')
    })
  })

  lv.put('d', 'Rick rolling', function (err) {
    t.notOk(err)
    lv.searchStream('rolling and hatin').toArray(function (arr) {
      t.equal(arr.length, 1, 'correct put')
      t.equal(arr[0].key, 'd', 'correct put')
      t.equal(arr[0].value, 'Rick rolling', 'correct put')
      lv.put('d', 'Rick Ashley', function (err) {
        t.notOk(err)
        lv.searchStream('rolling').toArray(function (arr) {
          t.equal(arr.length, 0, 'correct clean up')
          lv.searchStream('ashley').toArray(function (arr) {
            t.equal(arr.length, 1, 'correct upsert')
            t.equal(arr[0].key, 'd', 'correct upsert')
            t.equal(arr[0].value, 'Rick Ashley', 'correct upsert')

            t.end()
          })
        })
      })
    })
  })
})

function tearDown () {
  test('size and tear down', function (t) {
    lv.readStream().pluck('key').toArray(function (keys) {
      lv.meta.get('size', function (err, size) {
        t.notOk(err)
        t.equal(size, keys.length, 'size correct')

        // use a non-root db
        var tx = transaction(lv.db.sublevel('whatever'))

        keys.forEach(function (key) {
          // passing transaction to operations
          lv.del(key, {transaction: tx})
        })

        tx.commit(function (err) {
          t.notOk(err)
          lv.meta.get('size', function (err, size) {
            t.notOk(err && !err.notFound)
            t.notOk(size, 'empty after delete all')
            t.end()
          })
        })
      })
    })
  })
}

tearDown()

var list = [{
  id: 'a',
  title: 'Mr. Green kills Colonel Mustard',
  body: 'Mr. Green killed Colonel Mustard in the study with the candlestick. ' +
    'Mr. Green is not a very nice fellow.'
}, {
  id: 'b',
  title: 'Plumb waters plant',
  body: 'Professor Plumb has a green plant in his study'
}, {
  id: 'c',
  title: 'Scarlett helps Professor',
  body: 'Miss Scarlett watered Professor Plumbs green plant while he was away ' +
    'from his office last week.'
}, {
  id: 'd',
  title: 'foo',
  body: 'bar'
}]

test('Search options', function (t) {
  t.plan(22)

  lv.batch(list.map(function (doc) {
    return {type: 'put', key: doc.id, value: doc}
  }), function () {
    lv.readStream({gt: 'a'}).pluck('value').toArray(function (arr) {
      t.deepEqual(arr, list.slice(1), 'readStream')
    })

    lv.searchStream('green plant').toArray(function (arr) {
      t.equal(arr.length, 3, 'search: correct number of results')
      t.ok(arr[0].score, 'search: contains score')
      t.equal(arr[0].key, 'b', 'search: correct key')
      t.deepEqual(arr[0].value, list[1], 'search: correct value')

      lv.searchStream(['green', 'plant']).toArray(function (arr2) {
        t.deepEqual(arr2, arr, 'tokenized query')
      })

      lv.searchStream('green plant', { offset: 1 }).toArray(function (arr2) {
        t.deepEqual(arr2, arr.slice(1), 'query offset')
      })

      lv.searchStream('green plant', { limit: 1 }).toArray(function (arr2) {
        t.deepEqual(arr2, arr.slice(0, 1), 'limit')
      })

      lv.searchStream('green pla', { expansions: 10 }).toArray(function (arr2) {
        t.deepEqual(arr2, arr, 'expansions')
      })
    })

    lv.scoreStream('green plant').pluck('key').toArray(function (arr) {
      t.deepEqual(arr, ['a', 'b', 'c'], 'scoreStream')
    })

    lv.searchStream('green plant', { gt: 'b' }).toArray(function (arr) {
      t.equal(arr.length, 1, 'gt correct # of result')
      t.equal(arr[0].key, 'c', 'gt correct first result')
    })

    lv.searchStream('green', { fields: ['title'] }).toArray(function (arr) {
      t.equal(arr.length, 1, 'fielded: correct number of results')
      t.equal(arr[0].key, 'a', 'fielded: correct result')
    })

    lv.searchStream('watering plant', { fields: { title: 1, body: 10 } }).toArray(function (arr) {
      t.equal(arr.length, 2, 'field boosting: correct number of results')
      t.equal(arr[0].key, 'c', 'field boosting: correct boosted result')
    })

    lv.searchStream('watering plant', { fields: { title: 1, body: 10 }, lt: 'c' }).toArray(function (arr) {
      t.equal(arr.length, 1, 'upper bound: correct number of results')
      t.equal(arr[0].key, 'b', 'upper bound: correct boosted result')
    })

    lv.searchStream({
      title: 'Professor Plumb loves plant',
      message: 'He has a green plant in his study'
    }).toArray(function (arr) {
      t.equal(arr.length, 3, 'object search: correct number of results')
      H(arr).pluck('key').toArray(function (arr) {
        t.deepEqual(arr, ['b', 'c', 'a'], 'object search: correct order')
      })
    })

    lv.termStream({
      limit: 1,
      prefix: 'plumb'
    }).toArray(function (arr) {
      t.equal(arr.length, 1, 'term search: finds prefix inclusive')
      t.deepEqual(arr, [ { key: '@plumb', value: 2 } ], 'term search: first and sole document')
    })
  })
})

tearDown()

test('Index-time field options', function (t) {
  lv.batch(list.map(function (doc, i) {
    return {
      type: 'put',
      key: doc.id,
      value: doc,
      fields: i % 2 === 0
        ? { body: true } // obj field
        : ['body'] // array field
    }
  }), function () {
    lv.searchStream('watering plant').toArray(function (arr) {
      t.equal(arr.length, 2, 'field filter: correct number of results')
      t.equal(arr[0].key, 'c', 'field filter: correct scoring')
      t.end()
    })
  })
})

tearDown()
