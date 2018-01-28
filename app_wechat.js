'use strict';
var express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo')(session);
var mysql = require('mysql');
var mongodb = require('mongodb');
var path = require('path');
var bodyParser = require('body-parser');
var jsonParser = bodyParser.json();
var sign = require('./lib/sign.js');
var CONFIG = require('./config.js');
var globalInfo = require('./globalInfo.js');

var pu = require('./lib/privateUtil.js');
var mo = require('./lib/mongoOperate.js');
var log4js = require('log4js');
var logger = log4js.getLogger();

logger.setLevel(CONFIG.LOG_LEVEL);
var tokenWechat = require('./lib/tokenWechat.js');
var wechatToken = tokenWechat();
var app = express();

app.use(session({
  secret: 'iqjmvh-178fd-fwh8f-cfenp',
  resave: true,
  saveUninitialized: true,
  store: new MongoStore({
    username: CONFIG.MONGODB.USER,
    password: CONFIG.MONGODB.PASSWORD,
    url: CONFIG.MONGODB.URL_SESSION,
  })
}));


const { Mongo } = require('mongodb-pool')
Mongo.getConnection(CONFIG.MONGODB.URL_ACTIVITY, {
  poolSize: 3,
  auto_reconnect: true,
}).then()

app.use(function(req, res, next) {
  var isNext = true;
  var ctimeSecond = new Date().getTime() / 1000
  if (req.url.indexOf('\/page\/') != -1 && req.url.indexOf('.js') == -1 && req.url.indexOf('.css') == -1) {
    if (checkWechatHeader()) {
      if (req.query.code) {
        isNext = false
        oAuthBaseProcess(req.query.code)
      } else {
        if (req.url.indexOf('apply') != -1 && !req.session.wechatUserInfo) {
          toWechatOauth('snsapi_userinfo')
        } else if (!req.session.wechatBase) {
          // only support get method
          // var scope = 'snsapi_userinfo';
          toWechatOauth('snsapi_base')
          // var scope = 'snsapi_base';
          // var urlEncodedUrl = encodeURIComponent(req.protocol + '://' + req.hostname + req.url)
          // var oAuthUrl = 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=' + CONFIG.WECHAT.APPID + '&redirect_uri=' + urlEncodedUrl + '&response_type=code&scope=' + scope + '&state=123#wechat_redirect'
          // isNext = false
          // return res.send('<script>location="' + oAuthUrl + '"</script>')
        } else {
          if (!req.query.f) {
            isNext = false
            return redirectAfterOAuthSuccess()
          }
        }
      }
    } else {
      isNext = false
      return res.send('{"status":"error","msg":"wechat only"}')
    }
  } else if (req.url.indexOf('\/ajax\/') != -1) {
    if (!req.session.wechatBase) {
      isNext = false
      res.send('{"status":"error","msg":"no certificate"}')
      return res.end()
    }
  }
  if (isNext) {
    next();
  }

  function toWechatOauth(scope) {
    // var urlEncodedUrl = encodeURIComponent(req.protocol + '://' + req.hostname + req.url)
    var urlEncodedUrl = encodeURIComponent('https://' + req.hostname + req.url)
    var oAuthUrl = 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=' + CONFIG.WECHAT.APPID + '&redirect_uri=' + urlEncodedUrl + '&response_type=code&scope=' + scope + '&state=123#wechat_redirect'
    isNext = false
    return res.send('<script>location="' + oAuthUrl + '"</script>')
  }

  function checkWechatHeader() {
    if (req.header('User-Agent').toLowerCase().indexOf('micromessenger') != -1) {
      return true
    } else {
      return false
    }
  };

  function oAuthBaseProcess(code) {
    var https = require('https');
    var url = 'https://api.weixin.qq.com/sns/oauth2/access_token?appid=' + CONFIG.WECHAT.APPID + '&secret=' + CONFIG.WECHAT.SECRET + '&code=' + code + '&grant_type=authorization_code'
    https.get(url, function(response) {
      var body = '';
      response.on('data', function(d) {
        body += d;
      });
      response.on('end', function() {
        var rev = JSON.parse(body);
        logger.debug('baseinfo', rev)
        if (rev.openid) {
          req.session.wechatBase = rev
          getUserInfoWithOpenId(rev.openid)
          // insertOrUpdateWechatUser(rev, CONFIG.WECHAT.APPID);
          // logger.debug(rev);
          // can trace f parameter (from openid) here , and replace it here if you need .
        } else {
          logger.error(req.originalUrl)
          var errContent = 'oAuthBaseProcess can not get openid from wechat'
          logger.error(errContent)
          return res.send('{"status":"error","msg":"' + errContent + '"}')
        }
      });
    });
  };

  function insertOrUpdateWechatUser(wechatBase, appId) {
    poolConfig.query("SELECT ifnull(lastFetchInfoFromWechat,0) as lastFetchInfoFromWechat,ifnull(subscribeTime,0) as subscribeTime FROM tbl_wechat_users where openId=?", [wechatBase.openid], function(err, rowRs, fields) {
      if (err) {
        logger.error(err);
      } else {
        if (rowRs.length > 0) {
          req.session.userInfoFromDb = rowRs[0];
          //if no response any more . need save .
          req.session.save(null)
          req.session.wechatBase.subscribe_time = rowRs[0].subscribeTime
          poolConfig.query("update tbl_wechat_users set lastLoginTime=?,unionId=? where openId=?  ", [ctimeSecond, wechatBase.unionid, wechatBase.openid], function(err, rows, fields) {
            if (err) {
              logger.error(err);
            } else {
              if (!rows.constructor.name == 'OkPacket') {
                logger.error('update tbl_wechat_users set lastLoginTime:')
                logger.error(rows)
              }
            }
          })
          if (rowRs[0].lastFetchInfoFromWechat == 0 || ctimeSecond - rowRs[0].lastFetchInfoFromWechat > 86400) {
            getUserInfoWithOpenId(wechatBase.openid)
          }
        } else {
          poolConfig.query("insert into tbl_wechat_users (openId,createTime,lastLoginTime,unionId,appId) values (?,?,?,?,?)  ", [wechatBase.openid, ctimeSecond, ctimeSecond, wechatBase.unionid, appId], function(err, rows, fields) {
            if (err) {
              logger.error(err);
            } else {
              if (!rows.constructor.name == 'OkPacket') {
                logger.error('insert into tbl_wechat_users:')
                logger.error(rows)
              } else {
                getUserInfoWithOpenId(wechatBase.openid)
              }
            }
          })
        }
      }
    });
  }

  function getUserInfoWithOpenId(openId) {
    var https = require('https');
    var url = 'https://api.weixin.qq.com/cgi-bin/user/info?access_token=' + globalInfo.token.value + '&openid=' + openId + '&lang=zh_CN'
    https.get(url, function(response) {
      var body = '';
      response.on('data', function(d) {
        body += d;
      });
      response.on('end', function() {
        var rev = JSON.parse(body);
        logger.debug('fetch baseinfo', rev);
        req.session.fetchWechatUserInfo = rev
        req.session.save(null)
        if (req.session.wechatBase.scope == 'snsapi_userinfo') {
          oAuthUserInfo();
        } else {
          redirectAfterOAuthSuccess();
        }
      });
    });
  }

  function oAuthUserInfo(code) {
    var https = require('https');
    var url = 'https://api.weixin.qq.com/sns/userinfo?access_token=' + req.session.wechatBase.access_token + '&openid=' + req.session.wechatBase.openid + '&lang=zh_CN'
    https.get(url, function(response) {
      var body = '';
      response.on('data', function(d) {
        body += d;
      });
      response.on('end', function() {
        var rev = JSON.parse(body);
        logger.debug('userinfo', rev);
        if (rev.openid) {
          req.session.wechatUserInfo = rev
          /*
          poolConfig.query("update tbl_wechat_users set nickName=?,headImgUrl=? where openId=?  ", [rev.nickname, rev.headimgurl, rev.openid], function(err, rows, fields) {
            if (err) {
              logger.error(err);
            } else {
              if (!rows.constructor.name == 'OkPacket') {
                logger.error('update tbl_wechat_users set getUserInfoWithOpenId:')
                logger.error(rows)
              }
            }
          })
          */
          redirectAfterOAuthSuccess();
        } else {
          logger.error(url)
          var errContent = 'oAuthBaseProcess can not get openid from wechat'
          logger.error(errContent)
          return res.send('{"status":"error","msg":"' + errContent + '"}')
        }
      });
    });
  };

  function redirectAfterOAuthSuccess() {
    var target = pu.cleanedUrl(req)
    var timestamp = +new Date();
    if (target.indexOf('f=') == -1) {
      if (target.indexOf('?') == -1) {
        target += '?f=' + req.session.wechatBase.openid
      } else {
        target += '&f=' + req.session.wechatBase.openid
      }
    }
    return res.send('<script>location="' + target + '"</script>')
    // return res.redirect(target);
  }
})

app.use(express.static(path.join(__dirname, 'static')));

function signOutWithAjax(req, res) {
  res.set({
    "Cache-Control": "no-cache, no-store, max-age=0, must-revalidate",
    "Expires": "-1",
  })
  var ret = sign(globalInfo.jsapiTicket.value, req.header('Referer'))
  ret.wechatUserInfo = req.session.fetchWechatUserInfo
  var result = JSON.stringify(ret);
  res.send(result);
}

function getSession(req, res) {
  res.send("ok");
}

function createActivity(req, res) {
  const insertData = {
    collection: 'activitys',
    documents: [{
      founderNickName: req.body.founderNickName,
      activityTitle: req.body.activityTitle,
      activityAddress: req.body.activityAddress,
      activityDateTime: new Date(req.body.activityDateTime),
      numberMax: req.body.numberMax,
      numberMin: req.body.numberMin,
      confirmDayCount: req.body.confirmDayCount,
      enrollPrice: req.body.enrollPrice,
      founderUnionId: req.session.fetchWechatUserInfo.unionid,
      lastModifyTime: new Date(),
      applys: [{
        unionId: req.session.fetchWechatUserInfo.unionid,
        status: 'pass',
        applyTime: new Date(),
        confirmTime: new Date(),
        displayNickName: req.body.founderNickName,
        wechatNickName: req.session.fetchWechatUserInfo.nickname,
        headimgurl: req.session.fetchWechatUserInfo.headimgurl,
      }]
    }]
  }
  mo.insertDocuments(insertData, function(result) {
    var rsp = {
      status: 'ok',
      activityId: result.ops[0]._id,
    }
    res.send(rsp);
  });
}

function getActivity(req, res) {
  const options = {
    collection: 'activitys',
    confition: {
      '_id': new mongodb.ObjectID(req.query.activity_id),
    }
  }
  mo.findOneDocumentById('activitys', req.query.activity_id, function(result) {
    var rsp = {
      status: 'ok',
      data: result,
    }
    res.send(rsp);
  });
}

app.get(CONFIG.DIR_FIRST + '/ajaxPub/signWechat', signOutWithAjax);
app.get(CONFIG.DIR_FIRST + '/ajax/page/getSession', getSession);
app.get(CONFIG.DIR_FIRST + '/ajax/getActivity', getActivity);
app.post(CONFIG.DIR_FIRST + '/ajax/createActivity', jsonParser, createActivity);

// console.log(sign(poolConfig, 'http://example.com'));

var server = app.listen(CONFIG.LISTEN_PORT, function() {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Example app listening at http://%s:%s', host, port);
});