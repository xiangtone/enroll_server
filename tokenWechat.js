var CONFIG = require('./config.js');
var globalInfo = require('./globalInfo.js');
var log4js = require('log4js');
var mysql = require('mysql');
var logger = log4js.getLogger();
logger.setLevel(CONFIG.LOG_LEVEL);

var dbPool = mysql.createPool({
  host: CONFIG.DBTOKEN.HOST,
  user: CONFIG.DBTOKEN.USER,
  password: CONFIG.DBTOKEN.PASSWORD,
  database: CONFIG.DBTOKEN.DATABASE,
  port: CONFIG.DBTOKEN.PORT
});

var tokenWechat = function() {

  freshToken();
  setInterval(freshToken, CONFIG.WECHAT.TOKEN_REFRESH_INTERVAL);
  var currentTimestamp

  function freshToken() {
    currentTimestamp = new Date().getTime();
    if (currentTimestamp - globalInfo.token.validTime > CONFIG.VALID_TIME_LIMIT) {
      freshTokenFromDb();
    } else if (currentTimestamp - globalInfo.jsapiTicket.validTime > CONFIG.VALID_TIME_LIMIT) {
      getJsapiTicket();
    }
  };

  function freshTokenFromDb() {
    dbPool.query("select * from tbl_wechat_tokens where appid=?", [CONFIG.WECHAT.APPID], function(err, rows, fields) {
      if (err) throw err;
      CONFIG.WECHAT.SECRET = rows[0].secret
      if (currentTimestamp - rows[0].validTime > CONFIG.VALID_TIME_LIMIT) {
        getTokenFromTencent(rows[0])
      } else {
        globalInfo.token.value = rows[0].token
        globalInfo.token.validTime = rows[0].validTime
        getJsapiTicket()
      }
    });
  };

  function getTokenFromTencent(_tokenInfo) {
    var url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + CONFIG.WECHAT.APPID + '&secret=' + _tokenInfo.secret;
    var https = require('https');
    https.get(url, function(response) {
      var body = '';
      response.on('data', function(d) {
        body += d;
      });
      response.on('end', function() {
        var rev = JSON.parse(body);
        // console.log(rev)
        if (rev.access_token) {
          globalInfo.token.value = rev.access_token;
          globalInfo.token.validTime = currentTimestamp + 1000 * rev.expires_in;
          updateDbToken()
          getJsapiTicket()
        } else {
          logger.error("wrong token info ");
          logger.error(rev);
        }
      });
    });
  };

  function getJsapiTicket() {
    var url = 'https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=' + globalInfo.token.value + "&type=jsapi";
    var https = require('https');
    https.get(url, function(response) {
      var body = '';
      response.on('data', function(d) {
        body += d;
      });
      response.on('end', function() {
        var rev = JSON.parse(body);
        // console.log(rev)
        if (rev.ticket) {
          globalInfo.jsapiTicket.value = rev.ticket;
          globalInfo.jsapiTicket.validTime = currentTimestamp + 1000 * rev.expires_in;
          updateDbJsapiTicket()
        } else {
          logger.error("wrong jsapiTicket info ");
          logger.error(rev);
          if (rev.errcode == 42001 && rev.errcode.indexOf('access_token expired hint') == 0) {
            freshTokenFromDb()
          }
        }
      });
    });
  };

  function updateDbToken() {
    dbPool.query("update tbl_wechat_tokens set token =? , validTime=? where appid=?", [globalInfo.token.value, globalInfo.token.validTime, CONFIG.WECHAT.APPID], function(err, rows, fields) {
      if (err) throw err;
      // console.log(rows);
    });
  };

  function updateDbJsapiTicket() {
    dbPool.query("update tbl_wechat_tokens set jsapiTicket =? , jsapiTicketValidTime=? where appid=?", [globalInfo.jsapiTicket.value, globalInfo.jsapiTicket.validTime, CONFIG.WECHAT.APPID], function(err, rows, fields) {
      if (err) throw err;
      // console.log(rows);
    });
  };
}

module.exports = tokenWechat;