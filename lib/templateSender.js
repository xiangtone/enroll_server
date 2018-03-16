var globalInfo = require('../globalInfo.js');
var CONFIG = require('../config.js');
var axios = require('axios');
var templateSender = function() {

  function getTemplateId(options, callback) {
    axios.post('https://api.weixin.qq.com/cgi-bin/template/api_add_template?access_token=' + globalInfo.token.value, {
        "template_id_short": options.shortId
      })
      .then(function(response) {
        logger.debug('getTemplateId', response.data)
        if (response.data.template_id) {
          globalInfo.templateWechatNotify[CONFIG.TEMPLATE_SENDER[options.templateType]] = response.data.template_id
          callback()
        }
      })
      .catch(function(error) {
        logger.error('getTemplateId from wechat\n', error)
      });
  }

  function sendVerify(openId) {
    var msg = {
      "touser": openId,
      // "template_id": "ngqIpbwh8bUfcSsECmogfXcV14J0tQlEpBO27izEYtY",
      "url": "http://weixin.qq.com/download",
      "miniprogram": {
        "appid": "xiaochengxuappid12345",
        "pagepath": "index?foo=bar"
      },
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
    if (globalInfo.templateWechatNotify[CONFIG.TEMPLATE_SENDER.VERIFY]) {
      sendMsg({ template_id: globalInfo.templateWechatNotify[CONFIG.TEMPLATE_SENDER.VERIFY] }, msg)
    } else {
      getTemplateId({
        shortId: CONFIG.TEMPLATE_SENDER.VERIFY,
        templateType: 'VERIFY'
      }, function() {
        sendMsg({ template_id: globalInfo.templateWechatNotify[CONFIG.TEMPLATE_SENDER.VERIFY] }, msg)
      })
    }
  }

  function sendMsg(options, msg) {
    msg.template_id = options.template_id
    axios.post('https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=' + globalInfo.token.value, msg)
      .then(function(response) {
        logger.debug('sendMsg\n', response.data)
      })
      .catch(function(error) {
        logger.error('sendTemplateMsg to wechat\n', error)
      });
  }
}
module.exports = templateSender;