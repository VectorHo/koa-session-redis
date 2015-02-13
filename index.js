'use strict';
/**
 * Module dependencies.
 */

var debug = require('debug')('koa-session-redis'),
    uid = require('uid2'),
    thunkify = require('thunkify'),
    redis = require('redis');

/**
 * Initialize session middleware with `opts`:
 *
 * - `key` session cookie name ["koa:sess"]
 * - all other options are passed as cookie options
 *
 * @param {Object} [opts]
 * @api public
 */

module.exports = function (opts) {
  var key, client, redisOption, cookieOption;

  opts = opts || {};
  // key
  key = opts.key || 'koa:sess';
  debug('key config is: %s', key);

  //redis opts
  redisOption = opts.store || {};
  debug('redis config all: %j', redisOption);
  debug('redis config port: %s', redisOption.port || (redisOption.port = 6379));
  debug('redis config host: %s', redisOption.host || (redisOption.host = '127.0.0.1'));
  debug('redis config options: %j', redisOption.options || (redisOption.options = {}));
  debug('redis config db: %s', redisOption.db || (redisOption.db = 0));
  debug('redis config ttl: %s', redisOption.ttl);

  //cookies opts
  cookieOption = opts.cookie || {};
  debug('cookie config all: %j', cookieOption);
  debug('cookie config overwrite: %s', (cookieOption.overwrite === false) ? false : (cookieOption.overwrite = true));
  debug('cookie config httpOnly: %s', (cookieOption.httpOnly === false) ? false : (cookieOption.httpOnly = true));
  debug('cookie config signed: %s', (cookieOption.signed === false) ? false : (cookieOption.signed = true));
  debug('cookie config maxage: %s', (typeof cookieOption.maxage !== 'undefined') ? cookieOption.maxage : (cookieOption.maxage = redisOption.ttl * 1000 || null));

  //redis client for session
  client = redis.createClient(
    redisOption.port,
    redisOption.host,
    redisOption.options
  );

  client.select(redisOption.db, function () {
    debug('redis changed to db %d', redisOption.db);
  });

  client.get = thunkify(client.get); // 普通回调转换成Generator接收的函数
  client.set = thunkify(client.set);
  client.del = thunkify(client.del);
  client.ttl = redisOption.ttl ? function expire(key) { client.expire(key, redisOption.ttl); }: function () {};

  client.on('connect', function () {
    debug('redis is connecting');
  });

  client.on('ready', function () {
    debug('redis ready');
    debug('redis host: %s', client.host);
    debug('redis port: %s', client.port);
    debug('redis parser: %s', client.reply_parser.name);
    debug('redis server info: %j', client.server_info);
  });

  client.on('reconnect', function () {
    debug('redis is reconnecting');
  });

  client.on('error', function (err) {
    debug('redis encouters error: %j', err.stack || err);
  });

  client.on('end', function () {
    debug('redis connection ended');
  });

  return function *(next) {
    var sess, sid, json;

    // to pass to Session()
    this.cookieOption = cookieOption;
    this.sessionKey = key;
    this.sessionId = null;

    sid = this.cookies.get(key, cookieOption);

    if (sid) {
      debug('sid %s', sid);
      try {
        json = yield client.get(sid); // 根据sid取出session数据
      }catch (e) {
        debug('encounter error %s', e);
        json = null;
      }
    }

    if (json) { // 放入sess
      this.sessionId = sid;
      debug('parsing %s', json);
      try {
        sess = new Session(this, JSON.parse(json), client);
      } catch (err) {
        // backwards compatibility:
        // create a new session if parsing fails.
        // `JSON.parse(string)` will crash.
        if (!(err instanceof SyntaxError)) throw err;
        sess = new Session(this, null, client);
      }
    } else { // 创建一个sess
      sid = this.sessionId = uid(24);
      debug('new session');
      sess = new Session(this, null, client);
    }

    this.__defineGetter__('session', function () {
      // already retrieved
      if (sess) return sess;
      // unset
      if (false === sess) return null;
    });

    this.__defineSetter__('session', function (val) {
      if (null === val) return sess = false;
      if ('object' === typeof val) return sess = new Session(this, val);
      throw new Error('this.session can only be set as null or an object.');
    });

    try {
      yield *next; // 把传入next函数指定为generator函数，就是一个generator里面嵌套一个generator
    } catch (err) { // 捕获下游的异常
      throw err;
    } finally {
      if (undefined === sess) {
        // not accessed
      } else if (false === sess) {
        // remove
        this.cookies.set(key, '', cookieOption);
        yield client.del(sid);
      } else if (!json && !sess.length) {
        // do nothing if new and not populated
      } else if (sess.changed(json)) {
        // save
        json = sess.save();
        yield client.set(sid, json);
        client.ttl(sid);
      }
    }
  };
};

/**
 * Session model.
 *
 * @param {Context} ctx
 * @param {Object} obj
 * @api private
 */

function Session(ctx, obj, client) {
  this._ctx = ctx;
  if (!obj) this.isNew = true;
  else for (var k in obj) this[k] = obj[k];
  if(client) this.client = client; // hack
}

/**
 * del redis's sess by other's sid
 *
 * @return {Object}
 * @api public
 */

Session.prototype.del = function (sid) {
  this.client.del(sid); // generator-base flow
};

/**
 * JSON representation of the session.
 *
 * @return {Object}
 * @api public
 */

Session.prototype.inspect =
  Session.prototype.toJSON = function () {
  var self = this;
  delete self.client;
  var obj = {};

  Object.keys(this).forEach(function (key) {
    if ('isNew' === key) return;
    if ('_' === key[0]) return;
    obj[key] = self[key];
  });

  return obj;
};

/**
 * Check if the session has changed relative to the `prev`
 * JSON value from the request.
 *
 * @param {String} [prev]
 * @return {Boolean}
 * @api private
 */

Session.prototype.changed = function (prev) {
  if (!prev) return true;
  var that = this;
  delete that.client;
  this._json = JSON.stringify(that);
  return this._json !== prev;
};

/**
 * Return how many values there are in the session object.
 * Used to see if it's "populated".
 *
 * @return {Number}
 * @api public
 */

Session.prototype.__defineGetter__('length', function () {
  return Object.keys(this.toJSON()).length;
});

/**
 * populated flag, which is just a boolean alias of .length.
 *
 * @return {Boolean}
 * @api public
 */

Session.prototype.__defineGetter__('populated', function () {
  return !!this.length;
});

/**
 * Save session changes by
 * performing a Set-Cookie.
 *
 * @api private
 */

Session.prototype.save = function () {
  var that = this;
  delete that.client;
  var ctx = this._ctx,
      json = this._json || JSON.stringify(that),
      sid = ctx.sessionId,
      opts = ctx.cookieOption,
      key = ctx.sessionKey;

  debug('save %s', json);
  ctx.cookies.set(key, sid, opts);
  return json;
};
