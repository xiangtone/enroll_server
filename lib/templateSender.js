var globalInfo = require('../globalInfo.js');
var CONFIG = require('../config.js');
var axios = require('axios');
var _ = require('lodash');
var log4js = require('log4js');
var logger = log4js.getLogger();
var pu = require('./privateUtil.js');

logger.setLevel(CONFIG.LOG_LEVEL);

var templateWechatNotify = false
var industryInfo = {}

function addTemplate(options, callback) {
  axios.post('https://api.weixin.qq.com/cgi-bin/template/api_add_template?access_token=' + globalInfo.token.value, {
      "template_id_short": options.shortId
    })
    .then(function(response) {
      logger.debug('addTemplate\n', response.data)
      if (response.data.template_id) {
        CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE[options.templateType].ID = response.data.template_id
        callback()
      }
    })
    .catch(function(error) {
      logger.error('addTemplate from wechat\n', error)
    });
}

function delTemplate(options, callback) {
  axios.post('https://api.weixin.qq.com/cgi-bin/template/del_private_template?access_token=' + globalInfo.token.value, {
      "template_id": options.template_id
    })
    .then(function(response) {
      logger.debug('delTemplate\n', response.data)
    })
    .catch(function(error) {
      logger.error('delTemplate from wechat\n', error)
    });
}

function setIndustry(callback) {
  axios.post('https://api.weixin.qq.com/cgi-bin/template/api_set_industry?access_token=' + globalInfo.token.value, CONFIG.TEMPLATE_SENDER.INDUSTRY)
    .then(function(response) {
      logger.debug('setIndustry\n', response.data)
      getAllPrivateTemplate(callback)
    })
    .catch(function(error) {
      logger.error('setIndustry from wechat\n', error)
    });
}

function getIndustry(callback) {
  axios.get('https://api.weixin.qq.com/cgi-bin/template/get_industry?access_token=' + globalInfo.token.value)
    .then(function(response) {
      logger.debug('getIndustry\n', response.data)
      industryInfo = response.data
      callback()
    })
    .catch(function(error) {
      logger.error('getIndustry from wechat\n', error)
    });
}

function getAllPrivateTemplate(callback) {
  axios.get('https://api.weixin.qq.com/cgi-bin/template/get_all_private_template?access_token=' + globalInfo.token.value)
    .then(function(response) {
      logger.debug('getAllPrivateTemplate\n', response.data)
      checkAndAddTemplate(response.data.template_list, callback)
    })
    .catch(function(error) {
      logger.error('getAllPrivateTemplate from wechat\n', error)
    });
}

function checkAndAddTemplate(currentTemplate, callback) {
  var count = 0
  var neverProcess = true
  for (i in CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE) {
    count++
    var needAdd = true
    var isDuplicate = false
    for (j of currentTemplate) {
      if (CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE[i].TITLE == j.title) {
        needAdd = false
        if (isDuplicate) {
          delTemplate({ template_id: j.template_id })
        } else {
          CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE[i].ID = j.template_id
        }
        isDuplicate = true
      }
    }
    if (needAdd) {
      neverProcess = false
      if (currentTemplate.length >= 25) {
        logger.error('wechat template lenth exceed , please check !')
      } else {
        addTemplate({
          shortId: CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE[i].SHORT_ID,
          templateType: i
        }, function() {
          if (count == (Object.keys(CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE)).length) {
            callback()
          }
        })
      }
    }
  }
  if (neverProcess) {
    callback()
  }
  templateWechatNotify = true
  logger.info('CONFIG.TEMPLATE_SENDER\n', CONFIG.TEMPLATE_SENDER)
}

//感觉有并发隐患，做成初始化安装的形式可能比较好
function init(callback) {
  if (templateWechatNotify) {
    callback()
  } else {
    getIndustry(function() {
      logger.debug('industryInfo\n', industryInfo)
      if (_.isEqual(industryInfo, {
          primary_industry: {
            first_class: 'IT科技',
            second_class: 'IT软件与服务'
          },
          secondary_industry: {
            first_class: 'IT科技',
            second_class: '通信与运营商'
          }
        })) {
        getAllPrivateTemplate(callback)
      } else {
        setIndustry(callback)
      }
    })

  }
}


module.exports.sendVerify = function(options) {
  init(function() {
    var activityDateTime = new Date(options.activity.activityDateTime)
    var msg = {
      "touser": options.activity.applys[options.targetIndex].openId,
      "url": pu.viewUrl(options.activity._id),
      // "miniprogram": {
      //   "appid": "xiaochengxuappid12345",
      //   "pagepath": "index?foo=bar"
      // },
      "data": {
        "first": {
          "value": options.activity.founderNickName + '已经通过您的活动申请',
          "color": "#173177"
        },
        "keyword1": {
          "value": options.activity.activityTitle,
          "color": "#173177"
        },
        "keyword2": {
          "value": activityDateTime.getFullYear() + '年' + (activityDateTime.getMonth() + 1) + '月' + activityDateTime.getDate() + '日' + activityDateTime.getHours() + '点' + activityDateTime.getMinutes() + '分',
          "color": "#173177"
        },
        "keyword3": {
          "value": "通过",
          "color": "#173177"
        },
        "remark": {
          "value": "点击可参看活动详情",
          "color": "#173177"
        }
      }
    }
    sendMsg({ template_id: CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE.VERIFY.ID }, msg)
  })
}
module.exports.sendApply = function(options) {
  init(function() {
    var activityDateTime = new Date(options.activity.activityDateTime)
    var msg = {
      "touser": options.activity.founderOpenId,
      "url": pu.viewUrl(options.activity._id),
      // "miniprogram": {
      //   "appid": "xiaochengxuappid12345",
      //   "pagepath": "index?foo=bar"
      // },
      "data": {
        "first": {
          "value": options.activity.applys[options.targetIndex].displayNickName + '[' + options.activity.applys[options.targetIndex].wechatUserInfo.nickname + ']报名参加活动',
          "color": "#173177"
        },
        "keyword1": {
          "value": options.activity.activityTitle,
          "color": "#173177"
        },
        "keyword2": {
          "value": options.activity.activityAddress,
          "color": "#173177"
        },
        "keyword3": {
          "value": activityDateTime.getFullYear() + '年' + (activityDateTime.getMonth() + 1) + '月' + activityDateTime.getDate() + '日' + activityDateTime.getHours() + '点' + activityDateTime.getMinutes() + '分',
          "color": "#173177"
        },
        "keyword4": {
          "value": options.activity.applys[options.targetIndex].status,
          "color": "#173177"
        },
        "remark": {
          "value": "点击可参看活动详情",
          "color": "#173177"
        }
      }
    }
    sendMsg({ template_id: CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE.APPLY.ID }, msg)
  })
}

module.exports.sendReject = function(options) {
  init(function() {
    var msg = {
      "touser": options.activity.applys[options.targetIndex].openId,
      // "url": pu.viewUrl(options.activity._id),
      // "miniprogram": {
      //   "appid": "xiaochengxuappid12345",
      //   "pagepath": "index?foo=bar"
      // },
      "data": {
        "first": {
          "value": options.activity.founderNickName + '已经取消您' + pu.formatDateToDay(options.activity.activityDateTime) + '活动的申请' + (options.activity.applys[options.targetIndex].payToFounderStatus == 'payed' ? '，费用已微信原路退回' : ''),
          "color": "#173177"
        },
        "keyword1": {
          "value": options.activity.activityTitle,
          "color": "#173177"
        },
        "keyword2": {
          "value": "取消",
          "color": "#173177"
        },
      }
    }
    sendMsg({ template_id: CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE.REJECT.ID }, msg)
  })
}


function sendMsg(options, msg) {
  msg.template_id = options.template_id
  logger.debug(msg)
  axios.post('https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=' + globalInfo.token.value, msg)
    .then(function(response) {
      logger.debug('sendMsg\n', response.data)
    })
    .catch(function(error) {
      logger.error('sendTemplateMsg to wechat\n', error)
    });
}