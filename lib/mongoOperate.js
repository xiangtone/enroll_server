const { Mongo } = require('mongodb-pool')
var ObjectId = require('mongodb').ObjectID
var CONFIG = require('../config.js');
module.exports.insertDocuments = function(options, callback) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DBNAME)
  var collection = db.collection(options.collection);
  collection.insertMany(options.documents, function(err, result) {
    callback(result);
  });
}

module.exports.findDocuments = function(options, callback) {
  var client = Mongo.getDb()
  var db = client.db(CONFIG.MONGODB.DBNAME)
  var collection = db.collection(options.collection);
  // Find some documents
  collection.find(options.condition).toArray(function(err, docs) {
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
    callback(docs);
  });
}