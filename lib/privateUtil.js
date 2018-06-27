var CONFIG = require('../config.js');
var jsSHA = require('jssha');
var crypto = require('crypto');
module.exports.raw = function(args, isFilterCode) {
  return _raw(args, isFilterCode);
};
module.exports.md5 = function(bytes) {
  if (typeof Buffer.from === 'function') {
    // Modern Buffer API
    if (Array.isArray(bytes)) {
      bytes = Buffer.from(bytes);
    } else if (typeof bytes === 'string') {
      bytes = Buffer.from(bytes, 'utf8');
    }
  } else {
    // Pre-v4 Buffer API
    if (Array.isArray(bytes)) {
      bytes = new Buffer(bytes);
    } else if (typeof bytes === 'string') {
      bytes = new Buffer(bytes, 'utf8');
    }
  }

  return crypto.createHash('md5').update(bytes).digest();
}

module.exports.wxSignature = function(obj) {
  let string = _raw(obj, false);
  shaObj = new jsSHA(string, 'TEXT');
  return shaObj.getHash('SHA-1', 'HEX');
}
module.exports.createNonceStr = function() {
  return Math.random().toString(36).substr(2, 15);
};

module.exports.createTimestamp = function() {
  return parseInt(new Date().getTime() / 1000) + '';
};

function _raw(args, isFilterCode) {
  var keys = Object.keys(args);
  keys = keys.sort()
  var newArgs = {};
  keys.forEach(function(key) {
    newArgs[key.toLowerCase()] = args[key];
  });

  var string = '';
  for (var k in newArgs) {
    if (!(isFilterCode && (k == 'code' || k == 'state'))) {
      string += '&' + k + '=' + newArgs[k];
    }
  }
  if (string.length > 0) {
    string = string.substr(1);
  }
  return string;
};

module.exports.cleanedUrl = function(req) {
  cleanedQueryString = this.raw(req.query, true)
  if (cleanedQueryString.length > 0) {
    // return req.protocol + '://' + req.hostname + req.url.split('?')[0] + '?' + cleanedQueryString
    return 'https://' + req.hostname + req.url.split('?')[0] + '?' + cleanedQueryString
  } else {
    // return req.protocol + '://' + req.hostname + req.url.split('?')[0]
    return 'https://' + req.hostname + req.url.split('?')[0]
  }
};
module.exports.formatDateToDay = function(activityDateTime) {
  if (activityDateTime instanceof Date) {
    return activityDateTime.getFullYear().toString().substr(2) + '年' + (activityDateTime.getMonth() + 1) + '月' + activityDateTime.getDate() + '日'
  } else {
    tmpDate = new Date(activityDateTime)
    return tmpDate.getFullYear().toString().substr(2) + '年' + (tmpDate.getMonth() + 1) + '月' + tmpDate.getDate() + '日'
  }
}

Array.prototype.each = function(trans) {
  for (var i = 0; i < this.length; i++)
    this[i] = trans(this[i], i, this);
  return this;
};
Array.prototype.map = function(trans) {
  return [].concat(this).each(trans);
};
RegExp.escape = function(str) {
  return new String(str).replace(/([.*+?^=!:${}()|[\]\/\\])/g, '\\$1');
};

function properties(obj) {
  var props = [];
  for (var p in obj) props.push(p);
  return props;
}
// ---------------------------------------------

module.exports.renderHtml = function(str, replacements) {
  var regex = new RegExp(properties(replacements).map(RegExp.escape).join("|"), "g");
  var str = str.replace(regex, function($0) {
    return replacements[$0];
  });
  return str
};
module.exports.viewUrl = function(activityId) {
  return 'https://' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/?#/activity_view?activity_id=' + activityId.toString()
};
module.exports.manageApplyUrl = function(activityId) {
  return 'https://' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/?#/applys_manage?activity_id=' + activityId.toString()
};