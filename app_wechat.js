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
var xmlparser = require('express-xml-bodyparser');
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

const tenpay = require('tenpay');
const configTenPay = {
  appid: CONFIG.WECHAT.APPID,
  mchid: CONFIG.WXPAY.MCH_ID,
  partnerKey: CONFIG.WXPAY.PARTNER_KEY,
  pfx: require('fs').readFileSync('./key_weixin_pay.p12'),
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


const weixin_pay_api = new tenpay(configTenPay);

app.use(bodyParser.text({ type: '*/xml' }));

app.post(CONFIG.PAY_DIR_FIRST, weixin_pay_api.middlewareForExpress('pay'), (req, res) => {
  let info = req.weixin;
  logger.debug('weixin_pay_api.middlewareForExpress', info)
  mo.findOneDocumentById('unifiedOrders', info.out_trade_no, function(unifiedOrder) {
    logger.debug('weixin_pay_api.middlewareForExpress', unifiedOrder)
    if (unifiedOrder && unifiedOrder.payProcess && unifiedOrder.payProcess == 'wait') {
      mo.findOneDocumentById('activitys', unifiedOrder.activityId, function(activity) {
        logger.debug('weixin_pay_api.middlewareForExpress', activity)
        var applyArray = checkEnroll(unifiedOrder.wechatUserInfo.unionid, activity.applys)
        logger.debug('weixin_pay_api.middlewareForExpress', applyArray, applyArray.length)
        if (applyArray.length == 0) {
          enrollActivity(activity, initialApply({
            status: activity.activityConfirmSwitch ? 'wait' : 'pass',
            displayNickName: unifiedOrder.displayNickName,
            enrollNumber: unifiedOrder.enrollNumber,
            unionId: unifiedOrder.wechatUserInfo.unionid,
            wechatNickName: unifiedOrder.wechatUserInfo.nickname,
            headimgurl: unifiedOrder.wechatUserInfo.headimgurl,
            confirmTime: activity.activityConfirmSwitch ? new Date() : null,
            enrollPrice: unifiedOrder.enrollPrice,
          }), function() {
            mo.updateOne('unifiedOrders', { _id: unifiedOrder._id }, {
              $set: { payProcess: 'done' }
            }, function(result) {})
          })
        } else {

        }
      })
    }
  });
  // 业务逻辑...

  // 回复成功消息
  res.reply();
  // 回复错误消息
  // res.reply('错误信息');
});

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
      enrollAgentSwitch: req.body.enrollAgentSwitch,
      founderUnionId: req.session.fetchWechatUserInfo.unionid,
      lastModifyTime: new Date(),
      applys: [
        initialApply({
          unionId: req.session.fetchWechatUserInfo.unionid,
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

function getActivity(req, res) {
  mo.findOneDocumentById('activitys', req.query.activity_id, function(result) {
    var rsp = {
      status: 'ok',
      data: result,
    }
    res.send(rsp);
  });
}

function enrollActivity(activity, apply, callback) {
  activity.applys.push(apply)
  mo.updateOne('activitys', { _id: activity._id }, {
    $set: { applys: activity.applys }
  }, function(result) {
    logger.debug('enrollActivity', result)
    callback()
  })
}

function enrollActivityAjax(req, res) {
  mo.findOneDocumentById('activitys', req.body.activityId, function(result) {

    function enrollAndSend() {
      enrollActivity(result, initialApply({
        status: result.activityConfirmSwitch ? 'wait' : 'pass',
        displayNickName: req.body.displayNickName,
        enrollNumber: req.body.enrollNumber,
        unionId: req.session.fetchWechatUserInfo.unionid,
        wechatNickName: req.session.fetchWechatUserInfo.nickname,
        headimgurl: req.session.fetchWechatUserInfo.headimgurl,
        confirmTime: result.activityConfirmSwitch ? new Date() : null,
        enrollPrice: 0,
      }), function() {
        res.send(rsp);
      })
      // result.applys.push(initialApply({
      //   status: result.activityConfirmSwitch ? 'wait' : 'pass',
      //   displayNickName: req.body.displayNickName,
      //   enrollNumber: req.body.enrollNumber,
      //   unionId: req.session.fetchWechatUserInfo.unionid,
      //   wechatNickName: req.session.fetchWechatUserInfo.nickname,
      //   headimgurl: req.session.fetchWechatUserInfo.headimgurl,
      //   confirmTime: result.activityConfirmSwitch ? new Date() : null,
      //   enrollPrice: 0,
      // }, req))
      // logger.debug('enrollActivity', result)
      // mo.updateOne('activitys', { _id: new ObjectId(req.body.activityId) }, {
      //   $set: { applys: result.applys }
      // }, function(result) {
      //   res.send(rsp);
      // })
    }

    async function insertUnifiedOrderCallback(insertedUnifiedOrder) {
      if (insertedUnifiedOrder.result.ok == 1) {
        try {
          let unifiedOrder = await weixin_pay_api.unifiedOrder({
            out_trade_no: insertedUnifiedOrder.ops[0]._id.toString(),
            body: '断舍离-活动费用',
            total_fee: 1,
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
    if ((checkEnroll(req.session.fetchWechatUserInfo.unionid, result.applys)).length > 0) {
      rsp = {
        status: 'error',
        msg: 'enrolled',
      }
      res.send(rsp);
    } else {
      if (result.enrollPrice == 0) {
        enrollAndSend()
      } else {
        var insertUnifiedOrderData = {
          collection: 'unifiedOrders',
          documents: [{
            activityId: req.body.activityId,
            wechatUserInfo: req.session.fetchWechatUserInfo,
            enrollNumber: req.body.enrollNumber,
            enrollPrice: result.enrollPrice,
            expiredTime: new Date(Date.now() + 86400 * 1000 * 3),
            payProcess: 'wait',
            displayNickName: req.body.displayNickName,
          }]
        }
        mo.insertDocuments(insertUnifiedOrderData, insertUnifiedOrderCallback)
      }
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

function initialApply(options) {
  return {
    unionId: options.unionId,
    status: options.status,
    applyTime: new Date(),
    confirmTime: options.confirmTime,
    displayNickName: options.displayNickName,
    wechatNickName: options.wechatNickName,
    headimgurl: options.headimgurl,
    enrollNumber: options.enrollNumber ? options.enrollNumber : 1,
    enrollPrice: options.enrollPrice ? options.enrollPrice : 0,
  }
}

function checkEnroll(unionId, applys) {
  var result = []
  for (var i in applys) {
    if (unionId == applys[i].unionId) {
      result.push(i)
    }
  }
  return result
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

function procSubsribeNotify(req, res) {
  var ctimeSecond = new Date().getTime() / 1000
  var resp = ''
  mo.findOneDocumentById('qrcodes', req.body.xml.eventkey, function(qrcode) {
    if (qrcode) {
      mo.findOneDocumentById('activitys', qrcode.activityId, function(activity) {
        if (activity) {
          logger.debug('activity get doc\n', activity)
          var resp = '<xml><ToUserName><![CDATA[' + req.body.xml.fromusername + ']]></ToUserName><FromUserName><![CDATA[' + req.body.xml.tousername + ']]></FromUserName><CreateTime>' + ctimeSecond + '</CreateTime><MsgType><![CDATA[news]]></MsgType><ArticleCount>1</ArticleCount><Articles><item><Title><![CDATA[点击报名参加' + activity.activityTitle + ']]></Title><Description><![CDATA[' + activity.founderNickName + '组织]]></Description><PicUrl><![CDATA[https://mmbiz.qpic.cn/mmbiz_png/2ibBNpREAiabNUuofkibMQoz8yTZfoXnBxoX9Bh42YvuULGqY1bwiaKXtrSeCtoqNbArXL4ask5lZicFvES0UUhcicWw/0?wx_fmt=png]]></PicUrl><Url><![CDATA[https://' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/?#/activity_view?activity_id=' + qrcode.activityId + ']]></Url></item></Articles></xml>'
          // resp = '<xml><ToUserName><![CDATA[' + req.body.xml.fromusername + ']]></ToUserName><FromUserName><![CDATA[' + req.body.xml.tousername + ']]></FromUserName><CreateTime>' + ctimeSecond + '</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[请点击链接开始注册' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/page/tailor.htm]]></Content></xml>'
          logger.debug('rsp \n', resp)
          res.send(resp)
        } else {
          res.send('')
        }
      })
    } else {
      res.send('')
    }
  });
  // poolConfig.query("SELECT state FROM tailors where openId=?", [req.body.xml.fromusername], function(err, rowRs, fields) {
  //   if (err) {
  //     throw err;
  //   } else {
  //     if (rowRs.length > 0) {
  //       if (rowRs[0].state == 'normal') {
  //         resp = '<xml><ToUserName><![CDATA[' + req.body.xml.fromusername + ']]></ToUserName><FromUserName><![CDATA[' + req.body.xml.tousername + ']]></FromUserName><CreateTime>' + ctimeSecond + '</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[您已经是正式缝纫机主，请在网站登录正常使用]]></Content></xml>'
  //       } else {
  //         resp = '<xml><ToUserName><![CDATA[' + req.body.xml.fromusername + ']]></ToUserName><FromUserName><![CDATA[' + req.body.xml.tousername + ']]></FromUserName><CreateTime>' + ctimeSecond + '</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[请修改补充资料继续完成注册' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/page/tailor.htm]]></Content></xml>'
  //       }
  //     } else {
  //       resp = '<xml><ToUserName><![CDATA[' + req.body.xml.fromusername + ']]></ToUserName><FromUserName><![CDATA[' + req.body.xml.tousername + ']]></FromUserName><CreateTime>' + ctimeSecond + '</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[请点击链接开始注册' + CONFIG.DOMAIN + CONFIG.DIR_FIRST + '/page/tailor.htm]]></Content></xml>'
  //     }
  //   }
  //   logger.debug('procSubsribeNotify', resp)
  //   res.send(resp)
  // });
}

app.get(CONFIG.DIR_FIRST + '/ajaxPub/signWechat', signOutWithAjax);
app.get(CONFIG.DIR_FIRST + '/ajax/page/getSession', getSession);
app.get(CONFIG.DIR_FIRST + '/ajax/getActivity', getActivity);
app.post(CONFIG.DIR_FIRST + '/ajax/enrollActivity', jsonParser, enrollActivityAjax);
app.post(CONFIG.DIR_FIRST + '/ajax/enrollQrcode', jsonParser, enrollQrcode);
app.post(CONFIG.DIR_FIRST + '/ajax/createActivity', jsonParser, createActivity);
app.post(CONFIG.DIR_FIRST + '/ajInterface', xmlparser({
  trim: false,
  explicitArray: false
}), notify);
app.get(CONFIG.DIR_FIRST + '/ajInterface', notifyGet);

// console.log(sign(poolConfig, 'http://example.com'));

var server = app.listen(CONFIG.LISTEN_PORT, function() {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Example app listening at http://%s:%s', host, port);
});