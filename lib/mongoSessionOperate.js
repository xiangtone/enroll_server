const { Mongo } = require('mongodb-pool')
var ObjectId = require('mongodb').ObjectID
var CONFIG = require('../config.js');
var log4js = require('log4js');
var logger = log4js.getLogger();
logger.setLevel(CONFIG.LOG_LEVEL);
Mongo.getConnection(CONFIG.MONGODB.URL_SESSION, {
  poolSize: 2,
  auto_reconnect: true,
}).then()
module.exports.delSession = function(openId) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DB_SESSION_NAME)
  var collection = db.collection('sessions');
  // Find some documents
  // var target = eval()
  collection.remove({
    session: { $regex: openId }
  }, function(err, docs) {});
}