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
var qr = require('qr-image')
const xml2js = require('xml2js');
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
var fs = require("fs");
var COS = require('cos-nodejs-sdk-v5');
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

const Validator = require('better-validator');
const WrapperFormatter = Validator.format.response.WrapperFormatter;
const FailureFormatter = Validator.format.failure.FailureFormatter;

const check = Validator.koaMiddleware({
  responseFormatter: new WrapperFormatter(),
  failureFormatter: new FailureFormatter()
});

const bodyRuleCreateActivity = (body) => {
  body('founderNickName').required().isString();
  body('activityTitle').required().isString();
  // body('activityDateTime').required().isDate();
  body('activityAddress').required().isString();
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

const weixin_pay_api = new tenpay(configTenPay, false);

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
    // return res.send('<script>location="' + oAuthUrl + '"</script>')
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
        logger.debug('baseinfo\n', rev)
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
        logger.debug('fetch baseinfo\n', rev);
        if (rev.errcode) {
          logger.error('fetch baseinfo')
          req.session.destroy(null)
        } else {
          req.session.fetchWechatUserInfo = rev
          req.session.save(null)
          if (req.session.wechatBase.scope == 'snsapi_userinfo') {
            oAuthUserInfo();
          } else {
            redirectAfterOAuthSuccess();
          }
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
        //don't use redirect 302 , cellphone brower perhaps don't work
        // res.redirect(docHref.href)
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

function hrefRedirect(req, res) {
  mo.insertDocuments({
    collection: 'logHrefs',
    documents: [{
      href: req.query.href,
      expiredTime: new Date(Date.now() + 60 * 1000 * 3),
    }]
  }, function(insertedHref) {
    if (insertedHref.result.ok == 1) {
      res.redirect('https://open.weixin.qq.com/connect/oauth2/authorize?appid=' + CONFIG.WECHAT.APPID + '&redirect_uri=' + encodeURIComponent('https://' + req.hostname + '/' + CONFIG.DIR_FIRST + '/ajwechatLogin') + '&response_type=code&scope=snsapi_base&state=' + insertedHref.ops[0]._id + '#wechat_redirect')
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
  ret.globalConfig = globalInfo.config
  var result = JSON.stringify(ret);
  res.send(result);
}

async function qrPayImg(req, res) {
  // let data = {
  //   appid: CONFIG.WECHAT.APPID,
  //   mch_id: CONFIG.WXPAY.MCH_ID,
  //   nonce_str: pu.createNonceStr(),
  //   product_id: req.query.product_id,
  //   time_stamp: pu.createTimestamp()
  // }
  // let stringSignTemp=pu.raw(data)+"&key="+CONFIG.WXPAY.PARTNER_KEY
  // data.sign = pu.wxSignature(data)
  // logger.debug('qrPayImg', pu.raw(data))
  // "weixin://wxpay/bizpayurl?appid=wx2421b1c4370ec43b&mch_id=10000100&nonce_str=f6808210402125e30663234f94c87a8c&product_id=1&time_stamp=1415949957&sign=512F68131DD251DA4A45DA79CC7EFE9D"

  let result = await weixin_pay_api.getNativeUrl({
    product_id: req.query.product_id
  });
  var text = result;
  try {
    var img = qr.image(text, { size: 10 });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    img.pipe(res);
  } catch (e) {
    res.writeHead(414, { 'Content-Type': 'text/html' });
    res.end('<h1>414 Request-URI Too Large</h1>');
  }
}

function qrPayImgResult(req, res) {
  if (lastTotalFee != '') {
    res.send(lastTotalFee + '|0')
    lastTotalFee = ''
  } else {
    res.send('none')
  }
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
      activityField: req.body.activityField,
      activityNotice: req.body.activityNotice,
      activityDateTime: new Date(req.body.activityDateTime),
      spendHours: req.body.spendHours,
      numberMax: req.body.numberMax,
      numberMin: req.body.numberMin,
      confirmDayCount: req.body.confirmDayCount,
      enrollPrice: req.body.enrollPrice,
      enrollPriceFemale: req.body.enrollPriceFemale,
      activityConfirmSwitch: req.body.activityConfirmSwitch,
      enrollAgentSwitch: req.body.enrollAgentSwitch,
      alternateSwitch: req.body.alternateSwitch,
      notifySwitch: req.body.notifySwitch,
      cover: req.body.cover,
      founderUnionId: req.session.fetchWechatUserInfo.unionid,
      founderOpenId: req.session.fetchWechatUserInfo.openid,
      lastModifyTime: new Date(),
      applys: [
        initialApply({
          unionId: req.session.fetchWechatUserInfo.unionid,
          openId: req.session.fetchWechatUserInfo.openid,
          status: 'pass',
          wechatNickName: req.session.fetchWechatUserInfo.nickname,
          wechatUserInfo: req.session.fetchWechatUserInfo,
          displayNickName: req.body.founderNickName,
          headimgurl: req.session.fetchWechatUserInfo.headimgurl,
          confirmTime: new Date(),
          enrollNumber: req.session.fetchWechatUserInfo.sex == 2 ? 0 : 1,
          enrollNumberFemale: req.session.fetchWechatUserInfo.sex == 2 ? 1 : 0,
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
      function processApply(apply, indexI) {
        function sendCancel() {
          ts.sendCancel({ activity: activity, targetIndex: indexI })
        }
        if (req.session.fetchWechatUserInfo.unionid == apply.unionId) {
          if (apply.enrollPrice == 0) {
            delApplyFromActivity({
              activityId: activity._id.toString(),
              targetApply: apply,
              reason: 'customer cancel fee free',
            }, sendCancel)
          } else if (apply.payToFounderStatus == 'wait' && !apply.payToFounderDateTime) {
            refundApply(apply, function() {
              delApplyFromActivity({
                activityId: activity._id.toString(),
                targetApply: apply,
                reason: 'customer cancel , not transfer to founder yet',
              }, sendCancel)
            })
          } else if (apply.payToFounderStatus == 'payed' && apply.payToFounderDateTime && apply.payToFounderAmount >= 100) {
            rsp = { status: 'error', msg: '费用已支付给组织者，请联系组织者在报名中退费' }
          } else {
            delApplyFromActivity({
              activityId: activity._id.toString(),
              targetApply: apply,
              reason: 'customer cancel',
            }, sendCancel)
          }
        }
      }
      if (checkFounderSession(activity, req)) {
        res.send({ status: 'error', msg: 'founder can not cancel' })
      } else {
        for (var i = 1; i < activity.applys.length; i++) {
          processApply(activity.applys[i], i)
        }
        res.send(rsp)
      }
    } else {
      res.send({ status: 'error', msg: 'activity is not exist' })
    }
  })
}

function delActivity(req, res) {
  mo.findOneDocumentById('activitys', req.body.activity_id, function(activity) {
    if (checkFounderSession(activity, req)) {
      if (activity.applys.length == 1) {
        mo.updateOne('activitys', { _id: new ObjectId(req.body.activity_id) }, { $set: { status: 'delete' } }, function(docs) {
          sendOk(res)
        })
      } else {
        res.send({
          status: 'error',
          msg: 'please delete all other apply'
        })
      }
    } else {
      res.send({
        status: 'error',
        msg: 'only founder can do'
      })
    }
  })
}

function sendOk(res) {
  res.send({
    status: 'ok',
  })
}

function delApply(req, res) {
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
                  body: '退回' + activity.applys[i].displayNickName + '参加' + activity.activityTitle + '的费用',
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

          if ((activity.applys[i].enrollPrice * activity.applys[i].enrollNumber + activity.applys[i].enrollPriceFemale * activity.applys[i].enrollNumberFemale) == 0) {
            delApplyFromActivity({
              activityId: activity._id.toString(),
              targetApply: activity.applys[i],
              reason: 'founder delete',
            }, function() {
              sendOk(res)
              ts.sendReject({ activity: activity, targetIndex: targetI })
            })
          } else if (activity.applys[i].payToFounderStatus == 'wait' && !activity.applys[i].payToFounderDateTime) {
            logger.debug('enter refund process')
            refundApply(activity.applys[i], function() {
              delApplyFromActivity({
                activityId: activity._id.toString(),
                targetApply: activity.applys[i],
                reason: 'founder delete payToFounderStatus is wait',
              }, function() {
                sendOk(res)
                ts.sendReject({ activity: activity, targetIndex: targetI })
              })
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
            }, function() {
              sendOk(res)
              ts.sendReject({ activity: activity, targetIndex: targetI })
            })
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

function checkFounderSessionWithActivityId(activityId, req, success, fail) {
  mo.findOneDocumentById('activitys', activityId, function(activity) {
    if (activity.founderUnionId == req.session.fetchWechatUserInfo.unionid) {
      success(activity)
    } else {
      fail()
    }
  })
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
    if (activity) {
      if (activity.status && activity.status == 'delete') {
        res.send({
          status: 'error',
          msg: 'activity is delete'
        });
      } else {
        res.send({
          status: 'ok',
          data: activity,
        });
      }
    } else {
      res.send({
        status: 'error',
        msg: 'activity is not exist'
      });
    }
  });
}

function getActivityFoundList(req, res) {
  mo.findDocuments({
    collection: 'activitys',
    condition: {
      founderUnionId: req.session.fetchWechatUserInfo.unionid,
      status: { $ne: 'delete' }
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
      "applys.unionId": req.session.fetchWechatUserInfo.unionid,
      status: { $ne: 'delete' }
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
    if (activity.notifySwitch) {
      mo.findOneDocumentById('activitys', activity._id.toString(), function(doc) {
        ts.sendApply({ activity: doc, targetIndex: activity.applys.length })
      })
    }
    callback()
  })
}

function enrollApplyStatistics(activity) {
  var result = 0
  for (var apply of activity.applys) {
    if (apply.status == 'pass') {
      result += parseInt(apply.enrollNumber + apply.enrollNumberFemale)
    }
  }
  return result
}

function checkOverTime(activity) {
  var activityBeginDate = new Date(activity.activityDateTime)
  if (activityBeginDate.getTime() + 1000 * 3600 * activity.spendHours < Date.now()) {
    return true
  } else {
    return false
  }
}

function picUploadAjax(req, res) {
  if (!req.body) return res.sendStatus(400)

  checkFounderSessionWithActivityId(req.query.activityId, req, checkFounderSuccess, function() {
    res.send({
      status: 'error',
      data: 'not founder'
    })
  })

  function checkFounderSuccess(activity) {
    //todo check readId
    var successUploadCount = 0
    var successUploadBytes = 0
    var ctime = new Date()
    for (var i = 0; i < req.body.serverId.length; i++) {
      downloadWechatPicMedia(req.body.serverId[i]);
    }
    var keyNames = []
    var paramsForCos = {
      SecretId: CONFIG.QCLOUD_PARA.SecretId,
      SecretKey: CONFIG.QCLOUD_PARA.SecretKey,
    }
    var cos = new COS(paramsForCos);

    function downloadWechatPicMedia(mediaId) {
      var https = require('https');
      var url = 'https://api.weixin.qq.com/cgi-bin/media/get?access_token=' + globalInfo.token.value + '&media_id=' + mediaId
      https.get(url, function(response) {
        response.setEncoding("binary");
        var body = '';
        response.on('data', function(d) {
          body += d;
        });
        response.on('end', function() {
          var tmpFileName = "./tmp/" + mediaId + ".jpg"
          fs.writeFile(tmpFileName, body, "binary", function(err) {
            if (err) {
              logger.error("write fail", url);
              return
            }
            // logger.debug('paramsForCos', paramsForCos)

            // 分片上传
            var keyFileNameWithTime = ctime.getFullYear() + '/' + (ctime.getMonth() + 1) + '/' + ctime.getDate() + '/' + req.session.wechatBase.openid + '-' + mediaId + '.jpg'
            var paramsForUpload = {
              Bucket: CONFIG.QCLOUD_PARA.COS.Bucket,
              Region: CONFIG.QCLOUD_PARA.COS.Region,
              Key: keyFileNameWithTime,
              FilePath: tmpFileName
            }
            cos.sliceUploadFile(paramsForUpload, function(err, data) {
              if (err) {
                logger.error('cos.sliceUploadFile', arguments);
              } else {
                //delete tmp file
                fs.unlink(tmpFileName, (err) => {
                  if (err) {
                    logger.error('fs.unlink', err);
                  }
                  successUploadCount++
                  successUploadBytes += body.length
                  keyNames.push(keyFileNameWithTime)
                  if (successUploadCount == req.body.serverId.length) {
                    processCmd()
                  }
                });
              }
            });
            // var paramsForUpload = {
            //  Bucket: CONFIG.QCLOUD_PARA.COS.Bucket,
            //  Region: CONFIG.QCLOUD_PARA.COS.Region,
            //  Key: keyFileNameWithTime,
            //  // FilePath: tmpFileName,
            //  // Body: fs.readFileSync(tmpFileName),
            //  Body: fs.createReadStream(tmpFileName),
            //  ContentLength: fs.statSync(tmpFileName).size
            // }
            // cos.putObject(paramsForUpload, function(err, data) {
            //  logger.debug(arguments)
            //  if (err) {
            //    logger.error('cos.sliceUploadFile', arguments);
            //  } else {
            //    //delete tmp file
            //    fs.unlink(tmpFileName, (err) => {
            //      if (err) {
            //        logger.error('fs.unlink', err);
            //      }
            //      successUploadCount++
            //      successUploadBytes += body.length
            //      keyNames.push(keyFileNameWithTime)
            //      if (successUploadCount == req.body.serverId.length) {
            //        processCmd()
            //      }
            //    });
            //  }
            // });
          });
        });
      });
    };

    function processCover() {
      function updateCover() {
        mo.updateOne('activitys', { _id: activity._id }, {
          $set: {
            cover: keyNames[0],
          }
        }, function(result) {
          if (result.result.ok == 1) {
            successGlobalRsp(res)
            // logger.debug('updateCover done')
            // res.send({ status: 'ok' })
          } else {
            errorGlobalRsp('activity cover update mongodb error', res)
          }
        })
      }

      function deleletOldCover() {
        var params = {
          Bucket: CONFIG.QCLOUD_PARA.COS.Bucket,
          Region: CONFIG.QCLOUD_PARA.COS.Region,
          Key: activity.cover
        };

        cos.deleteObject(params, function(err, data) {
          if (err) {
            logger.error('deleletOldCover', err);
          } else {
            updateCover()
          }
        });
      }

      function procExistedCover() {
        var findTarget = {
          collection: 'activitys',
          condition: {
            'cover': activity.cover,
          }
        }
        mo.findDocuments(findTarget, function(docs) {
          if (docs.length > 1) {
            updateCover()
          } else {
            deleletOldCover()
          }
        })
      }
      if (activity.cover) {
        procExistedCover()
      } else {
        updateCover()
      }
    }

    function processCmd() {
      switch (req.query.act) {
        case "cover":
          processCover();
          break;
        case "note":
          // insertNote();
          break;
        default:
          // ...
      }
    }
  }
}

function cleanEmoji(ori) {
  var regStr = /[\uD83C|\uD83D|\uD83E][\uDC00-\uDFFF][\u200D|\uFE0F]|[\uD83C|\uD83D|\uD83E][\uDC00-\uDFFF]|[0-9|*|#]\uFE0F\u20E3|[0-9|#]\u20E3|[\u203C-\u3299]\uFE0F\u200D|[\u203C-\u3299]\uFE0F|[\u2122-\u2B55]|\u303D|[\A9|\AE]\u3030|\uA9|\uAE|\u3030/ig;
  if (regStr.test(ori)) {
    return ori.replace(regStr, "")
  } else {
    return ori
  }
}

function enrollActivityAjax(req, res) {
  req.body.enrollNumber = parseInt(req.body.enrollNumber)
  req.body.enrollNumberFemale = parseInt(req.body.enrollNumberFemale)
  if (isNaN(req.body.enrollNumberFemale)) {
    req.body.enrollNumberFemale = 0
  }
  if (isNaN(req.body.enrollNumber)) {
    req.body.enrollNumber = 0
  }
  mo.findOneDocumentById('activitys', req.body.activityId, function(activity) {
    if (activity) {
      var fee = 0
      var rsp = { status: 'ok' }

      function checkEnrollAvailable() {
        if (enrollApplyStatistics(activity) >= activity.numberMax) {
          return '人数超限'
        } else if (checkOverTime(activity)) {
          return '活动已过期'
        } else {
          return ''
        }
      }

      var resultCheckEnrollAvailable = checkEnrollAvailable()

      if (resultCheckEnrollAvailable) {
        rsp = {
          status: 'error',
          msg: resultCheckEnrollAvailable,
        }
        res.send(rsp);
        return
      }

      if (!activity.enrollAgentSwitch) {
        if (req.session.fetchWechatUserInfo.sex == 2) {
          req.body.enrollNumberFemale = 1
          req.body.enrollNumber = 0
        } else {
          req.body.enrollNumberFemale = 0
          req.body.enrollNumber = 1
        }
      }

      function enrollAndSend() {
        enrollActivity(activity, initialApply({
          status: activity.activityConfirmSwitch ? 'wait' : 'pass',
          displayNickName: req.body.displayNickName,
          enrollNumber: req.body.enrollNumber,
          enrollNumberFemale: req.body.enrollNumberFemale,
          unionId: req.session.fetchWechatUserInfo.unionid,
          openId: req.session.fetchWechatUserInfo.openid,
          wechatNickName: req.session.fetchWechatUserInfo.nickname,
          wechatUserInfo: req.session.fetchWechatUserInfo,
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
              body: cleanEmoji('参加' + activity.founderNickName + '组织的' + activity.activityTitle + '的费用'),
              total_fee: 100 * fee,
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

      function feeCompute() {
        var result = 0
        if (activity.enrollPrice == 0 && activity.enrollPriceFemale == 0) {
          return result
        } else {
          if (activity.enrollAgentSwitch) {
            return activity.enrollPriceFemale * parseInt(req.body.enrollNumberFemale) + activity.enrollPrice * parseInt(req.body.enrollNumber)
          } else {
            if (req.session.fetchWechatUserInfo.sex == 2) {
              req.body.enrollNumberFemale = 1
              req.body.enrollNumber = 0
              return activity.enrollPriceFemale
            } else {
              req.body.enrollNumberFemale = 0
              req.body.enrollNumber = 1
              return activity.enrollPrice
            }
          }
        }
      }

      if ((checkEnrolled(req.session.fetchWechatUserInfo.unionid, activity.applys)).length > 0) {
        rsp = {
          status: 'error',
          msg: 'enrolled',
        }
        res.send(rsp);
      } else {
        fee = feeCompute()
        if (fee == 0) {
          enrollAndSend()
        } else {
          var insertUnifiedOrderData = {
            collection: 'unifiedOrders',
            documents: [{
              activityId: req.body.activityId,
              wechatUserInfo: req.session.fetchWechatUserInfo,
              enrollNumber: req.body.enrollNumber,
              enrollPrice: activity.enrollPrice,
              enrollNumberFemale: req.body.enrollNumberFemale,
              enrollPriceFemale: activity.enrollPriceFemale,
              expiredTime: new Date(Date.now() + 86400 * 1000 * 3),
              payProcess: 'wait',
              displayNickName: req.body.displayNickName,
              type: 'enroll',
            }]
          }
          mo.insertDocuments(insertUnifiedOrderData, insertUnifiedOrderCallback)
        }
      }
    } else {
      res.send({ status: 'error', msg: 'activity can not find' });
    }
  });
}

function errorGlobalRsp(msg, res) {
  var rsp = {
    status: 'error',
    msg: msg
  }
  res.send(rsp)
}

function successGlobalRsp(res) {
  res.send({ status: 'ok' });
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
    wechatUserInfo: options.wechatUserInfo,
    applyTime: new Date(),
    confirmTime: options.confirmTime,
    displayNickName: options.displayNickName,
    wechatNickName: options.wechatNickName,
    headimgurl: options.headimgurl,
    enrollNumber: parseInt(options.enrollNumber),
    enrollNumberFemale: parseInt(options.enrollNumberFemale),
    enrollPrice: options.enrollPrice ? options.enrollPrice : 0,
    enrollPriceFemale: options.enrollPriceFemale ? options.enrollPriceFemale : 0,
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

function formatActivityDescription(activity) {
  return pu.formatDateToDay(activity.activityDateTime) + '[' + activity.founderNickName + ']组织的' + activity.activityTitle
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

    if (eventKey) {
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
                          enrollNumber: response.data.sex == 2 ? 0 : 1,
                          enrollNumberFemale: response.data.sex == 2 ? 1 : 0,
                          unionId: response.data.unionid,
                          wechatUserInfo: response.data,
                          wechatNickName: response.data.nickname,
                          headimgurl: response.data.headimgurl,
                          confirmTime: activity.activityConfirmSwitch ? null : new Date(),
                          enrollPrice: 0,
                        }), function() {
                          res.reply([{
                            title: '报名成功，点击查看',
                            description: formatActivityDescription(activity),
                            picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
                            url: pu.viewUrl(qrcode.activityId)
                          }]);
                        })
                      } else {
                        res.reply([{
                          title: '您已经报名参加，点击查看',
                          description: formatActivityDescription(activity),
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
                    description: formatActivityDescription(activity),
                    picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
                    url: pu.viewUrl(qrcode.activityId)
                  }]);
                }
              } else {
                res.reply([{
                  title: '点击报名参加' + activity.activityTitle,
                  description: formatActivityDescription(activity),
                  picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
                  url: pu.viewUrl(qrcode.activityId)
                }]);
                // resp = '<xml><ToUserName><![CDATA[' + req.body.xml.fromusername + ']]></ToUserName><FromUserName><![CDATA[' + req.body.xml.tousername + ']]></FromUserName><CreateTime>' + ctimeSecond + '</CreateTime><MsgType><![CDATA[news]]></MsgType><ArticleCount>1</ArticleCount><Articles><item><Title><![CDATA[点击报名参加' + activity.activityTitle + ']]></Title><Description><![CDATA[' + activity.founderNickName + '组织]]></Description><PicUrl><![CDATA[https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png]]></PicUrl><Url><![CDATA[https://' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/?#/activity_view?activity_id=' + qrcode.activityId + ']]></Url></item></Articles></xml>'
              }
            } else {
              logger.error("error:activity is not existed")
              res.reply("error:activity is not existed")
            }
          })
        } else {
          logger.error("error:qrcode is not existed")
          res.reply("error:qrcode is not existed")
        }
      });
    } else {
      res.reply([{
        title: '点击发起活动',
        description: '发起新活动',
        picurl: 'https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png',
        url: 'https://' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/?#/activity_edit'
      }]);
    }
  }
  // res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
  if (message.MsgType == 'event' && message.Event == 'SCAN' && message.EventKey) {
    procSubsribeNotify()
  } else if (message.MsgType == 'event' && message.Event == 'subscribe') {
    if (eventKey.indexOf('_') > 0) {
      eventKey = message.EventKey.split('_')[1]
    }
    procSubsribeNotify()
  } else if (message.MsgType == 'event' && message.Event == 'unsubscribe') {
    mso.delSession(message.FromUserName)
    res.send('');
  } else {
    res.send('');
  }
  req.session.destroy(null)
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

function getPayBodyByProductId(productId) {
  switch (productId) {
    case '99':
      return { fee: 99, body: '密室逃脱：越狱100个房间之五，获取 6 个提示!' }
    case '299':
      return { fee: 299, body: '密室逃脱：越狱100个房间之五，获取 20 个提示!' }
    case '499':
      return { fee: 499, body: '密室逃脱：越狱100个房间之五，获取 40 个提示!' }
    case '799':
      return { fee: 799, body: '密室逃脱：越狱100个房间之五，获取 60 个提示!' }
    case '1499':
      return { fee: 1499, body: '密室逃脱：越狱100个房间之五，获取 150 个提示!' }
    default:
      return { fee: 1, body: '测试' }
  }
}

app.post(CONFIG.PAY_DIR_FIRST + 'qr', weixin_pay_api.middlewareForExpress('nativePay'), async(req, res) => {
  let info = req.weixin;
  // logger.debug('weixin_pay_api.middlewareForExpress', CONFIG.PAY_DIR_FIRST + 'qr\n', info)
  let bodyInfo = getPayBodyByProductId(info.product_id)
  let unifiedOrder = await weixin_pay_api.unifiedOrder({
    out_trade_no: pu.createNonceStr(),
    body: bodyInfo.body,
    total_fee: bodyInfo.fee,
    openid: info.openid,
    trade_type: 'NATIVE',
    // notify_url: 'https://' + CONFIG.DOMAIN + '/' + CONFIG.PAY_DIR_FIRST + insertedUnifiedOrder.ops[0]._id.toString(),
  });
  // logger.debug('qr unifiedOrder\n', unifiedOrder)
  let rsp = {
    return_code: 'SUCCESS',
    appid: CONFIG.WECHAT.APPID,
    mch_id: CONFIG.WXPAY.MCH_ID,
    nonce_str: info.nonce_str,
    prepay_id: unifiedOrder.prepay_id,
    result_code: 'SUCCESS',
  }
  rsp.sign = await weixin_pay_api._getSign(rsp)

  // logger.debug('qr rsp\n', rsp)
  // res.reply(rsp);

  const opt = { xmldec: null, rootName: 'xml', allowSurrogateChars: true, cdata: true };
  // logger.debug('qr rsp\n', new xml2js.Builder(opt).buildObject(rsp))
  res.send(new xml2js.Builder(opt).buildObject(rsp));
})
// app.post(CONFIG.PAY_DIR_FIRST + 'qr', (req, res) => {
//   logger.debug('req.body qr', req.body)
// })
var lastTotalFee = ''
app.post(CONFIG.PAY_DIR_FIRST, weixin_pay_api.middlewareForExpress('pay'), (req, res) => {
  let info = req.weixin;
  logger.debug('weixin_pay_api.middlewareForExpress', info)
  lastTotalFee = info.total_fee
  mo.findOneDocumentById('unifiedOrders', info.out_trade_no, function(unifiedOrder) {
    if (unifiedOrder && unifiedOrder.payProcess && unifiedOrder.payProcess == 'wait') {
      mo.findOneDocumentById('activitys', unifiedOrder.activityId, function(activity) {
        logger.debug('weixin_pay_api.middlewareForExpress get activity\n', activity)

        function processEnroll() {
          var applyArray = checkEnrolled(unifiedOrder.wechatUserInfo.unionid, activity.applys)
          if (applyArray.length == 0) {
            var schedulePayDateTime = (new Date(activity.activityDateTime)).getTime() - 86400000 * activity.confirmDayCount
            var amount = 0
            var payToFounderSchedule = null
            if (info.total_fee == 100 * (unifiedOrder.enrollPrice * unifiedOrder.enrollNumber + unifiedOrder.enrollPriceFemale * unifiedOrder.enrollNumberFemale)) {
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
              enrollNumberFemale: unifiedOrder.enrollNumberFemale,
              unionId: unifiedOrder.wechatUserInfo.unionid,
              openId: unifiedOrder.wechatUserInfo.openid,
              wechatNickName: unifiedOrder.wechatUserInfo.nickname,
              wechatUserInfo: unifiedOrder.wechatUserInfo,
              headimgurl: unifiedOrder.wechatUserInfo.headimgurl,
              confirmTime: activity.activityConfirmSwitch ? null : new Date(),
              enrollPrice: unifiedOrder.enrollPrice,
              enrollPriceFemale: unifiedOrder.enrollPriceFemale,
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
          logger.debug('weixin_pay_api.middlewareForExpress try to delApplyRefund')
          for (var i = 1; i < activity.applys.length; i++) {
            logger.debug('weixin_pay_api.middlewareForExpress compare,', unifiedOrder.applyId.toString())
            logger.debug('weixin_pay_api.middlewareForExpress compare,', activity.applys[i]._id.toString())
            if (unifiedOrder.applyId.toString() == activity.applys[i]._id.toString()) {
              logger.debug('weixin_pay_api.middlewareForExpress begin delApplyRefund')
              refundApply(activity.applys[i], function() {
                logger.debug('weixin_pay_api.middlewareForExpress begin delApplyRefund callback')
                delApplyFromActivity({
                  activityId: activity._id.toString(),
                  targetApply: activity.applys[i],
                  reason: 'founder delete',
                }, function() {
                  logger.debug('weixin_pay_api.middlewareForExpress delete apply')
                  mo.updateOne('unifiedOrders', { _id: unifiedOrder._id }, {
                    $set: { payProcess: 'done' }
                  }, function(result) {
                    ts.sendReject({ activity: activity, targetIndex: i })
                  })
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
  req.session.destroy(null)
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
app.post(CONFIG.DIR_FIRST + '/ajax/picUploadAjax', jsonParser, picUploadAjax);
app.post(CONFIG.DIR_FIRST + '/ajax/enrollQrcode', jsonParser, enrollQrcode);
// app.post(CONFIG.DIR_FIRST + '/ajax/createActivity', jsonParser, check.params(bodyRuleCreateActivity), createActivity);
app.post(CONFIG.DIR_FIRST + '/ajax/createActivity', jsonParser, createActivity);
app.post(CONFIG.DIR_FIRST + '/ajax/confirmApply', jsonParser, confirmApply);
app.post(CONFIG.DIR_FIRST + '/ajax/delApply', jsonParser, delApply);
app.post(CONFIG.DIR_FIRST + '/ajax/delActivity', jsonParser, delActivity);
app.post(CONFIG.DIR_FIRST + '/ajhrefRecord', jsonParser, hrefRecord);
app.get(CONFIG.DIR_FIRST + '/ajhrefRedirect', hrefRedirect);
app.get(CONFIG.DIR_FIRST + '/ajQrPayImg', qrPayImg);
app.get(CONFIG.DIR_FIRST + '/ajQrPayImgResult', qrPayImgResult);
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