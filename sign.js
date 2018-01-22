var CONFIG = require('./config.js');
var pu = require('./privateUtil.js');
var createNonceStr = function() {
  return Math.random().toString(36).substr(2, 15);
};

var createTimestamp = function() {
  return parseInt(new Date().getTime() / 1000) + '';
};

/**
 * @synopsis 签名算法 
 *
 * @param jsapi_ticket 用于签名的 jsapi_ticket
 * @param url 用于签名的 url ，注意必须动态获取，不能 hardcode
 *
 * @returns
 */
var sign = function(jsapi_ticket, url) {
  var ret = {
    jsapi_ticket: jsapi_ticket,
    nonceStr: createNonceStr(),
    timestamp: createTimestamp(),
    url: url
  };
  var string = pu.raw(ret, false);
  jsSHA = require('jssha');
  shaObj = new jsSHA(string, 'TEXT');
  ret.signature = shaObj.getHash('SHA-1', 'HEX');
  ret.appId = CONFIG.WECHAT.APPID
  ret.debug = CONFIG.WECHAT.DEBUG
  return ret;
};

module.exports = sign;