'use strict';
var express = require('express');
const { Mongo } = require('mongodb-pool')
const session = require('express-session');
const MongoStore = require('connect-mongo')(session);
var mysql = require('mysql');
var mongodb = require('mongodb');
var ObjectId = require('mongodb').ObjectID
var https = require('https');
var axios = require('axios');
var _ = require('lodash');
var CronJob = require('cron').CronJob;
var path = require('path');
var xmlparser = require('express-xml-bodyparser');
var bodyParser = require('body-parser');
var jsonParser = bodyParser.json();
var sign = require('./lib/sign.js');
var CONFIG = require('./config.js');
var globalInfo = require('./globalInfo.js');

var pu = require('./lib/privateUtil.js');
var mo = require('./lib/mongoOperate.js');
var mso = require('./lib/mongoSessionOperate.js');
var ts = require('./lib/templateSender.js');
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

const tenpay = require('tenpay');
const configTenPay = {
  appid: CONFIG.WECHAT.APPID,
  mchid: CONFIG.WXPAY.MCH_ID,
  partnerKey: CONFIG.WXPAY.PARTNER_KEY,
  pfx: require('fs').readFileSync('./key_weixin_pay_' + CONFIG.WXPAY.MCH_ID + '.p12'),
  notify_url: 'https://' + CONFIG.DOMAIN + '/' + CONFIG.PAY_DIR_FIRST,
  spbill_create_ip: '127.0.0.1'
};

// init调用: 用于多帐号省略new关键字, tenpay.init(config)返回一个新的实例对象

async() => {
  try {
    await tenpay.init(configTenPay).some_api();
  } catch (e) {
    logger.error(e.name + ": " + e.message);
    logger.error(e.stack);
  }
}

function freshGlobalConfig() {
  // mo.findDocuments({ collection: 'configs' }, function(docs) {
  //   logger.debug('freshGlobalConfig', docs)
  //   setTimeout(freshGlobalConfig(), 5000)
  // })
  mo.findOneDocumentByFilter('configs', {}, {}, function(docs) {
    globalInfo.config = docs
  })
}

function scanPayToFounder() {
  var currentTime = new Date()
  var findTarget = {
    collection: 'activitys',
    condition: {
      'applys.status': 'pass',
      'applys.payToFounderStatus': 'wait',
      'applys.payToFounderSchedule': { $lt: currentTime }
    }
  }
  mo.findDocuments(findTarget, function(docs) {
    docs.forEach(function(activity) {
      var amount = 0
      var count = 0
      var updateData = []
      for (var j = 1; j < activity.applys.length; j++) {
        var apply = activity.applys[j]
        if (apply.status == 'pass' && apply.payToFounderStatus == 'wait' && apply.payToFounderSchedule < currentTime) {
          var fee = 100 * apply.enrollPrice * apply.enrollNumber * (1 - globalInfo.config.payRatio)
          amount += fee
          count++
          updateData.push({ index: j, fee: fee })
        }
      }
      if (amount > 0) {
        if (amount < 100) {
          logger.error('scanPayToFounder amount less 100 limit ', activity._id)
          return;
        }
        var updateApplys = {}
        for (var k of updateData) {
          updateApplys['applys.' + k.index + '.payToFounderStatus'] = 'payed'
          updateApplys['applys.' + k.index + '.payToFounderDateTime'] = currentTime
          updateApplys['applys.' + k.index + '.payToFounderAmount'] = k.fee
        }
        logger.debug('updateApplys', updateApplys)
        mo.updateOne('activitys', {
          _id: activity._id,
        }, { $set: updateApplys }, function(updatedApplys) {
          var transferInfo = {
            openid: activity.founderOpenId,
            amount: amount,
            desc: activity.activityTitle + '的' + count + '人活动费用',
            check_name: 'NO_CHECK',
          }
          transferAndLog(transferInfo)
        })
      }
    })
  })
}

Mongo.getConnection(CONFIG.MONGODB.URL_ACTIVITY, {
  poolSize: 3,
  auto_reconnect: true,
}).then(
  function() {
    new CronJob('*/5 * * * * *', freshGlobalConfig, null, true, 'Asia/Shanghai');
    //以cluster模式运行的时候，需要挪出
    new CronJob('*/8 * * * * *', scanPayToFounder, null, true, 'Asia/Shanghai');
  }
).catch(error => { logger.error('caught', error); })

const weixin_pay_api = new tenpay(configTenPay);

app.use(function(req, res, next) {
  var isNext = true;
  var ctimeSecond = new Date().getTime() / 1000
  if (req.url.indexOf('\/ajwechatLogin') != -1 && req.url.indexOf('.js') == -1 && req.url.indexOf('.css') == -1) {
    if (checkWechatHeader()) {
      if (req.query.code && req.query.state) {
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
    logger.debug('urlEncodedUrl', urlEncodedUrl)
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
    mo.findOneDocumentById('logHrefs', req.query.state, function(docHref) {
      if (docHref) {
        res.send('<script>location="' + docHref.href + '"</script>')
      } else {
        res.send('error on get href from logs')
      }
    })
    // return res.redirect(target);
  }
})


function hrefRecord(req, res) {
  mo.insertDocuments({
    collection: 'logHrefs',
    documents: [{
      href: req.body.href,
      expiredTime: new Date(Date.now() + 60 * 1000 * 3),
    }]
  }, function(insertedHref) {
    if (insertedHref.result.ok == 1) {
      res.send({
        status: 'ok',
        state: insertedHref.ops[0]._id,
        loginUrl: encodeURIComponent('https://' + req.hostname + '/' + CONFIG.DIR_FIRST + '/ajwechatLogin')
      })
    }
  })
}

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
      enrollAgentSwitch: req.body.enrollAgentSwitch,
      alternateSwitch: req.body.alternateSwitch,
      founderUnionId: req.session.fetchWechatUserInfo.unionid,
      founderOpenId: req.session.fetchWechatUserInfo.openid,
      lastModifyTime: new Date(),
      applys: [
        initialApply({
          unionId: req.session.fetchWechatUserInfo.unionid,
          openId: req.session.fetchWechatUserInfo.openid,
          status: 'pass',
          wechatNickName: req.session.fetchWechatUserInfo.nickname,
          displayNickName: req.body.founderNickName,
          headimgurl: req.session.fetchWechatUserInfo.headimgurl,
          confirmTime: new Date(),
          enrollNumber: 1,
          enrollPrice: 0,
        })
      ]
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

function confirmApply(req, res) {

  var targetI = -1
  var currentTime = new Date()

  mo.findOneDocumentById('activitys', req.body.activity_id, function(activity) {
    function confirm(transferInfo) {
      ts.sendVerify({ activity: activity, targetIndex: targetI })
      var updateData = {}
      updateData["applys." + targetI + ".status"] = 'pass'
      updateData["applys." + targetI + ".confirmTime"] = currentTime
      if (transferInfo) {
        updateData["applys." + targetI + ".payToFounderStatus"] = 'payed'
        updateData["applys." + targetI + ".payToFounderDateTime"] = currentTime
      }
      mo.updateOne('activitys', {
        _id: new ObjectId(req.body.activity_id),
      }, { $set: updateData }, function() {
        res.send({
          status: 'ok',
        })
        if (transferInfo) {
          transferAndLog(transferInfo)
        }
      })
    }
    if (checkFounderSession(activity, req)) {
      for (var i = 1; i < activity.applys.length; i++) {
        if (req.body.applyId == activity.applys[i]._id.toString()) {
          targetI = i
          if (activity.applys[i].payToFounderStatus == 'wait' && activity.applys[i].payToFounderSchedule < currentTime && !activity.applys[i].payToFounderDateTime) {
            var transferInfo = {
              openid: activity.founderOpenId,
              amount: activity.applys[i].payToFounderAmount,
              desc: activity.applys[i].displayNickName + '支付的' + activity.activityTitle + '活动费用',
              check_name: 'NO_CHECK',
            }
            confirm(transferInfo)
          } else {
            confirm()
          }
          break;
        }
      }
      if (targetI == -1) {
        res.send({
          status: 'error',
          data: 'not found match activity'
        });
      }
    } else {
      res.send({
        status: 'error',
        data: 'not founder'
      })
    }
  });
}


function refundApply(apply, callback) {
  mo.findOneDocumentByFilter('logPays', { payKey: apply._id, status: 'payed' }, null, async function(logPay) {
    if (logPay) {
      var out_refund_no = new ObjectId()
      let refundResult = await weixin_pay_api.refund({
        // transaction_id, out_trade_no 二选一
        // transaction_id: '微信的订单号',
        out_trade_no: logPay.payInfo.out_trade_no,
        out_refund_no: out_refund_no.toString(),
        total_fee: logPay.payInfo.total_fee,
        refund_fee: logPay.payInfo.total_fee,
      });
      mo.insertDocuments({
        collection: 'logRefunds',
        documents: [{
          _id: out_refund_no,
          refundResult: refundResult,
          reason: 'founder cancel'
        }]
      }, function(insertDocuments) {})
      mo.updateOne('logPays', {
        _id: logPay._id
      }, { $set: { status: 'refund' } }, function(updateDocs) {
        callback()
      })
    }
  })
}

function delApplyFromActivity(options, callback) {
  logger.debug('delApplyFromActivity', options)
  var targetApply = options.targetApply
  mo.updateOne('activitys', {
    _id: new ObjectId(options.activityId),
  }, { $pull: { applys: options.targetApply } }, function() {
    logger.debug('delApplyFromActivity callback', options)
    targetApply.reason = options.reason
    options.targetApply.reason = options.reason
    mo.updateOne('activitys', {
      _id: new ObjectId(options.activityId),
    }, { $push: { delApplys: targetApply } }, function() {
      callback()
    })
  })
}

function cancelEnrollByCustomer(req, res) {
  var currentTime = new Date()
  var rsp = { status: 'ok' }

  mo.findOneDocumentById('activitys', req.body.activityId, function(activity) {
    if (activity) {
      function processApply(apply) {
        if (req.session.fetchWechatUserInfo.unionid == apply.unionId) {
          if (apply.enrollPrice == 0) {
            delApplyFromActivity({
              activityId: activity._id.toString(),
              targetApply: apply,
              reason: 'customer cancel fee free',
            }, function() {})
          } else if (apply.payToFounderStatus == 'wait' && !apply.payToFounderDateTime) {
            refundApply(apply, function() {
              delApplyFromActivity({
                activityId: activity._id.toString(),
                targetApply: apply,
                reason: 'customer cancel , not transfer to founder yet',
              }, function() {})
            })
          } else if (apply.payToFounderStatus == 'payed' && apply.payToFounderDateTime && apply.payToFounderAmount >= 100) {
            rsp = { status: 'error', msg: '费用已经支付给活动组织者，需要组织者在管理中退费' }
          } else {
            delApplyFromActivity({
              activityId: activity._id.toString(),
              targetApply: apply,
              reason: 'customer cancel',
            }, function() {})
          }
        }
      }
      if (checkFounderSession(activity, req)) {
        res.send({ status: 'error', msg: 'founder can not cancel' })
      } else {
        for (var i = 1; i < activity.applys.length; i++) {
          processApply(activity.applys[i])
        }
        res.send(rsp)
      }
    } else {
      res.send({ status: 'error', msg: 'activity is not exist' })
    }
  })
}



function delApply(req, res) {

  function sendOk() {
    res.send({
      status: 'ok',
    })
  }

  var targetI = -1
  var currentTime = new Date()
  mo.findOneDocumentById('activitys', req.body.activity_id, function(activity) {
    if (checkFounderSession(activity, req)) {
      for (var i = 1; i < activity.applys.length; i++) {
        if (req.body.applyId == activity.applys[i]._id.toString()) {
          async function insertUnifiedOrderCallback(insertedUnifiedOrder) {
            if (insertedUnifiedOrder.result.ok == 1) {
              try {
                let unifiedOrder = await weixin_pay_api.unifiedOrder({
                  out_trade_no: insertedUnifiedOrder.ops[0]._id.toString(),
                  body: '退回' + activity.applys[i].displayNickName + '参加' + activity.title + '的费用',
                  total_fee: activity.applys[i].payToFounderAmount,
                  openid: req.session.fetchWechatUserInfo.openid,
                  // notify_url: 'https://' + CONFIG.DOMAIN + '/' + CONFIG.PAY_DIR_FIRST + insertedUnifiedOrder.ops[0]._id.toString(),
                });
                let resultForJsapi = await weixin_pay_api.getPayParamsByPrepay({
                  prepay_id: unifiedOrder.prepay_id
                });
                var rsp = { status: 'ok', type: 'unifiedOrder', data: resultForJsapi }
                res.send(rsp);
              } catch (e) {
                logger.error(e.name + ": " + e.message);
                logger.error(e.stack);
              }
            }
          }
          targetI = i
          ts.sendReject({ activity: activity, targetIndex: targetI })
          if (activity.applys[i].enrollPrice == 0) {
            delApplyFromActivity({
              activityId: activity._id.toString(),
              targetApply: activity.applys[i],
              reason: 'founder delete',
            }, sendOk)
          } else if (activity.applys[i].payToFounderStatus == 'wait' && !activity.applys[i].payToFounderDateTime) {
            logger.debug('enter refund process')
            refundApply(activity.applys[i], function() {
              delApplyFromActivity({
                activityId: activity._id.toString(),
                targetApply: activity.applys[i],
                reason: 'founder delete payToFounderStatus is wait',
              }, sendOk)
            })
          } else if (activity.applys[i].payToFounderStatus == 'payed' && activity.applys[i].payToFounderDateTime && activity.applys[i].payToFounderAmount >= 100) {
            //拉起支付
            var insertUnifiedOrderData = {
              collection: 'unifiedOrders',
              documents: [{
                activityId: req.body.activity_id,
                wechatUserInfo: req.session.fetchWechatUserInfo,
                expiredTime: new Date(Date.now() + 86400 * 1000 * 3),
                payProcess: 'wait',
                type: 'delApplyRefund',
                applyId: activity.applys[i]._id
              }]
            }
            mo.insertDocuments(insertUnifiedOrderData, insertUnifiedOrderCallback)
          } else {
            delApplyFromActivity({
              activityId: activity._id.toString(),
              targetApply: activity.applys[i],
              reason: 'founder delete',
            }, sendOk)
          }
          break;
        }
      }
      if (targetI == -1) {
        res.send({
          status: 'error',
          data: 'not found match activity'
        });
      }
    } else {
      res.send({
        status: 'error',
        data: 'not founder'
      })
    }
  });
}

function checkFounderSession(activity, req) {
  if (activity.applyTime) {
    activity.applyTime = new Date(activity.applyTime)
  }
  if (activity.founderUnionId == req.session.fetchWechatUserInfo.unionid) {
    return true
  } else {
    return false
  }
}

function getActivity(req, res) {
  mo.findOneDocumentById('activitys', req.query.activity_id, function(activity) {
    var rsp = {
      status: 'ok',
      data: activity,
    }
    res.send(rsp);
  });
}

function getActivityFoundList(req, res) {
  mo.findDocuments({
    collection: 'activitys',
    condition: {
      founderUnionId: req.session.fetchWechatUserInfo.unionid
    },
    sort: {
      activityDateTime: -1
    }
  }, function(activitys) {
    var rsp = {
      status: 'ok',
      data: activitys,
    }
    res.send(rsp);
  });
}

function getActivityApplyList(req, res) {
  mo.findDocuments({
    collection: 'activitys',
    condition: {
      "applys.unionId": req.session.fetchWechatUserInfo.unionid
    },
    sort: {
      activityDateTime: -1
    }
  }, function(activitys) {
    var result = []
    for (var i of activitys) {
      if (i.applys[0].unionId != req.session.fetchWechatUserInfo.unionid) {
        result.push(i)
      }
    }
    var rsp = {
      status: 'ok',
      data: result,
    }
    res.send(rsp);
  });
}

function wechatLogin(req, res) {
  var rsp = {
    status: 'ok',
  }
  res.send(rsp);
}

function enrollActivity(activity, apply, callback) {
  // activity.applys.push(apply)
  mo.updateOne('activitys', { _id: activity._id }, {
    $addToSet: { applys: apply }
  }, function(result) {
    callback()
  })
}

function enrollActivityAjax(req, res) {
  mo.findOneDocumentById('activitys', req.body.activityId, function(activity) {

    function enrollAndSend() {
      enrollActivity(activity, initialApply({
        status: activity.activityConfirmSwitch ? 'wait' : 'pass',
        displayNickName: req.body.displayNickName,
        enrollNumber: req.body.enrollNumber,
        unionId: req.session.fetchWechatUserInfo.unionid,
        openId: req.session.fetchWechatUserInfo.openid,
        wechatNickName: req.session.fetchWechatUserInfo.nickname,
        headimgurl: req.session.fetchWechatUserInfo.headimgurl,
        confirmTime: activity.activityConfirmSwitch ? null : new Date(),
        enrollPrice: 0,
      }), function() {
        res.send(rsp);
      })
    }

    async function insertUnifiedOrderCallback(insertedUnifiedOrder) {
      if (insertedUnifiedOrder.result.ok == 1) {
        try {
          let unifiedOrder = await weixin_pay_api.unifiedOrder({
            out_trade_no: insertedUnifiedOrder.ops[0]._id.toString(),
            body: '参加' + activity.founderNickName + '组织的' + activity.title + '的费用',
            total_fee: 100 * activity.enrollPrice * req.body.enrollNumber,
            openid: req.session.fetchWechatUserInfo.openid,
            // notify_url: 'https://' + CONFIG.DOMAIN + '/' + CONFIG.PAY_DIR_FIRST + insertedUnifiedOrder.ops[0]._id.toString(),
          });
          let resultForJsapi = await weixin_pay_api.getPayParamsByPrepay({
            prepay_id: unifiedOrder.prepay_id
          });
          rsp.type = 'unifiedOrder'
          rsp.data = resultForJsapi
          res.send(rsp);
        } catch (e) {
          logger.error(e.name + ": " + e.message);
          logger.error(e.stack);
        }
      }
    }

    var rsp = { status: 'ok' }
    if ((checkEnrolled(req.session.fetchWechatUserInfo.unionid, activity.applys)).length > 0) {
      rsp = {
        status: 'error',
        msg: 'enrolled',
      }
      res.send(rsp);
    } else {
      if (activity.enrollPrice == 0) {
        enrollAndSend()
      } else {
        var insertUnifiedOrderData = {
          collection: 'unifiedOrders',
          documents: [{
            activityId: req.body.activityId,
            wechatUserInfo: req.session.fetchWechatUserInfo,
            enrollNumber: req.body.enrollNumber,
            enrollPrice: activity.enrollPrice,
            expiredTime: new Date(Date.now() + 86400 * 1000 * 3),
            payProcess: 'wait',
            displayNickName: req.body.displayNickName,
            type: 'enroll',
          }]
        }
        mo.insertDocuments(insertUnifiedOrderData, insertUnifiedOrderCallback)
      }
    }
  });
}

function enrollQrcode(req, res) {
  function errorRsp(msg) {
    logger.error('enrollQrcode on process', msg)
    var rsp = {
      status: 'error',
      msg: msg
    }
    res.send(rsp)
  }
  var rsp = {}

  function successRsp() {
    // req.session.destroy(function(err) {
    //   logger.debug('enrollQrcode successRsp destroy session', err)
    //   res.send(rsp);
    // })
    res.send(rsp);
  }
  mo.findOneDocumentByFilter('qrcodes', {
    'act': 'enroll',
    'activityId': req.body.activityId,
    'from': req.body.from,
  }, { sort: { '_id': -1 } }, function(result) {
    if (result) {
      rsp = {
        status: 'ok',
        ticket: result.ticket,
        url: result.url
      }
      successRsp()
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
          var postData = {
            "expire_seconds": 2592000,
            "action_name": "QR_STR_SCENE",
            "action_info": {
              "scene": { "scene_str": inserted.ops[0]._id }
            }
          }
          logger.debug('qrcode postData\n', postData)
          axios.post('https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=' + globalInfo.token.value, postData)
            .then(function(response) {
              if (response.data.ticket) {
                mo.updateOne('qrcodes', { _id: new ObjectId(inserted.ops[0]._id) }, {
                  $set: {
                    ticket: response.data.ticket,
                    url: response.data.url
                  }
                }, function(result) {
                  if (result.result.ok == 1) {
                    rsp = {
                      status: 'ok',
                      ticket: response.data.ticket,
                      url: response.data.url
                    }
                    successRsp()
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


}

function initialApply(options) {
  return {
    _id: new ObjectId(),
    unionId: options.unionId,
    openId: options.openId,
    status: options.status,
    applyTime: new Date(),
    confirmTime: options.confirmTime,
    displayNickName: options.displayNickName,
    wechatNickName: options.wechatNickName,
    headimgurl: options.headimgurl,
    enrollNumber: options.enrollNumber ? options.enrollNumber : 1,
    enrollPrice: options.enrollPrice ? options.enrollPrice : 0,
    payToFounderStatus: options.payToFounderStatus ? options.payToFounderStatus : null,
    payToFounderDateTime: options.payToFounderDateTime ? options.payToFounderDateTime : null,
    payToFounderAmount: options.payToFounderAmount ? options.payToFounderAmount : null,
    payToFounderSchedule: options.payToFounderSchedule ? options.payToFounderSchedule : null,
  }
}

function checkEnrolled(unionId, applys) {
  var result = []
  for (var i = 0; i < applys.length; i++) {
    if (unionId == applys[i].unionId) {
      result.push(i)
    }
  }
  return result
}

function checkActivityEnrollEnable(activity, enrollNumber) {
  //todo 增加是否允许替补的处理
  // if (activity.numberMax < activity.applys.length + enrollNumber) {
  //   return 'enroll count exceed'
  // }
  return 'ok'
}

function notifyGet(req, res) {
  // res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
  res.send(req.query.echostr);
  res.end();
  logger.debug('notifyGet varify token\n', req.query)
  // parser.parseString(req.body, function(err, result) {
  //  logger.debug(err)
  //  logger.debug(result)
  // });
}

function notify(req, res) {
  logger.debug(req.body)
  // res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
  if (req.body.xml.msgtype == 'event' && req.body.xml.event == 'SCAN') {
    procSubsribeNotify(req, res)
  } else if (req.body.xml.msgtype == 'event' && req.body.xml.event == 'subscribe') {
    procSubsribeNotify(req, res)
  } else {
    res.send('');
  }
}

var wechat = require('wechat');
var config = {
  token: 'fuming',
  appid: CONFIG.WECHAT.APPID,
  encodingAESKey: 'XKC4S4xYcIIeAf7KwvXhCfUJVQzivlribjKnxjwjOvk',
  checkSignature: false // 可选，默认为true。由于微信公众平台接口调试工具在明文模式下不发送签名，所以如要使用该测试工具，请将其设置为false
};

app.use(express.query());
app.use(CONFIG.DIR_FIRST + '/ajInterface', wechat(config, function(req, res, next) {
  // 微信输入信息都在req.weixin上
  var message = req.weixin;
  logger.debug(message)
  var eventKey = message.EventKey

  function procSubsribeNotify() {
    mso.delSession(message.FromUserName)
    var ctimeSecond = new Date().getTime() / 1000
    var resp = ''

    mo.findOneDocumentById('qrcodes', eventKey, function(qrcode) {
      if (qrcode) {
        mo.findOneDocumentById('activitys', qrcode.activityId, function(activity) {
          if (activity) {
            if (activity.enrollPrice == 0 && !activity.enrollAgentSwitch) {
              var checkActivityEnrollEnableResult = checkActivityEnrollEnable(activity, 1)
              if (checkActivityEnrollEnableResult == 'ok') {
                axios.get('https://api.weixin.qq.com/cgi-bin/user/info?access_token=' + globalInfo.token.value + '&openid=' + message.FromUserName + '&lang=zh_CN')
                  .then(function(response) {
                    var applyArray = checkEnrolled(response.data.unionid, activity.applys)
                    if (applyArray.length == 0) {
                      enrollActivity(activity, initialApply({
                        openId: response.data.openid,
                        status: activity.activityConfirmSwitch ? 'wait' : 'pass',
                        displayNickName: response.data.nickname,
                        enrollNumber: 1,
                        unionId: response.data.unionid,
                        wechatNickName: response.data.nickname,
                        headimgurl: response.data.headimgurl,
                        confirmTime: activity.activityConfirmSwitch ? null : new Date(),
                        enrollPrice: 0,
                      }), function() {
                        res.reply([{
                          title: '报名成功，点击查看',
                          description: activity.founderNickName + '组织的' + activity.activityTitle,
                          picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
                          url: pu.viewUrl(qrcode.activityId)
                        }]);
                      })
                    } else {
                      res.reply([{
                        title: '您已经报名参加，点击查看',
                        description: activity.founderNickName + '组织的' + activity.activityTitle,
                        picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
                        url: pu.viewUrl(qrcode.activityId)
                      }]);
                    }
                  })
                  .catch(function(error) {
                    logger.error('enrollQrcode get qrcode from wechat\n', error)
                    errorRsp('enrollQrcode get qrcode from wechat by network')
                  });
              } else {
                res.reply([{
                  title: activity.activityTitle + ':' + checkActivityEnrollEnableResult + ':查看详情',
                  description: activity.founderNickName + '组织的' + activity.activityTitle,
                  picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
                  url: pu.viewUrl(qrcode.activityId)
                }]);
              }
            } else {
              res.reply([{
                title: '点击报名参加' + activity.activityTitle,
                description: activity.founderNickName + '组织' + activity.activityTitle,
                picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
                url: pu.viewUrl(qrcode.activityId)
              }]);
              // resp = '<xml><ToUserName><![CDATA[' + req.body.xml.fromusername + ']]></ToUserName><FromUserName><![CDATA[' + req.body.xml.tousername + ']]></FromUserName><CreateTime>' + ctimeSecond + '</CreateTime><MsgType><![CDATA[news]]></MsgType><ArticleCount>1</ArticleCount><Articles><item><Title><![CDATA[点击报名参加' + activity.activityTitle + ']]></Title><Description><![CDATA[' + activity.founderNickName + '组织]]></Description><PicUrl><![CDATA[https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png]]></PicUrl><Url><![CDATA[https://' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/?#/activity_view?activity_id=' + qrcode.activityId + ']]></Url></item></Articles></xml>'
            }
          } else {
            res.reply("error:activity is not existed")
          }
        })
      } else {
        res.reply("error:qrcode is not existed")
      }
    });
  }
  // res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
  if (message.MsgType == 'event' && message.Event == 'SCAN' && message.EventKey) {
    procSubsribeNotify()
  } else if (message.MsgType == 'event' && message.Event == 'subscribe' && message.EventKey) {
    eventKey = message.EventKey.split('_')[1]
    procSubsribeNotify()
  } else if (message.MsgType == 'event' && message.Event == 'unsubscribe') {
    mso.delSession(message.FromUserName)
    res.send('');
  } else {
    res.send('');
  }
  req.session.destroy(function(err) {})
  // req.session.save(null)
}));

function transferAndLog(transferInfo, callback) {
  var insertData = {
    collection: 'logTransfers',
    documents: [{
      transferInfo: transferInfo
    }]
  }
  mo.insertDocuments(insertData, async function(insertResult) {
    transferInfo.partner_trade_no = insertResult.ops[0]._id.toString()
    logger.debug('transferInfo', transferInfo)
    let transferResult = await weixin_pay_api.transfers(transferInfo);
    logger.debug('transferResult', transferResult)
    mo.updateOne('logTransfers', { _id: insertResult.ops[0]._id }, {
      $set: { transferResult: transferResult }
    }, function(updateResult) {
      if (callback) {
        callback(updateResult)
      }
    })
  })
}

function logPay(payInfo, options) {
  var insertData = {
    collection: 'logPays',
    documents: [{
      payInfo: payInfo,
      payType: options.payType,
      payKey: options.payKey,
      status: 'payed'
    }]
  }
  mo.insertDocuments(insertData, function(insertResult) {})
}

app.use(bodyParser.text({ type: '*/xml' }));

app.post(CONFIG.PAY_DIR_FIRST, weixin_pay_api.middlewareForExpress('pay'), (req, res) => {
  let info = req.weixin;
  logger.debug('weixin_pay_api.middlewareForExpress', info)
  mo.findOneDocumentById('unifiedOrders', info.out_trade_no, function(unifiedOrder) {
    if (unifiedOrder && unifiedOrder.payProcess && unifiedOrder.payProcess == 'wait') {
      mo.findOneDocumentById('activitys', unifiedOrder.activityId, function(activity) {
        function processEnroll() {
          var applyArray = checkEnrolled(unifiedOrder.wechatUserInfo.unionid, activity.applys)
          if (applyArray.length == 0) {
            var schedulePayDateTime = (new Date(activity.activityDateTime)).getTime() - 86400000 * activity.confirmDayCount
            var amount = 0
            var payToFounderSchedule = null
            if (info.total_fee == 100 * unifiedOrder.enrollPrice * unifiedOrder.enrollNumber) {
              if (info.total_fee >= 100) {
                amount = Math.floor(info.total_fee * (1 - globalInfo.config.payRatio))
                if (amount < 100) {
                  amount = 100
                }
              }
            }
            if (amount < 100) {
              logger.error('transfer amount less 100', unifiedOrder._id)
              return
            }
            if (schedulePayDateTime < Date.now() && !activity.activityConfirmSwitch) {
              var payToFounderStatus = 'payed'
              var transferInfo = {
                openid: activity.founderOpenId,
                amount: amount,
                desc: unifiedOrder.displayNickName + '支付的' + activity.activityTitle + '活动费用',
                check_name: 'NO_CHECK',
              }
              transferAndLog(transferInfo)
            } else {
              var payToFounderStatus = 'wait'
              payToFounderSchedule = new Date(schedulePayDateTime)
            }
            var apply = initialApply({
              status: activity.activityConfirmSwitch ? 'wait' : 'pass',
              displayNickName: unifiedOrder.displayNickName,
              enrollNumber: unifiedOrder.enrollNumber,
              unionId: unifiedOrder.wechatUserInfo.unionid,
              openId: unifiedOrder.wechatUserInfo.openid,
              wechatNickName: unifiedOrder.wechatUserInfo.nickname,
              headimgurl: unifiedOrder.wechatUserInfo.headimgurl,
              confirmTime: activity.activityConfirmSwitch ? null : new Date(),
              enrollPrice: unifiedOrder.enrollPrice,
              payToFounderStatus: payToFounderStatus,
              payToFounderDateTime: payToFounderStatus == 'payed' ? new Date() : null,
              payToFounderAmount: amount,
              payToFounderSchedule: payToFounderSchedule ? payToFounderSchedule : null
            })
            logPay(info, {
              payType: 'apply',
              payKey: apply._id
            })
            enrollActivity(activity, apply, function() {
              mo.updateOne('unifiedOrders', { _id: unifiedOrder._id }, {
                $set: { payProcess: 'done' }
              }, function(result) {

              })
            })
          } else {
            //已经存在申请，修改报名的逻辑
          }
        }

        function processDel() {
          for (var i = 1; i < activity.applys.length; i++) {
            if (unifiedOrder.applyId.toString() == activity.applys[i]._id.toString()) {
              refundApply(activity.applys[i], function() {
                delApplyFromActivity({
                  activityId: activity._id.toString(),
                  targetApply: activity.applys[i],
                  reason: 'founder delete',
                }, function() {
                  mo.updateOne('unifiedOrders', { _id: unifiedOrder._id }, {
                    $set: { payProcess: 'done' }
                  }, function(result) {})
                })
              })
              break
            }
          }
        }

        if (unifiedOrder.type == 'enroll') {
          processEnroll()
        } else if (unifiedOrder.type == 'delApplyRefund') {
          processDel()
        }
      })
    }
  });
  // 业务逻辑...

  // 回复成功消息
  res.reply();
  req.session.save(null)
  // 回复错误消息
  // res.reply('错误信息');
});

app.get(CONFIG.DIR_FIRST + '/ajaxPub/signWechat', signOutWithAjax);
app.get(CONFIG.DIR_FIRST + '/ajax/index.html', getSession);
app.get(CONFIG.DIR_FIRST + '/ajax/getActivity', getActivity);
app.get(CONFIG.DIR_FIRST + '/ajax/getActivityFoundList', getActivityFoundList);
app.get(CONFIG.DIR_FIRST + '/ajax/getActivityApplyList', getActivityApplyList);
app.get(CONFIG.DIR_FIRST + '/ajwechatLogin', wechatLogin);
app.post(CONFIG.DIR_FIRST + '/ajax/enrollActivity', jsonParser, enrollActivityAjax);
app.post(CONFIG.DIR_FIRST + '/ajax/enrollQrcode', jsonParser, enrollQrcode);
app.post(CONFIG.DIR_FIRST + '/ajax/createActivity', jsonParser, createActivity);
app.post(CONFIG.DIR_FIRST + '/ajax/confirmApply', jsonParser, confirmApply);
app.post(CONFIG.DIR_FIRST + '/ajax/delApply', jsonParser, delApply);
app.post(CONFIG.DIR_FIRST + '/ajhrefRecord', jsonParser, hrefRecord);
app.post(CONFIG.DIR_FIRST + '/ajax/cancelEnrollByCustomer', jsonParser, cancelEnrollByCustomer);
// app.post(CONFIG.DIR_FIRST + '/ajInterface', xmlparser({
//   trim: false,
//   explicitArray: false
// }), notify);

app.get(CONFIG.DIR_FIRST + '/ajInterface', notifyGet);

// console.log(sign(poolConfig, 'http://example.com'));

var server = app.listen(CONFIG.LISTEN_PORT, function() {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Example app listening at http://%s:%s', host, port);
});