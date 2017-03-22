'use strict';

console.log('Loading function');

var Client = require('3scale').Client;
var createClient = require('then-redis').createClient
var Q = require('q');
var _ = require('underscore');

var AWS = require('aws-sdk');
AWS.config.region = process.env.AWS_REGION;

var client = new Client(process.env.THREESCALE_PROVIDER_KEY);
var service_id = process.env.THREESCALE_SERVICE_ID

var db = createClient({
  host: process.env.ELASTICACHE_ENDPOINT,
  port: process.env.ELASTICACHE_PORT
});

module.exports.authorizer = (event, context, callback) => {
  var token = event.authorizationToken;

  if(process.env.THREESCALE_AUTH_TYPE == "OAUTH"){
    oauthAuthorizer(token,context,event)
  }else{
    userKeyAuthorizer(token,context,event)
  }
};

module.exports.authRepAsync = (event, context, callback) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  var token = JSON.parse(event.Records[0].Sns.Message).token;
  if(process.env.THREESCALE_AUTH_TYPE == "OAUTH"){
    var app_id = JSON.parse(event.Records[0].Sns.Message).app_id
    oauth_authorize(app_id).then(function(result){
      console.log("reported",result)
    }).catch(function(err){
      console.log("ERROR:",err);

      //delete ken from cache
      db.del(token)
    }).done(function(){
      console.log("DONE")
      context.done();
    });
  }else{
    auth(token).then(function(result){
      console.log("3scale response",result);
      var metrics = _.pluck(result.usage_reports,'metric')
      var cached_key = service_id+":"
      _.each(metrics,function(m){
        cached_key += "usage['"+m+"']=1&"
      })

      //store in cache
      db.set(token,cached_key);
    }).catch(function(err){
      console.log("ERROR:",err);

      //delete ken from cache
      db.del(token)
    }).done(function(){
      console.log("DONE")
      context.done();
    });
  }
}


//oAuth flow
function oauthAuthorizer(token, context, event){
  db.get(token).then(function(value){
    if (value != null) {
      console.log('Token exists in cache, value is',value);
      var sns = new AWS.SNS();
      var message = {token: token, app_id: value}
      sns.publish({
          Message: JSON.stringify(message),
          TopicArn: process.env.SNS_AUTHREP_ARN
      }, function(err, data) {
          if (err) {
              console.log(err.stack);
              return;
          }
          console.log('push sent',data);
          context.succeed(generatePolicy('user', 'Allow', event.methodArn));
      });
    } else {
      console.log('Token does not exist in cache');
      console.log("ERROR:","Token not in cache, needs to call /oauth/token");
      context.succeed(generatePolicy('user', 'Deny', event.methodArn));
    }
  })
}

//UserKey flow
function userKeyAuthorizer(token, context, event){
  db.get(token).then(function(value){
    if (value != null) {
      console.log('Token exists in cache, value is',value);

      //Send message on threescaleAsync SNS topic
      //message contains token
      var sns = new AWS.SNS();
      var message = {token: token}
      sns.publish({
          Message: JSON.stringify(message),
          TopicArn: process.env.SNS_AUTHREP_ARN
      }, function(err, data) {
          if (err) {
              console.log(err.stack);
              return;
          }
          console.log('push sent',data);
          context.succeed(generatePolicy('user', 'Allow', event.methodArn));
      });
     } else {
        console.log('Token does not exist in cache');
        auth(token).then(function(result){
          console.log("3scale response",result);

          var metrics = _.pluck(result.usage_reports,'metric')
          var cached_key = service_id+":"
          _.each(metrics,function(m){
            cached_key += "usage['"+m+"']=1&"
          })

          //sotre key and its usage in cache
          db.set(token,cached_key);

          context.succeed(generatePolicy('user', 'Allow', event.methodArn));
        }).catch(function(err){
          console.log("ERROR:",err);
          context.succeed(generatePolicy('user', 'Deny', event.methodArn));
        }).done(function(){
          context.done();
        })
     }
  })
}


//Function  to authenticate against 3scale platform
function auth(token){
  var options = { 'user_key': token, 'usage': { 'hits': 1 }, 'service_id': process.env.THREESCALE_SERVICE_ID};
  var q = Q.defer();
  client.authrep_with_user_key(options, function (res) {
    if (res.is_success()) {
      q.resolve(res);
    } else {
      q.reject(res);
    }
  });
  return q.promise;
}

//Function  to authenticate against 3scale platform
function oauth_authorize(app_id){
  var options = { 'service_token': process.env.THREESCALE_SERVICE_TOKEN, 'app_id': app_id, 'service_id': process.env.THREESCALE_SERVICE_ID};
  var q = Q.defer();
  client.oauth_authorize(options, function (res) {
    // console.log("oauth_authorize res", res)
    if (res.is_success()) {
      var trans = [{ service_token: process.env.THREESCALE_SERVICE_TOKEN, app_id: app_id, usage: {"hits": 1} }];
      client.report(process.env.THREESCALE_SERVICE_ID, trans, function (response) {
        console.log("RRR",response);
        q.resolve(response);
      });

    } else {
      q.reject(res);
    }
  });
  return q.promise;
}

//Create a AWS Policy document that will be evaluate by the API Gateway
var generatePolicy = function(principalId, effect, resource) {
    var authResponse = {};
    authResponse.principalId = principalId;
    if (effect && resource) {
        var policyDocument = {};
        policyDocument.Version = '2012-10-17'; // default version
        policyDocument.Statement = [];
        var statementOne = {};
        statementOne.Action = 'execute-api:Invoke'; // default action
        statementOne.Effect = effect;
        statementOne.Resource = resource;
        policyDocument.Statement[0] = statementOne;
        authResponse.policyDocument = policyDocument;
    }
    return authResponse;
}

Array.prototype.find = function(predicate) {
  if (this === null) {
    throw new TypeError('Array.prototype.find called on null or undefined');
  }
  if (typeof predicate !== 'function') {
    throw new TypeError('predicate must be a function');
  }
  var list = Object(this);
  var length = list.length >>> 0;
  var thisArg = arguments[1];
  var value;

  for (var i = 0; i < length; i++) {
    value = list[i];
    if (predicate.call(thisArg, value, i, list)) {
      return value;
    }
  }
  return undefined;
};
