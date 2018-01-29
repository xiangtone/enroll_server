'use strict';
var express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo')(session);
var mysql = require('mysql');
var mongodb = require('mongodb');
var ObjectId = require('mongodb').ObjectID
var https = require('https');
var axios = require('axios');
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
        target += '?f=' + req.session.fetchWechatUserInfo.unionid
      } else {
        target += '&f=' + req.session.fetchWechatUserInfo.unionid
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
      activityConfirmSwitch: req.body.activityConfirmSwitch,
      founderUnionId: req.session.fetchWechatUserInfo.unionid,
      lastModifyTime: new Date(),
      applys: [initialApply({
        status: 'pass',
        displayNickName: req.body.founderNickName,
      }, req)]
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

function enrollActivity(req, res) {
  mo.findOneDocumentById('activitys', req.body.activityId, function(result) {
    var rsp = { status: 'ok' }
    if (checkEnroll(req.session.fetchWechatUserInfo.unionid, result.applys)) {
      rsp = {
        status: 'error',
        msg: 'enrolled',
      }
      res.send(rsp);
    } else {
      result.applys.push(initialApply({
        status: result.activityConfirmSwitch ? 'wait' : 'pass',
        displayNickName: req.body.displayNickName,
      }, req))
      logger.debug('enrollActivity', result)
      mo.updateOne('activitys', { _id: new ObjectId(req.body.activityId) }, {
        $set: { applys: result.applys }
      }, function(result) {
        res.send(rsp);
      })
    }
  });
}

function enrollQrcode(req, res) {
  mo.findOneDocumentByFilter('qrcodes', {
    'act': 'enroll',
    'activityId': req.body.activityId,
    'from': req.body.from,
  }, { sort: { '_id': -1 } }, function(result) {
    if (result) {
      var rsp = {
        status: 'ok',
        ticket: result.ticket,
        url: result.url
      }
      res.send(rsp);
    } else {
      const insertData = {
        collection: 'qrcodes',
        documents: [{
          'act': 'enroll',
          'activityId': req.body.activityId,
          'from': req.body.from,
          expiredTime: new Date(Date.now() + 86400 * 1000 * 29)
        }]
      }
      mo.insertDocuments(insertData, function(inserted) {
        if (inserted.result.ok == 1) {
          axios.post('https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=' + globalInfo.token.value, {
              "expire_seconds": 2592000,
              "action_name": "QR_SCENE",
              "action_info": {
                "scene": { "scene_id": inserted.ops[0]._id }
              }
            })
            .then(function(response) {
              if (response.data.ticket) {
                mo.updateOne('qrcodes', { _id: new ObjectId(inserted.ops[0]._id) }, {
                  $set: {
                    ticket: response.data.ticket,
                    url: response.data.url
                  }
                }, function(result) {
                  if (result.result.ok == 1) {
                    var rsp = {
                      status: 'ok',
                      ticket: response.data.ticket,
                      url: response.data.url
                    }
                    res.send(rsp);
                  } else {
                    errorRsp('enrollQrcode update mongodb error')
                  }
                })
              } else {
                errorRsp('enrollQrcode get qrcode from wechat by wechat rsp , check config')
              }
            })
            .catch(function(error) {
              logger.error('enrollQrcode get qrcode from wechat\n', error)
              errorRsp('enrollQrcode get qrcode from wechat by network')
            });
        } else {
          errorRsp('enrollQrcode insertDocuments error')
        }
      });
    }
  });

  function errorRsp(msg) {
    logger.error('enrollQrcode on process', msg)
    var rsp = {
      status: 'error',
      msg: msg
    }
    res.send(rsp)
  }
}

function initialApply(options, req) {
  return {
    unionId: req.session.fetchWechatUserInfo.unionid,
    status: options.status,
    applyTime: new Date(),
    confirmTime: new Date(),
    displayNickName: options.displayNickName,
    wechatNickName: req.session.fetchWechatUserInfo.nickname,
    headimgurl: req.session.fetchWechatUserInfo.headimgurl,
  }
}

function checkEnroll(unionId, applys) {
  for (var i in applys) {
    if (unionId == applys[i].unionId) {
      return true
    }
  }
  return false
}

app.get(CONFIG.DIR_FIRST + '/ajaxPub/signWechat', signOutWithAjax);
app.get(CONFIG.DIR_FIRST + '/ajax/page/getSession', getSession);
app.get(CONFIG.DIR_FIRST + '/ajax/getActivity', getActivity);
app.post(CONFIG.DIR_FIRST + '/ajax/enrollActivity', jsonParser, enrollActivity);
app.post(CONFIG.DIR_FIRST + '/ajax/enrollQrcode', jsonParser, enrollQrcode);
app.post(CONFIG.DIR_FIRST + '/ajax/createActivity', jsonParser, createActivity);

// console.log(sign(poolConfig, 'http://example.com'));

var server = app.listen(CONFIG.LISTEN_PORT, function() {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Example app listening at http://%s:%s', host, port);
});