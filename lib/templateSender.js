var globalInfo = require('../globalInfo.js');
var CONFIG = require('../config.js');
var axios = require('axios');
var _ = require('lodash');
var log4js = require('log4js');
var logger = log4js.getLogger();

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
          if (count == CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE.length) {
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
            second_class: 'IT软件与服务 '
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


module.exports.sendVerify = function(openId) {
  init(function() {
    var msg = {
      "touser": openId,
      "url": "http://weixin.qq.com/download",
      // "miniprogram": {
      //   "appid": "xiaochengxuappid12345",
      //   "pagepath": "index?foo=bar"
      // },
      "data": {
        "first": {
          "value": "恭喜你购买成功！",
          "color": "#173177"
        },
        "keyword1": {
          "value": "巧克力",
          "color": "#173177"
        },
        "keyword2": {
          "value": "39.8元",
          "color": "#173177"
        },
        "keyword3": {
          "value": "2014年9月22日",
          "color": "#173177"
        },
        "remark": {
          "value": "欢迎再次购买！",
          "color": "#173177"
        }
      }
    }
    sendMsg({ template_id: CONFIG.TEMPLATE_SENDER.ALL_TEMPLATE.VERIFY.ID }, msg)
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