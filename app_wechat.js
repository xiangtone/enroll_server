'use strict';
var express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo')(session);
var sign = require('./sign.js');
var CONFIG = require('./config.js');

var log4js = require('log4js');
var logger = log4js.getLogger();

logger.setLevel(CONFIG.LOG_LEVEL);

var app = express();

app.use(session({
  secret: 'iqjmvh-178fd-fwh8f-cfenp',
  resave: true,
  saveUninitialized: true,
  store: new MongoStore({
    username: CONFIG.MONGODB.USER,
    password: CONFIG.MONGODB.PASSWORD,
    url: 'mongodb://192.168.1.119:27017/test',
  })
}));

app.use(express.static(path.join(__dirname, 'static')));

function signOutWithAjax(req, res) {
  res.set({
    "Cache-Control": "no-cache, no-store, max-age=0, must-revalidate",
    "Expires": "-1",
  })
  logger.debug('signOutWithAjax', req.header('Referer'))
  var result = JSON.stringify(sign(globalInfo.jsapiTicket.value, req.header('Referer')));
  res.send(result);
}

app.get(CONFIG.DIR_FIRST + '/ajaxPub/signWechat', signOutWithAjax);

// console.log(sign(poolConfig, 'http://example.com'));

var server = app.listen(CONFIG.LISTEN_PORT, function() {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Example app listening at http://%s:%s', host, port);
});