const { Mongo } = require('mongodb-pool')
var ObjectId = require('mongodb').ObjectID
var CONFIG = require('../config.js');
var log4js = require('log4js');
var logger = log4js.getLogger();
logger.setLevel(CONFIG.LOG_LEVEL);
Mongo.getConnection(CONFIG.MONGODB.URL_ACTIVITY, {
  poolSize: 3,
  auto_reconnect: true,
}).then()
module.exports.insertDocuments = function(options, callback) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DBNAME)
  var collection = db.collection(options.collection);
  collection.insertMany(options.documents, function(err, result) {
    if (err) { logger.error('insertDocuments', err) }
    callback(result);
  });
}

module.exports.findDocuments = function(options, callback) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DBNAME)
  var collection = db.collection(options.collection);
  // Find some documents
  collection.find(options.condition).toArray(function(err, docs) {
    if (err) { logger.error('findDocuments', err) }
    callback(docs);
  });
}
module.exports.findOneDocumentById = function(collectionName, _idString, callback) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DBNAME)
  var collection = db.collection(collectionName);
  // Find some documents
  collection.findOne({
    "_id": new ObjectId(_idString)
  }, function(err, docs) {
    if (err) { logger.error('findOneDocumentById', err) }
    callback(docs);
  });
}
module.exports.findOneDocumentByFilter = function(collectionName, filter, options, callback) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DBNAME)
  var collection = db.collection(collectionName);
  // Find some documents
  collection.findOne(filter, function(err, docs) {
    if (err) { logger.error('findOneDocumentById', err) }
    callback(docs);
  });
}
module.exports.updateOne = function(collectionName, filter, update, callback) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DBNAME)
  var collection = db.collection(collectionName);
  // Find some documents
  collection.updateOne(filter, update, function(err, docs) {
    if (err) { logger.error('updateOne', err) }
    callback(docs);
  });
}